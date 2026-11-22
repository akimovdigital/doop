import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { api } from '../lib/api'
import { posthog } from '../lib/posthog'
import { navigate } from '../App'
import { CodeTabIcon, HomeIcon, PlusIcon, XIcon } from './ui/icons'
import { Tooltip } from './ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu'
import { MenuHint } from './ui/menu'
import { Input } from './ui/input'
import { cn } from '@/lib/utils'
import {
  COPY_TAB_LINK_SHORTCUT,
  TAB_SHORTCUTS,
  canvasTabTarget,
  closeAllTabs,
  closeCanvasSplit,
  closeOtherTabs,
  closeTab,
  copyCanvasTabLink,
  ensureTab,
  moveCanvasTabToWindow,
  moveTab,
  openCanvasSplit,
  openCanvasTab,
  openExternal,
  renameCanvasTab,
  setCanvasTabPinned,
  supportsCanvasWindows,
  tabMoveRange,
  useTabs,
  type CanvasTab,
} from '../lib/desktop'
import { chordHint } from '../lib/actions/chords'
import { hasInsetTrafficLights, isDesktopShell, supportsCanvasTabs } from '../lib/shell'
import { useWindowFrame } from '../lib/windowFrame'
import { WindowControls } from './WindowControls'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { useT } from '../lib/i18n'

const stripButton =
  'mx-0.5 grid size-[30px] flex-none place-items-center self-center rounded-[6px] text-ink-soft hover:bg-sub hover:text-ink focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
const tabMenu = 'z-[850] min-w-[220px] rounded-[12px] border border-line bg-surface'

/** OpenCode's busy mark: a 5×5 pixel grid. Brightness sweeps on the diagonal,
 *  top-left toward bottom-right, one step per row+column. */
function TabAgentGrid() {
  return (
    <span data-tab-agent-grid aria-hidden>
      {Array.from({ length: 25 }, (_, i) => (
        <i key={i} style={{ animationDelay: `${(Math.floor(i / 5) + (i % 5)) * 90}ms` }} />
      ))}
    </span>
  )
}

/** Idle: the prompt glyph. Busy: the OpenCode grid, and only for the open
 *  canvas — tasks and presence in the store belong to that canvas. */
function TabCodeMark({ canvasId, selected }: { canvasId: string; selected: boolean }) {
  const working = useStore(
    (s) =>
      s.canvas?.id === canvasId &&
      (s.tasks.some((task) => task.agentName && !task.endedAt && !task.failedAt) ||
        Object.values(s.presences).some((peer) => peer.kind === 'agent' && !!peer.status)),
  )
  if (working) return <TabAgentGrid />
  return <CodeTabIcon size="rail" className={cn('shrink-0', selected && 'text-brand')} />
}

function openTabMenu(tab: HTMLElement) {
  const { left, bottom } = tab.getBoundingClientRect()
  tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: left, clientY: bottom }))
}

/** The strip itself doubles as the drag handle. Tauri only honours
 *  data-tauri-drag-region on the exact element carrying the attribute. */
