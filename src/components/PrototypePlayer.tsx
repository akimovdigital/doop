import { stopActiveDictation } from '../lib/dictation'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { Frame } from '../../shared/types'
import { framePageId, pageFrames } from '../../shared/pages'
import type { Interaction, ProtoTransition } from '../../shared/prototype'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { posthog } from '../lib/posthog'
import { FRAME_BOOTSTRAP } from '../lib/frameRuntime'
import {
  fitScale,
  historyStep,
  protoHistoryState,
  protoShortcut,
  readProtoHistory,
  readProtoScaling,
  sanitizeInteraction,
  saveProtoScaling,
  screenLayout,
  transitionFrames,
  updateProtoTrail,
  type ProtoShortcut,
  type ProtoScaling,
  type ScreenLayout,
} from '../lib/prototypePlayer'
import { prototypePath } from '../lib/prototype'
import { PreviewToolbar } from './PreviewToolbar'
import { DesignModeControls, DesignModeHint, DesignModeOverlay } from './DesignModeOverlay'
import { useDesignMode } from './useDesignMode'
import { PreviewChatCapsule, usePreviewChat } from './PreviewChatCapsule'
import { useAllowance } from './TeamAllowance'
import { t as translate, useT } from '@/lib/i18n'

/* One screen on the player's history stack: the frame it shows and how it
   arrived, so Back can play that transition in reverse. The key is unique per
   visit — going back mounts a fresh document, as a reload of that page would.
   The depth is the screen's position in the flow (0 for the start), which the
   browser history entries carry too, so a popstate knows where it landed even
   when a screen repeats. */
interface Entry {
  key: number
  frameId: string
  transition: ProtoTransition
  duration: number
  depth: number
}

/* a navigation in flight: both screens are mounted until it settles */
interface Move {
  from: Entry
  to: Entry
  transition: ProtoTransition
  duration: number
  back: boolean
  ready: boolean
}

const EASING = 'cubic-bezier(0.2, 0.7, 0.2, 1)'
/* a hair of the frame's own canvas around an overlay, so its edge reads */
const OVERLAY_FIT = 0.94

/**
 * The prototype player: the frame fills the viewport (letterboxed, scaled to
 * fit) and its interactions run. Each frame's runtime reports triggers as
 * `doop:proto-action`; the player keeps the history stack, the overlays and
 * the transitions, which animate two stacked iframes. Frames stay live: an
 * edit streaming into one re-renders here as it does on the canvas.
 *
 * `onClose` set: presenting over the editor — Esc (with nothing else to
 * close) exits. `syncUrl`: the full-page route — each navigation is a browser
 * history entry, so the browser's Back and Forward walk the flow.
 */
export function PrototypePlayer({
  startFrameId,
  onClose,
  onOpenChat,
  syncUrl = false,
  initialInteraction,
}: {
  startFrameId: string
  onClose?: () => void
  onOpenChat?: () => void
  syncUrl?: boolean
  initialInteraction?: Interaction
}) {
  const canvas = useStore((s) => s.canvas)
  const frames = canvas?.frames
  const canvasId = canvas?.id
  const canEdit = useStore(canEditOpenCanvas)
  const frameById = useCallback((id: string) => frames?.find((f) => f.id === id), [frames])
  const t = useT()

  /* one play of the prototype: Present on the canvas, or its own page */
  useEffect(() => {
    posthog.capture('prototype_played', { via: syncUrl ? 'prototype_page' : 'present' })
  }, [syncUrl])

  const seq = useRef(0)
  const nextKey = () => ++seq.current
  const [trail, setTrailState] = useState(() => ({ stack: [entryFor(startFrameId, 0)], forward: [] as Entry[] }))
  const { stack, forward: ahead } = trail
  const [overlays, setOverlaysState] = useState<Entry[]>([])
  const [move, setMoveState] = useState<Move | null>(null)
  const [readyOverlays, setReadyOverlays] = useState<ReadonlySet<number>>(() => new Set())
  const [notice, setNotice] = useState<string | null>(null)
  /* the handlers below run from message listeners: they read the latest
     state through these refs, written together with the state */
  const trailRef = useRef(trail)
  const overlaysRef = useRef(overlays)
  const moveRef = useRef(move)
  const setTrail = (next: typeof trail) => {
    if (next.stack.at(-1)?.key !== trailRef.current.stack.at(-1)?.key) design.clearInteraction()
    trailRef.current = next
    setTrailState(next)
  }
  /* closing an overlay that holds the focus drops it on the page: the
     screen it uncovers takes it back (see ProtoScreen) */
  const focusHandoff = useRef(false)
  const setOverlays = (next: Entry[]) => {
    if (next.at(-1)?.key !== overlaysRef.current.at(-1)?.key) design.clearInteraction()
    if (next.length < overlaysRef.current.length && screenHasFocus()) focusHandoff.current = true
    overlaysRef.current = next
    setOverlaysState(next)
  }
  const setMove = (next: Move | null) => {
    moveRef.current = next
    setMoveState(next)
  }
  const running = useRef<Animation[]>([])
  const wrappers = useRef(new Map<number, HTMLDivElement>())
  const windows = useRef(new Map<number, Window>())
  /* what letting go of a press undoes: the overlay or the navigation it
     opened, by the key of the entry it made — once the flow has moved past
     that entry there is nothing left to undo */
  const pressRevert = useRef<{ action: 'overlay' | 'navigate'; key: number } | null>(null)
  const noticeTimer = useRef<number | null>(null)

  const [minimized, setMinimized] = useState(false)
  const addressRef = useRef<HTMLInputElement>(null)
  /* Measure the part available to the site, including during window resizing. */
  const viewportRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useLayoutEffect(() => {
    const root = viewportRef.current
    if (!root) return
    const measure = () => setViewport({ w: root.clientWidth, h: root.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  const [scaling, setScalingState] = useState(readProtoScaling)
  const setScaling = (next: ProtoScaling) => {
    saveProtoScaling(next)
    setScalingState(next)
  }

  const [documentRevision, documentChanged] = useState(0)
  const annotationScreen = overlays.at(-1) ?? move?.to ?? stack.at(-1)!
  const getAnnotationWindow = useCallback(() => windows.current.get(annotationScreen.key), [annotationScreen.key])
  const chat = usePreviewChat(canvasId, canEdit)
  const { allowance } = useAllowance(chat.allowed)
  const design = useDesignMode({
    allowance,
    canvasId,
    canEdit,
    frame: frameById(annotationScreen.frameId),
    screenKey: annotationScreen.key,
    documentRevision,
    pageUrl: new URL(prototypePath(canvasId ?? '', annotationScreen.frameId), location.origin).href,
    components: canvas?.components,
    getWindow: getAnnotationWindow,
    onNavigate: (frameId) => navigate(frameId, 'instant', 0),
    onDraft: chat.expand,
    onEnter: chat.collapse,
  })

  function openEditorChat() {
    onClose?.()
    onOpenChat?.()
  }

  function entryFor(
    frameId: string,
    key: number,
    transition: ProtoTransition = 'instant',
    duration = 0,
    depth = 0,
  ): Entry {
    return { key, frameId, transition, duration, depth }
  }

  function flash(message: string) {
    setNotice(message)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2400)
  }

  /* a navigation that starts while another animates snaps that one to its end */
  function settle() {
    const anims = running.current
    running.current = []
    for (const a of anims) a.cancel()
    if (moveRef.current) setMove(null)
  }

  function navigate(frameId: string, transition: ProtoTransition, duration: number) {
    if (!frameById(frameId)) return flash(translate('panels.protoScreenGone'))
    settle()
    const current = trailRef.current.stack
    const from = current.at(-1)!
    const to = entryFor(frameId, nextKey(), transition, duration, from.depth + 1)
    setOverlays([])
    setTrail(updateProtoTrail(trailRef.current, to, 'push'))
    setMove({ from, to, transition, duration, back: false, ready: false })
    if (syncUrl) history.pushState(protoHistoryState(frameId, to.depth), '', prototypeUrl(frameId))
  }

  /* Browser Forward and multi-entry jumps use the same trail as the toolbar. */
  function jumpTo(frameId: string, depth: number) {
    if (!frameById(frameId)) return flash(translate('panels.protoScreenGone'))
    settle()
    const { stack, forward } = trailRef.current
    const known = [...stack, ...forward].find((entry) => entry.depth === depth && entry.frameId === frameId)
    const to = known ? { ...known, key: nextKey() } : entryFor(frameId, nextKey(), 'instant', 0, depth)
    if (screenHasFocus()) focusHandoff.current = true
    setOverlays([])
    setTrail(updateProtoTrail(trailRef.current, to, 'traverse'))
  }

  function prototypeUrl(frameId: string) {
    return canvasId ? prototypePath(canvasId, frameId) : location.pathname
  }

  /* Back pops one screen; with the browser's history in play the popstate
     handler does it, so both stay in step */
  function back(fromHistory = false) {
    /* overlays are not history entries: the browser's Back leaves the screen */
    if (!fromHistory && overlaysRef.current.length) return closeOverlay()
    const current = trailRef.current.stack
    if (current.length < 2) return
    if (syncUrl && !fromHistory) return history.back()
    settle()
    const from = current.at(-1)!
    const prev = current.at(-2)!
    if (!frameById(prev.frameId)) return flash(translate('panels.protoScreenGone'))
    const to = { ...prev, key: nextKey() }
    setOverlays([])
    setTrail(updateProtoTrail(trailRef.current, to, 'traverse'))
    setMove({ from, to, transition: from.transition, duration: from.duration, back: true, ready: false })
  }

  function forward() {
    const next = trailRef.current.forward[0]
    if (!next) return
    if (syncUrl) return history.forward()
    jumpTo(next.frameId, next.depth)
  }

  function reload() {
    settle()
    const current = trailRef.current.stack.at(-1)!
    if (screenHasFocus()) focusHandoff.current = true
    setOverlays([])
    setTrail(updateProtoTrail(trailRef.current, { ...current, key: nextKey() }, 'replace'))
  }

  function focusAddress() {
    addressRef.current?.focus()
    addressRef.current?.select()
  }

  function shortcut(command: ProtoShortcut) {
    switch (command) {
      case 'back':
        return back()
      case 'forward':
        return forward()
      case 'reload':
        return reload()
      case 'annotate':
        return design.toggle()
      case 'chat':
        return chat.expand()
      case 'address':
        if (chat.allowed && !design.enabled && document.activeElement !== addressRef.current) return chat.expand()
        if (design.enabled) {
          design.exit()
          window.requestAnimationFrame(focusAddress)
          return
        }
        return focusAddress()
    }
  }

  function openOverlay(frameId: string, transition: ProtoTransition, duration: number) {
    if (!frameById(frameId)) return flash(translate('panels.protoOverlayGone'))
    setOverlays([...overlaysRef.current, entryFor(frameId, nextKey(), transition, duration)])
  }

  function closeOverlay() {
    setOverlays(overlaysRef.current.slice(0, -1))
  }

  /* the start again, in place of the current browser entry (at its depth, so
     the entries behind it still read as earlier screens) */
  function restart() {
    settle()
    const depth = syncUrl ? (trailRef.current.stack.at(-1)?.depth ?? 0) : 0
    setOverlays([])
    setTrail({
      stack: [entryFor(startFrameId, nextKey(), 'instant', 0, depth)],
      forward: syncUrl ? trailRef.current.forward : [],
    })
    if (syncUrl) history.replaceState(protoHistoryState(startFrameId, depth), '', prototypeUrl(startFrameId))
  }

  function run(raw: unknown, press: boolean) {
    const interaction = sanitizeInteraction(raw)
    if (!interaction) return
    /* any other interaction leaves a held press pending: release checks the
       entry it opened is still on top, so it cannot undo a different screen */
    perform(interaction)
    if (!press || (interaction.action !== 'overlay' && interaction.action !== 'navigate')) return
    const opened = interaction.action === 'overlay' ? overlaysRef.current.at(-1) : trailRef.current.stack.at(-1)
    if (opened) pressRevert.current = { action: interaction.action, key: opened.key }
  }

  function perform(i: Interaction) {
    switch (i.action) {
      case 'navigate':
        return navigate(i.target!, i.transition, i.duration)
      case 'overlay':
        return openOverlay(i.target!, i.transition, i.duration)
      case 'back':
        return back()
      case 'close-overlay':
        return closeOverlay()
      case 'url':
        window.open(i.target, '_blank', 'noopener,noreferrer')
        return
      case 'scroll-to':
        return // the frame scrolls itself
    }
  }

  // The canvas can hand off a navigation or overlay to the same player
  // used by Present, with the original source screen in the history.
  const handoff = useRef(initialInteraction)
  const performHandoff = useRef(perform)
  performHandoff.current = perform
  useEffect(() => {
    const interaction = handoff.current
    if (!interaction) return
    handoff.current = undefined
    performHandoff.current(interaction)
  }, [])

  function release() {
    const revert = pressRevert.current
    pressRevert.current = null
    if (revert?.action === 'overlay' && overlaysRef.current.at(-1)?.key === revert.key) closeOverlay()
    else if (
      revert?.action === 'navigate' &&
      !overlaysRef.current.length &&
      trailRef.current.stack.at(-1)?.key === revert.key
    )
      back()
  }

  /* Escape: an open overlay closes first; then the screen's own key:Escape
     interaction; then, over the editor, the player itself */
  function escape() {
    if (stopActiveDictation() || design.escape() || chat.escape()) return
    if (overlaysRef.current.length) return closeOverlay()
    const win = topWindow()
    if (!win) return onClose?.()
    askKey(win, 'Escape')
      .then((handled) => !handled && onClose?.())
      .catch(console.error)
  }

  /* the one screen that takes input: the top overlay, else the screen shown */
  function topEntry(): Entry | undefined {
    return overlaysRef.current.at(-1) ?? moveRef.current?.to ?? trailRef.current.stack.at(-1)
  }

  function topWindow(): Window | undefined {
    const top = topEntry()
    return top ? windows.current.get(top.key) : undefined
  }

  function onScreenReady(key: number) {
    const m = moveRef.current
    if (!m || m.to.key !== key) return
    if (m.transition === 'instant' || m.duration === 0) return setMove(null)
    const next = { ...m, ready: true }
    setMove(next)
    const { incoming, outgoing } = transitionFrames(m.transition, m.back)
    const options: KeyframeAnimationOptions = { duration: m.duration, easing: EASING, fill: 'both' }
    const anims = [
      incoming.length ? wrappers.current.get(m.to.key)?.animate(incoming, options) : undefined,
      outgoing.length ? wrappers.current.get(m.from.key)?.animate(outgoing, options) : undefined,
    ].filter((a): a is Animation => !!a)
    running.current = anims
    Promise.all(anims.map((a) => a.finished))
      .then(() => {
        if (moveRef.current !== next) return
        running.current = []
        setMove(null)
        documentChanged((value) => value + 1)
      })
      .catch(() => {
        /* cancelled by a newer navigation, which owns the screens now */
      })
  }

  function onOverlayReady(entry: Entry) {
    setReadyOverlays((ready) => new Set(ready).add(entry.key))
    const { incoming } = transitionFrames(entry.transition, false)
    if (incoming.length)
      wrappers.current.get(entry.key)?.animate(incoming, { duration: entry.duration, easing: EASING, fill: 'both' })
  }

  /* the latest handlers for the listeners below, which subscribe once */
  const handlers = useRef({ escape, back, jumpTo, release, topWindow, shortcut, design, chat })
  useLayoutEffect(() => {
    handlers.current = { escape, back, jumpTo, release, topWindow, shortcut, design, chat }
  })

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      /* the scaling menu and its button take their own keys (arrows, Enter,
         Escape in the menu) and stop them short of the editor themselves;
         Escape on the button still leaves the player */
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('[data-proto-menu],[data-slot=modal]')) return
      if (handlers.current.design.handleKey(e, target)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      const inDesignControl = target?.closest(
        '[data-design-card],[data-design-queue],[data-design-hint],[data-design-pin]',
      )
      const command = protoShortcut(e)
      if (command === 'annotate' && !handlers.current.design.allowed) return
      if (command === 'chat' && !handlers.current.chat.allowed) return
      if (target === addressRef.current && command !== 'address' && command !== 'annotate' && command !== 'chat') return
      if (target?.closest('[data-preview-chat]') && e.key !== 'Escape' && !command) return
      if (inDesignControl && e.key !== 'Escape' && command !== 'annotate') {
        if (target?.closest('[data-design-note-field],[data-design-css-inspector]')) return
        if (command !== 'address' && command !== 'chat') return
      }
      if (command) {
        e.preventDefault()
        e.stopPropagation()
        if (!e.repeat) handlers.current.shortcut(command)
        return
      }
      if (target?.closest('[data-preview-toolbar]') && e.key !== 'Escape') return
      /* capture phase, and modal: no key reaches the editor underneath (an
         arrow would nudge the selected frame, Delete would remove it) */
      e.stopPropagation()
      if (e.key === 'Escape') {
        if (handlers.current.design.enabled || handlers.current.design.queueOpen) e.preventDefault()
        return handlers.current.escape()
      }
      if (handlers.current.design.enabled || e.repeat || e.metaKey || e.ctrlKey) return
      const win = handlers.current.topWindow()
      win?.postMessage({ type: 'doop:proto-key', key: e.key, reqId: `key-${e.timeStamp}` }, '*')
    }
    const onUp = () => handlers.current.release()
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space' && handlers.current.design.usingPage) handlers.current.design.releasePage()
    }
    const onBlur = () => {
      if (handlers.current.design.usingPage && !document.hasFocus()) handlers.current.design.releasePage()
    }
    const onVisibilityChange = () => {
      if (document.hidden) handlers.current.design.releasePage()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])
  useEffect(() => {
    if (!syncUrl) return
    /* the entry the player opened on records its start screen, so Back to it
       restores the start even when its URL names no frame (?page=, or none) */
    const start = trailRef.current.stack[0]!
    history.replaceState({ ...readState(), ...protoHistoryState(start.frameId, start.depth) }, '', location.href)
    function onPop(e: PopStateEvent) {
      const target = readProtoHistory(e.state)
      if (!target) return
      const step = historyStep(trailRef.current.stack, target)
      if (step === 'back') handlers.current.back(true)
      else if (step === 'jump') handlers.current.jumpTo(target.frameId, target.depth)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [syncUrl])

  useEffect(
    () => () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    },
    [],
  )

  function flashHotspots() {
    for (const win of windows.current.values()) win.postMessage({ type: 'doop:proto-hotspots' }, '*')
  }

  const pageInteractive = !design.enabled || design.usingPage
  const current = stack.at(-1)!
  const base: { entry: Entry; role: 'from' | 'to' | 'still' }[] = move
    ? [
        { entry: move.from, role: 'from' },
        { entry: move.to, role: 'to' },
      ]
    : [{ entry: current, role: 'still' }]
  const outgoingOnTop = move ? transitionFrames(move.transition, move.back).outgoingOnTop : false
  const shownFrame = frameById((move?.to ?? current).frameId)
  const baseFrame = frameById(current.frameId)
  const searchFrame = baseFrame ?? frameById(startFrameId)
  const searchFrames = canvas && searchFrame ? pageFrames(canvas, framePageId(canvas, searchFrame)) : []
  const baseScale = baseFrame ? screenLayout(baseFrame, viewport, scaling).scale : 1
  /* a screen larger than the player scrolls from its top-left corner, except
     under Fill, which crops it around its centre (clipped, so nothing
     can scroll it, not even focus) */
  const screenPlacement =
    scaling === 'fill' || scaling === 'fit'
      ? 'place-content-center overflow-clip'
      : `place-items-center-safe overflow-auto ${scaling === 'actual' ? '[scrollbar-width:none]' : ''}`

  const screenProps = (entry: Entry) => ({
    entry,
    frame: frameById(entry.frameId),
    takeFocus: () => {
      const handoff = focusHandoff.current
      focusHandoff.current = false
      return handoff
    },
    register: (key: number, win: Window | null) => {
      if (win) windows.current.set(key, win)
      else windows.current.delete(key)
    },
    annotating: !pageInteractive && !design.editingText,
    onDocument: () => {
      if (topEntry()?.key === entry.key) documentChanged((value) => value + 1)
    },
    onMessage: (data: {
      type?: string
      interaction?: unknown
      press?: boolean
      command?: unknown
      id?: unknown
      mode?: unknown
      hit?: unknown
      before?: unknown
      after?: unknown
      scrollX?: unknown
      scrollY?: unknown
    }) => {
      /* a covered screen is switched off, but an action it sent before the
         switch reached it must not act over the screen on top */
      if (data.type === 'doop:proto-action') {
        if (pageInteractive && topEntry()?.key === entry.key) run(data.interaction, !!data.press)
      } else if (data.type === 'doop:proto-release') release()
      else if (data.type === 'doop:proto-space-up' && design.usingPage) design.releasePage()
      else if (data.type === 'doop:proto-blur' && design.usingPage && !document.hasFocus()) design.releasePage()
      else if (data.type === 'doop:proto-shortcut' && topEntry()?.key === entry.key && screenHasFocus()) {
        const command = data.command
        if (
          command === 'back' ||
          command === 'forward' ||
          command === 'reload' ||
          command === 'address' ||
          command === 'annotate' ||
          command === 'chat'
        )
          shortcut(command)
      }
      /* Escape with the focus in a screen: the same overlay-first path as a
         key pressed on the player itself */
      else if (data.type === 'doop:esc' && topEntry()?.key === entry.key && screenHasFocus()) escape()
      else if (data.type === 'doop:proto-site-pointer' && topEntry()?.key === entry.key) {
        design.setQueueOpen(false)
        chat.collapse()
      } else if (data.type === 'doop:textEdit-finished' && topEntry()?.key === entry.key) design.finishTextEdit(data)
      else if (data.type === 'doop:annotation-layout' && topEntry()?.key === entry.key)
        design.refreshPins(data.scrollX, data.scrollY)
    },
  })

  return (
    <div
      /* below the shell's tab strip, by the --app-inset contract (App.tsx) */
      className="fixed inset-x-0 bottom-0 top-[var(--app-inset,0px)] z-[80] grid place-items-center"
      data-minimized={minimized || undefined}
      role="dialog"
      aria-label={t('panels.protoAria', { name: shownFrame?.name ?? t('panels.protoMissingLower') })}
      data-prototype-player=""
    >
      <div
        data-proto-backdrop=""
        className={`absolute inset-0 transition-colors duration-150 ease-out motion-reduce:transition-none ${minimized ? 'bg-black/60' : ''}`}
      />
      <div
        className={`relative flex min-h-0 min-w-0 flex-col bg-code transition-[width,height,border-radius] duration-150 ease-out motion-reduce:transition-none ${
          minimized ? 'h-4/5 w-[max(80%,min(100%,300px))] rounded-panel border border-line shadow-pop' : 'size-full'
        }`}
        data-proto-window=""
      >
        <PreviewToolbar
          annotationHint={design.enabled ? <DesignModeHint mode={design} /> : undefined}
          annotationControls={design.allowed && <DesignModeControls mode={design} />}
          addressRef={addressRef}
          canvasId={canvasId}
          frameId={current.frameId}
          frameName={shownFrame?.name}
          frames={frames ?? []}
          searchFrames={searchFrames}
          canBack={stack.length >= 2 || !!overlays.length}
          canForward={!!ahead.length}
          onBack={() => back()}
          onForward={forward}
          onReload={reload}
          onNavigate={(id) => navigate(id, 'instant', 0)}
          onRestart={restart}
          onHotspots={flashHotspots}
          onDesignMode={design.allowed ? design.toggle : undefined}
          designModeOn={design.enabled}
          scaling={scaling}
          onScalingChange={setScaling}
          onMenuClose={(event) => {
            const screen = interactiveScreen()
            if (!screen) return
            event.preventDefault()
            screen.focus()
          }}
          minimized={minimized}
          onToggleWindow={onClose && (() => setMinimized((value) => !value))}
          onClose={onClose}
        />
        <div
          ref={viewportRef}
          /* Only the screen wrapper can scroll. Focus moving out of a note
             must not scroll the preview and its overlays as a single layer. */
          className={`relative isolate min-h-0 flex-1 overflow-clip ${minimized ? 'rounded-b-panel' : ''}`}
          data-proto-viewport=""
          onPointerDownCapture={(event) => {
            if (event.target instanceof Element && !event.target.closest('[data-preview-chat],[data-design-queue]'))
              chat.collapse()
          }}
        >
          {base.map(({ entry, role }) => {
            const frame = frameById(entry.frameId)
            return (
              <div
                key={entry.key}
                ref={(el) => {
                  if (el) wrappers.current.set(entry.key, el)
                  else wrappers.current.delete(entry.key)
                }}
                className={`absolute inset-0 grid ${screenPlacement}`}
                data-proto-entry={entry.key}
                data-proto-screen={entry.frameId}
                data-proto-role={role}
                style={{
                  zIndex: role === 'from' ? (outgoingOnTop ? 2 : 1) : role === 'to' ? (outgoingOnTop ? 1 : 2) : 1,
                  /* the incoming screen stays hidden until its document has rendered */
                  visibility: role === 'to' && !move?.ready ? 'hidden' : undefined,
                }}
              >
                <ProtoScreen
                  {...screenProps(entry)}
                  layout={frame ? screenLayout(frame, viewport, scaling) : undefined}
                  interactive={pageInteractive && role !== 'from' && !overlays.length}
                  onReady={onScreenReady}
                />
              </div>
            )
          })}

          {overlays.map((entry, index) => {
            const frame = frameById(entry.frameId)
            const scale = frame
              ? Math.min(baseScale, fitScale(frame, { w: viewport.w * OVERLAY_FIT, h: viewport.h * OVERLAY_FIT }))
              : 1
            return (
              <div key={entry.key} className="absolute inset-0 z-[5] grid place-items-center">
                <div className="absolute inset-0 bg-black/45" data-proto-scrim="" onClick={closeOverlay} />
                <div
                  ref={(el) => {
                    if (el) wrappers.current.set(entry.key, el)
                    else wrappers.current.delete(entry.key)
                  }}
                  className="relative shadow-pop"
                  data-proto-entry={entry.key}
                  data-proto-overlay={entry.frameId}
                  style={{ opacity: readyOverlays.has(entry.key) ? 1 : 0 }}
                >
                  <ProtoScreen
                    {...screenProps(entry)}
                    layout={frame ? { width: frame.width, height: frame.height, scale } : undefined}
                    interactive={pageInteractive && index === overlays.length - 1}
                    onReady={() => onOverlayReady(entry)}
                  />
                </div>
              </div>
            )
          })}
          {scaling === 'actual' && !overlays.length && !move && (
            <PreviewScrollbar key={current.key} entry={current.key} />
          )}
          <DesignModeOverlay
            mode={design}
            screen={annotationScreen.key}
            revision={documentRevision}
            viewportRef={viewportRef}
            getWindow={getAnnotationWindow}
          />
          {chat.allowed && canvasId && (
            <PreviewChatCapsule
              chat={chat}
              canvasId={canvasId}
              pending={design.pendingCount}
              allowance={allowance}
              onShowQueue={() => design.setQueueOpen(true)}
              onOpenChat={onOpenChat ? openEditorChat : undefined}
            />
          )}
        </div>
      </div>
      {notice && (
        <div className="absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-pill bg-black/70 px-3 py-1.5 text-body text-code-ink">
          {notice}
        </div>
      )}
    </div>
  )
}

/** An overlay on the actual-size viewport, so the site's box can reach
 * the right edge even on systems configured to always show scrollbars. */
function PreviewScrollbar({ entry }: { entry: number }) {
  const scroller = useRef<HTMLElement | null>(null)
  const thumb = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; top: number; ratio: number }>()
  useLayoutEffect(() => {
    const handle = thumb.current
    const element = handle
      ?.closest('[data-proto-viewport]')
      ?.querySelector<HTMLElement>(`[data-proto-entry="${entry}"]`)
    if (!element || !handle) return
    scroller.current = element
    function update() {
      if (!element || !handle) return
      const { clientHeight, scrollHeight, scrollTop } = element
      const travel = scrollHeight - clientHeight
      const size = Math.max(20, (clientHeight * clientHeight) / scrollHeight)
      handle.hidden = travel <= 0
      handle.style.height = `${size}px`
      handle.style.transform = `translateY(${travel > 0 ? (scrollTop / travel) * (clientHeight - size) : 0}px)`
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    element.addEventListener('scroll', update, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', update)
      scroller.current = null
    }
  }, [entry])
  return (
    <div
      ref={thumb}
      data-proto-scrollbar=""
      aria-hidden="true"
      className="absolute top-0 right-0.5 z-[8] w-1.5 touch-none rounded-full bg-neutral-500/70 hover:bg-neutral-400"
      onPointerDown={(event) => {
        const element = scroller.current
        if (event.button !== 0 || !element) return
        const space = element.clientHeight - event.currentTarget.offsetHeight
        if (space <= 0) return
        drag.current = {
          y: event.clientY,
          top: element.scrollTop,
          ratio: (element.scrollHeight - element.clientHeight) / space,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!drag.current || !scroller.current) return
        scroller.current.scrollTop = drag.current.top + (event.clientY - drag.current.y) * drag.current.ratio
      }}
      onLostPointerCapture={() => (drag.current = undefined)}
    />
  )
}

function readState(): Record<string, unknown> {
  const state: unknown = history.state
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : {}
}
/** The screen whose turn it is to take the keys: the topmost overlay, else
 *  the base screen that is not on its way out. */
function interactiveScreen(): HTMLIFrameElement | null {
  const overlays = document.querySelectorAll<HTMLIFrameElement>('[data-prototype-player] [data-proto-overlay] iframe')
  return (
    overlays[overlays.length - 1] ??
    document.querySelector<HTMLIFrameElement>(
      '[data-prototype-player] [data-proto-screen]:not([data-proto-role="from"]) iframe',
    )
  )
}

/** Whether one of the player's screens holds the keyboard focus. */
function screenHasFocus(): boolean {
  const focused = document.activeElement
  return focused instanceof HTMLIFrameElement && !!focused.closest('[data-prototype-player]')
}

const KEY_REPLY_MS = 400
let keyRequests = 0

/** Offer a key to the screen's own key interactions; true when one took it. */
let switchRequests = 0

function askKey(win: Window, key: string): Promise<boolean> {
  const reqId = `proto-key-${++keyRequests}`
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => done(false), KEY_REPLY_MS)
    function onMsg(ev: MessageEvent) {
      const data = ev.data as { type?: string; reqId?: string; handled?: boolean } | null
      if (ev.source === win && data?.type === 'doop:proto-key-result' && data.reqId === reqId) done(!!data.handled)
    }
    function done(handled: boolean) {
      window.clearTimeout(timer)
      window.removeEventListener('message', onMsg)
      resolve(handled)
    }
    window.addEventListener('message', onMsg)
    win.postMessage({ type: 'doop:proto-key', key, reqId }, '*')
  })
}