export function DesktopTabs({ path }: { path: string }) {
  const t = useT()
  const tabs = useTabs((s) => s.tabs)
  const split = useTabs((s) => s.split)
  const activeId = path.match(/^\/c\/([^/]+)/)?.[1] ?? null
  const readOnlyId = useStore((s) => (s.canvas && !canEditOpenCanvas(s) ? s.canvas.id : null))
  const strip = useRef<HTMLDivElement>(null)
  const cancelDrag = useRef<(() => void) | null>(null)
  const [renaming, setRenaming] = useState<CanvasTab | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /* Deep links and back/forward can land on a canvas the strip never opened. */
  useEffect(() => {
    if (activeId) ensureTab(activeId)
  }, [activeId])

  useEffect(() => {
    const list = strip.current
    const selected = list?.querySelector('[aria-selected="true"]')
    if (!list || !selected) return
    const reveal = () => {
      const visible = list.getBoundingClientRect()
      const rect = selected.getBoundingClientRect()
      if (rect.left < visible.left) list.scrollLeft += rect.left - visible.left
      else if (rect.right > visible.right) list.scrollLeft += rect.right - visible.right
    }
    reveal()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(reveal)
    observer.observe(list)
    return () => observer.disconnect()
  }, [activeId, tabs])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 3500)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => () => cancelDrag.current?.(), [])

  if (!supportsCanvasTabs()) return null
  const desktop = isDesktopShell()

  async function newCanvas() {
    const canvas = await api.createCanvas('Untitled canvas')
    posthog.capture('canvas_created')
    openCanvasTab(canvas.id, canvas.name)
  }

  function moveTabFocus(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target
    if (!(target instanceof HTMLButtonElement) || target.getAttribute('role') !== 'tab') return
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      openTabMenu(target)
      return
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
    const current = buttons.indexOf(target)
    if (current < 0) return
    event.preventDefault()
    if (event.key === 'Home') buttons[0]?.focus()
    else if (event.key === 'End') buttons.at(-1)?.focus()
    else {
      const step = event.key === 'ArrowRight' ? 1 : -1
      buttons[(current + step + buttons.length) % buttons.length]?.focus()
    }
  }

  /* Reordering is a pointer gesture, not HTML5 drag-and-drop: the shell's
     webview drag-drop handler swallows those events on Linux and Windows.
     The DOM never reorders mid-gesture — siblings slide by transform to
     open the gap and the drop commits moveTab — so a cancel has nothing
     to undo. Listeners live on the document because the drag only starts
     (and captures the pointer) after a 4px move, by which point the
     pointer may already be off the tab. */
  function onTabPointerDown(e: ReactPointerEvent<HTMLDivElement>, tab: CanvasTab, index: number) {
    /* only the primary button drags: middle click stays Close, right click
       stays the context menu, and a touch keeps scrolling the strip */
    if (e.button !== 0 || e.pointerType === 'touch') return
    if (!(e.target instanceof Element) || !e.target.closest('[role="tab"]')) return
    const stripNode = strip.current
    const range = tabMoveRange(tabs, index)
    if (!stripNode || !range || range.first === range.last) return
    const list = stripNode
    const firstIndex = range.first
    const siblings = Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-desktop-tab]')).filter(
      (node) => Number(node.dataset.desktopTab) >= range.first && Number(node.dataset.desktopTab) <= range.last,
    )
    if (siblings[index - range.first] !== e.currentTarget) return
    cancelDrag.current?.()
    const el = e.currentTarget
    const d = {
      id: tab.id,
      from: index - range.first,
      target: index - range.first,
      startX: e.clientX,
      x: e.clientX,
      startScroll: 0,
      pointerId: e.pointerId,
      width: 0,
      min: 0,
      max: 0,
      mids: [] as number[],
      dragging: false,
    }
    /* Drop geometry is worked in content coordinates (clientX + scrollLeft)
       so a strip scroll mid-drag shifts nothing: the midpoints and the
       clamp bounds were frozen at drag start and stay valid */
    function place(clientX: number) {
      const cx = clientX + list.scrollLeft
      const dx = Math.min(Math.max(cx - (d.startX + d.startScroll), d.min), d.max)
      el.style.transform = `translateX(${dx}px)`
      /* the drop slot counts the sibling midpoints the pointer has passed */
      d.target = d.mids.filter((m) => cx > m).length
      for (const [i, child] of siblings.entries()) {
        if (i === d.from) continue
        const shift =
          d.target > d.from && i > d.from && i <= d.target
            ? -d.width
            : d.target < d.from && i >= d.target && i < d.from
              ? d.width
              : 0
        child.style.transform = shift ? `translateX(${shift}px)` : ''
      }
    }
    function scrolled() {
      place(d.x)
    }
    function move(ev: PointerEvent) {
      if (ev.pointerId !== d.pointerId) return
      d.x = ev.clientX
      if (!d.dragging) {
        /* inside the threshold the gesture is still a candidate click */
        if (Math.abs(ev.clientX - d.startX) < 4) return
        el.setPointerCapture(ev.pointerId)
        const rect = el.getBoundingClientRect()
        const rects = siblings.map((child) => child.getBoundingClientRect())
        const first = rects[0]
        const last = rects[rects.length - 1]
        if (!first || !last) return
        d.startScroll = list.scrollLeft
        d.width = rect.width
        d.min = first.left - rect.left
        d.max = last.right - rect.right
        d.mids = rects.filter((_, i) => i !== d.from).map((r) => r.left + r.width / 2 + d.startScroll)
        d.dragging = true
        el.style.zIndex = '1'
        for (const [i, child] of siblings.entries())
          if (i !== d.from) child.style.transition = 'transform 150ms ease-out'
        list.addEventListener('scroll', scrolled)
      }
      place(d.x)
    }
    function finish(commit: boolean) {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', cancel)
      document.removeEventListener('keydown', key, true)
      list.removeEventListener('scroll', scrolled)
      unsub()
      cancelDrag.current = null
      for (const child of siblings) {
        child.style.transition = ''
        child.style.transform = ''
        child.style.zIndex = ''
      }
      if (!d.dragging) return
      if (el.hasPointerCapture(d.pointerId)) el.releasePointerCapture(d.pointerId)
      if (commit) moveTab(d.id, firstIndex + d.target)
      /* the click that lands after a drop — or after a cancelled drag's
         release — must not navigate; it can be over a different tab by
         then. A committed drop's click shares its pointerup's task; a
         cancelled one arrives with the press's own later release, and if
         that release produced no click (outside the window) the next press
         or release retires the eater rather than letting it swallow a
         real click */
      const eat = (ev: MouseEvent) => {
        ev.preventDefault()
        ev.stopPropagation()
      }
      const disarm = () => {
        /* the pointerup's click companion is dispatched in the same task,
           ahead of this timer, so the eater still sees it */
        setTimeout(() => document.removeEventListener('click', eat, true), 0)
      }
      const disarmNow = () => document.removeEventListener('click', eat, true)
      document.addEventListener('click', eat, { capture: true, once: true })
      document.addEventListener('pointerup', disarm, { capture: true, once: true })
      document.addEventListener('pointerdown', disarmNow, { capture: true, once: true })
    }
    function up(ev: PointerEvent) {
      if (ev.pointerId === d.pointerId) finish(true)
    }
    function cancel(ev: PointerEvent) {
      if (ev.pointerId === d.pointerId) finish(false)
    }
    function key(ev: globalThis.KeyboardEvent) {
      if (ev.key !== 'Escape') return
      /* a drag's Esc is ours: keep it from the canvas, where it would also
         deselect or stop following. An Esc before the threshold is not ours */
      if (d.dragging) {
        ev.preventDefault()
        ev.stopPropagation()
      }
      finish(false)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', cancel)
    document.addEventListener('keydown', key, true)
    /* the strip can change under the gesture — ⌘W closes a tab, a deep
       link opens one — and the frozen geometry would land the drop on the
       wrong slot; a rename keeps the same ids and must not cancel */
    const unsub = useTabs.subscribe((s, prev) => {
      if (
        s.tabs.length !== prev.tabs.length ||
        s.tabs.some((t, i) => t.id !== prev.tabs[i]?.id || t.pinned !== prev.tabs[i]?.pinned)
      )
        finish(false)
    })
    cancelDrag.current = () => finish(false)
  }

  return (
    <div
      {...(desktop ? { 'data-tauri-drag-region': true } : {})}
      className="fixed inset-x-0 top-0 z-[800] flex h-[38px] border-b border-line bg-paper-deep"
    >
      {desktop && hasInsetTrafficLights() && <div data-tauri-drag-region className="w-[76px] flex-none" />}
      <Tooltip label={withShortcut(t('canvas.tabHome'), 0)} side="bottom" className="z-[825]">
        <button
          type="button"
          className={cn(stripButton, 'ml-4.5')}
          aria-label={t('canvas.tabHome')}
          onClick={() => navigate('/')}
        >
          <HomeIcon size="rail" />
        </button>
      </Tooltip>
      <div
        ref={strip}
        role="tablist"
        aria-label={t('canvas.openCanvases')}
        className="flex h-full min-w-0 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onKeyDown={moveTabFocus}
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === activeId
          const editing = renaming?.id === tab.id
          const compact = tab.pinned && !editing
          const companion =
            tabs.find((item) => item.id === activeId && item.id !== tab.id) ?? tabs[index + 1] ?? tabs[index - 1]
          const menuOpenToEditor = () => setRenaming(tab)
          return (
            <ContextMenu key={tab.id}>
              <ContextMenuTrigger asChild>
                <div
                  className={cn(
                    'group relative flex h-full items-center px-px',
                    compact ? 'w-[32px] flex-none' : 'min-w-[84px] max-w-[188px] shrink basis-[188px]',
                  )}
                  data-desktop-tab={index}
                  onPointerDown={(e) => onTabPointerDown(e, tab, index)}
                  onAuxClick={(e) => e.button === 1 && closeTab(tab.id, path)}
                  onContextMenu={(event) => {
                    if (!event.nativeEvent.isTrusted) return
                    event.preventDefault()
                    openTabMenu(event.currentTarget)
                  }}
                >
                  <Tooltip label={withShortcut(tab.name, index + 1)} side="bottom" className="z-[825]">
                    <button
                      id={`desktop-canvas-tab-${tab.id}`}
                      role="tab"
                      type="button"
                      aria-label={tab.name}
                      aria-selected={selected}
                      aria-haspopup="menu"
                      aria-controls={selected ? 'desktop-canvas-content' : undefined}
                      tabIndex={selected || (!activeId && index === 0) ? 0 : -1}
                      onClick={() => path !== `/c/${tab.id}` && navigate(canvasTabTarget(tab))}
                      onDoubleClick={() => tab.id !== readOnlyId && menuOpenToEditor()}
                      className={cn(
                        'relative flex h-[30px] w-full min-w-0 items-center gap-1.5 rounded-[6px] text-[12.5px] text-ink-soft hover:bg-sub hover:text-ink focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        'aria-selected:bg-surface aria-selected:text-ink aria-selected:hover:bg-surface',
                        compact ? 'h-[30px] justify-center' : 'pl-2 pr-7',
                      )}
                    >
                      <TabCodeMark canvasId={tab.id} selected={selected} />
                      {!compact && <span className="min-w-0 truncate">{tab.name}</span>}
                    </button>
                  </Tooltip>
                  {!compact && !editing && (
                    <button
                      type="button"
                      tabIndex={selected ? 0 : -1}
                      className={cn(
                        'absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-[4px] text-ink-faint opacity-0 hover:bg-sub hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover:opacity-100',
                        selected && 'opacity-100',
                      )}
                      onClick={() => closeTab(tab.id, path)}
                      aria-label={t('canvas.closeTab')}
                      title={t('canvas.closeTab')}
                    >
                      <XIcon className="size-3" />
                    </button>
                  )}
                  {editing && (
                    <TabNameField
                      tab={tab}
                      onDone={() => setRenaming(null)}
                      onError={() => setNotice(t('canvas.tabRenameFailed'))}
                    />
                  )}
                </div>
              </ContextMenuTrigger>
              <TabContextMenu
                tab={tab}
                path={path}
                canRename={tab.id !== readOnlyId}
                companion={companion?.id === tab.id ? undefined : companion}
                onRename={menuOpenToEditor}
                onNotice={setNotice}
              />
            </ContextMenu>
          )
        })}
      </div>
      <button
        type="button"
        className={stripButton}
        onClick={newCanvas}
        aria-label={t('canvas.newCanvas')}
        title={t('canvas.newCanvas')}
      >
        <PlusIcon size="rail" />
      </button>
      {split && split[0] === activeId && (
        <button
          type="button"
          className={stripButton}
          onClick={closeCanvasSplit}
          aria-label={t('canvas.closeSplit')}
          title={t('canvas.closeSplit')}
        >
          <XIcon size="rail" />
        </button>
      )}
      {notice && (
        <div
          className="pointer-events-none absolute top-full right-2 mt-2 rounded-control border border-line bg-surface px-3 py-2 text-[12px] text-ink shadow-pop"
          role="status"
        >
          {notice}
        </div>
      )}
      {desktop && <WindowControls className="-mr-2 ml-auto" />}
    </div>
  )
}