/** One frame's document inside the player: boots the runtime, renders the
 *  frame's live HTML, then switches its prototype triggers on. */
function ProtoScreen({
  entry,
  frame,
  layout,
  interactive,
  annotating,
  takeFocus,
  register,
  onReady,
  onDocument,
  onMessage,
}: {
  entry: Entry
  frame: Frame | undefined
  /** the document's size and draw scale; undefined while the frame is gone */
  layout: ScreenLayout | undefined
  interactive: boolean
  annotating: boolean
  /** true once when the overlay closed over this screen held the focus */
  takeFocus: () => boolean
  register: (key: number, win: Window | null) => void
  onReady: (key: number) => void
  onDocument: () => void
  onMessage: (data: { type?: string; interaction?: unknown; press?: boolean; command?: unknown }) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [booted, setBooted] = useState(false)
  const [shown, setShown] = useState(false)
  const latest = useRef({ onReady, onDocument, onMessage, register, takeFocus })
  const t = useT()
  useLayoutEffect(() => {
    latest.current = { onReady, onDocument, onMessage, register, takeFocus }
  })

  /* the `doop:proto` switch this screen is waiting on, when its reply is
     also the moment the screen should take the focus */
  const focusOnSwitch = useRef<string | null>(null)
  useEffect(() => {
    const key = entry.key
    let first = true
    function onMsg(ev: MessageEvent) {
      const win = iframeRef.current?.contentWindow
      if (!win || ev.source !== win) return
      const data = ev.data as { type?: string; reqId?: string } | null
      if (!data?.type) return
      if (data.type === 'doop:frame-ready') {
        latest.current.register(key, win)
        setBooted(true)
      } else if (data.type === 'doop:html-result') {
        latest.current.onDocument()
        if (!first) return
        first = false
        setShown(true)
        latest.current.onReady(key)
      } else if (data.type === 'doop:proto-result') {
        if (data.reqId === focusOnSwitch.current) {
          focusOnSwitch.current = null
          iframeRef.current?.focus()
        }
      } else latest.current.onMessage(data)
    }
    window.addEventListener('message', onMsg)
    return () => {
      window.removeEventListener('message', onMsg)
      latest.current.register(key, null)
    }
  }, [entry.key])

  const html = frame?.html ?? ''
  useEffect(() => {
    if (booted) iframeRef.current?.contentWindow?.postMessage({ type: 'doop:html', html, reqId: 'proto' }, '*')
  }, [booted, html])

  useEffect(() => {
    const iframe = iframeRef.current
    if (!shown || !iframe) return
    const reqId = `proto-switch-${++switchRequests}`
    /* keys go to the focused document: take the focus over from the screen
       this one now covers, or back from the overlay that closed over it, so
       its key interactions and controls answer instead of that screen's.
       The focus moves on the runtime's reply, not now: the switch travels
       as a message, and a key pressed into a focused screen whose runtime
       had not yet heard it was dropped. */
    const focused = document.activeElement
    const takesFocus = interactive && ((screenHasFocus() && focused !== iframe) || latest.current.takeFocus())
    focusOnSwitch.current = takesFocus ? reqId : null
    iframe.contentWindow?.postMessage({ type: 'doop:proto', on: interactive, reqId }, '*')
  }, [shown, interactive])

  if (!frame || !layout) return <div className="text-body text-code-ink/70">{t('panels.protoDeleted')}</div>

  const { width, height, scale } = layout
  const box: CSSProperties = { width: Math.round(width * scale), height: Math.round(height * scale) }
  return (
    <div className="relative overflow-hidden bg-white" style={{ ...box, visibility: shown ? undefined : 'hidden' }}>
      <iframe
        ref={iframeRef}
        tabIndex={annotating ? -1 : undefined}
        className="block border-none bg-white"
        title={frame.name}
        data-doop-proto-frame={frame.id}
        sandbox="allow-scripts"
        srcDoc={FRAME_BOOTSTRAP}
        style={{
          width,
          height,
          transform: `scale(${scale})`,
          transformOrigin: '0 0',
          pointerEvents: annotating ? 'none' : undefined,
        }}
      />
    </div>
  )
}