function withShortcut(label: string, slot: number): string {
  const chord = TAB_SHORTCUTS[slot]
  return chord ? `${label} (${chordHint(chord)})` : label
}

function TabNameField({ tab, onDone, onError }: { tab: CanvasTab; onDone: () => void; onError: () => void }) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  function finish() {
    onDone()
    document.getElementById(`desktop-canvas-tab-${tab.id}`)?.focus({ preventScroll: true })
  }

  async function submit() {
    if (pending.current) return
    const name = input.current?.value.trim()
    if (!name || name === tab.name) return finish()
    pending.current = true
    setBusy(true)
    try {
      await renameCanvasTab(tab.id, name)
      finish()
    } catch {
      onError()
      pending.current = false
      setBusy(false)
      input.current?.focus()
    }
  }

  return (
    <form
      className="absolute inset-x-1.5 top-1/2 -translate-y-1/2"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <Input
        ref={input}
        defaultValue={tab.name}
        aria-label={t('canvas.renameFile')}
        aria-busy={busy}
        readOnly={busy}
        inputSize="auto"
        className="h-7 px-2 text-[12.5px]"
        onBlur={() => {
          if (!pending.current) onDone()
        }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape' && !pending.current) {
            event.preventDefault()
            finish()
          }
        }}
      />
    </form>
  )
}

function TabContextMenu({
  tab,
  path,
  canRename,
  companion,
  onRename,
  onNotice,
}: {
  tab: CanvasTab
  path: string
  canRename: boolean
  companion?: CanvasTab
  onRename: () => void
  onNotice: (text: string) => void
}) {
  const t = useT()
  const afterClose = useRef<(() => void) | null>(null)
  const url = new URL(canvasTabTarget(tab), location.origin).href
  const current = path === `/c/${tab.id}`

  function handOffFocus(action: () => void) {
    afterClose.current = action
  }

  return (
    <ContextMenuContent
      aria-label={t('canvas.tabActions', { name: tab.name })}
      className={tabMenu}
      onCloseAutoFocus={(event) => {
        const action = afterClose.current
        afterClose.current = null
        if (!action) return
        // The menu traps focus until its content unmounts.
        event.preventDefault()
        action()
      }}
    >
      <ContextMenuItem onSelect={() => setCanvasTabPinned(tab.id, !tab.pinned)}>
        {t(tab.pinned ? 'canvas.unpinTab' : 'canvas.pinTab')}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() =>
          void copyCanvasTabLink(tab).then(
            () => onNotice(t('canvas.linkCopied')),
            () => onNotice(t('canvas.tabCopyFailed')),
          )
        }
      >
        {t('canvas.copyLink')}
        <MenuHint aria-hidden="true">{chordHint(COPY_TAB_LINK_SHORTCUT)}</MenuHint>
      </ContextMenuItem>
      <ContextMenuItem disabled={!canRename} onSelect={() => handOffFocus(onRename)}>
        {t('canvas.renameFile')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => (current ? location.reload() : location.assign(url))}>
        {t('canvas.reload')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={!supportsCanvasWindows()}
        onSelect={() => void moveCanvasTabToWindow(tab).catch(() => onNotice(t('canvas.tabWindowFailed')))}
      >
        {t('canvas.moveToNewWindow')}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!companion}
        onSelect={() => {
          if (companion) openCanvasSplit(current ? tab : companion, current ? companion : tab)
        }}
      >
        {t('canvas.openInSplitTab')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => openExternal(url) || window.open(url, '_blank', 'noopener')}>
        {t('canvas.openInBrowser')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => closeTab(tab.id, path)}>{t('common.close')}</ContextMenuItem>
      <ContextMenuItem onSelect={() => closeOtherTabs(tab.id, path)}>{t('canvas.closeOtherTabs')}</ContextMenuItem>
      <ContextMenuItem onSelect={closeAllTabs}>{t('canvas.closeAllTabs')}</ContextMenuItem>
    </ContextMenuContent>
  )
}

export function DesktopSplit({ tabs }: { tabs: [CanvasTab, CanvasTab] }) {
  return (
    <div className="grid h-full min-h-0 grid-cols-2 gap-px bg-line">
      {tabs.map((tab) => (
        <section key={tab.id} className="flex min-w-0 flex-col bg-paper" aria-label={tab.name}>
          <div className="truncate border-b border-line px-3 py-1.5 text-[12px] font-medium text-ink-soft">
            {tab.name}
          </div>
          <iframe title={tab.name} src={canvasTabTarget(tab)} className="min-h-0 w-full flex-1 border-0" />
        </section>
      ))}
    </div>
  )
}

/** Drag handle for shell screens without the tab strip: the overlay title bar has no native drag area of its own. On
 *  Windows, once the page owns the frame, it also carries the caption
 *  buttons — these screens would otherwise have no way to close the window.
 *  A fixed-position screen passed as `children` (the guest canvas, whose
 *  toolbar sits 14px from the top) is moved below that bar through the
 *  --app-inset contract (App.tsx) instead of having its toolbar covered. */
export function ShellDragBar({ children, reserveSpace = false }: { children?: ReactNode; reserveSpace?: boolean }) {
  const customFrame = useWindowFrame((s) => s.custom)
  const inset = hasInsetTrafficLights()
  if (reserveSpace && (customFrame || inset))
    return (
      <>
        <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-[950] flex h-[38px] justify-end">
          <WindowControls />
        </div>
        <div className="h-dvh overflow-auto pt-[38px] [--app-inset:38px]">{children}</div>
      </>
    )
  if (customFrame)
    return (
      <>
        <div
          data-tauri-drag-region
          className={cn(
            'fixed inset-x-0 top-0 z-[950] flex h-8 justify-end',
            children && 'border-b border-line bg-paper-deep',
          )}
        >
          <WindowControls />
        </div>
        {children && <div className="[--app-inset:32px]">{children}</div>}
      </>
    )
  return (
    <>
      {inset && <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-[950] h-6" />}
      {children}
    </>
  )
}
