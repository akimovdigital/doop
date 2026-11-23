import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CardScope, Frame } from '../../shared/types'
import type { ComponentDef } from '../../shared/components'
import { askFrameWindow } from '../lib/frameBridge'
import {
  designEscape,
  designNotesReducer,
  emptyDesignNotes,
  formatDesignNotes,
  noteHtml,
  readDesignNotes,
  writeDesignNotes,
  type DesignNote,
  type DesignNotesAction,
  type DesignTextEdit,
  type NoteElement,
  type NoteRect,
  type SavedDesignNotes,
} from '../lib/designNotes'
import type { Allowance } from '../lib/api'
import { useStore, type PreviewComposerTarget } from '../lib/store'
import { sendPrompt } from './sendPrompt'

interface Target {
  selector: string
  tag: string
  rect: NoteRect
  componentId?: string
  parent: string | null
  child: string | null
}

type Details = Omit<NoteElement, 'label' | 'htmlExcerpt'> & Target
export type DesignPoint = { x: number; y: number }
type Draft = Pick<DesignNote, 'elements' | 'region' | 'comment' | 'textEdit'> & { id?: string }
type LocatedPin = { rect: NoteRect; missing: boolean }

const subscribers = new Set<() => void>()
const notesByCanvas = new Map<string, SavedDesignNotes>()
function subscribe(listener: () => void) {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}

function savedFor(canvasId?: string): SavedDesignNotes {
  if (!canvasId) return emptyDesignNotes
  const saved = notesByCanvas.get(canvasId) ?? readDesignNotes(localStorage, canvasId)
  notesByCanvas.set(canvasId, saved)
  return saved
}

function changeSaved(canvasId: string, update: (previous: SavedDesignNotes) => SavedDesignNotes) {
  const saved = update(savedFor(canvasId))
  notesByCanvas.set(canvasId, saved)
  writeDesignNotes(localStorage, canvasId, saved)
  subscribers.forEach((notify) => notify())
}

export function useDesignMode({
  canvasId,
  canEdit,
  allowance,
  frame,
  screenKey,
  documentRevision,
  pageUrl,
  source,
  components,
  getWindow,
  onDraft,
  onNavigate,
  onEnter,
}: {
  canvasId?: string
  canEdit: boolean
  allowance: Allowance | null
  frame?: Frame
  screenKey: number
  documentRevision: number
  pageUrl: string
  source?: DesignNote['source']
  components?: ComponentDef[]
  getWindow: () => Window | undefined
  onDraft: (target: PreviewComposerTarget) => void
  onNavigate: (frameId: string, pageUrl: string) => void
  onEnter?: () => void
}) {
  const allowed = !!canvasId && canEdit
  const stored = useSyncExternalStore(subscribe, () => (allowed ? savedFor(canvasId) : emptyDesignNotes))
  const saved = useMemo(
    () => ({ ...stored, notes: stored.notes.filter((note) => note.source === source) }),
    [stored, source],
  )
  const [active, setActive] = useState(false)
  const [usingPage, setUsingPage] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [editingText, setEditingText] = useState(false)
  const textSession = useRef<{ id: string; win: Window }>()
  const [hover, setHover] = useState<Target | null>(null)
  const [region, setRegion] = useState<NoteRect>()
  const [pins, setPins] = useState<Record<string, LocatedPin>>({})
  const drag = useRef<{ start: DesignPoint; pointerId: number; rect?: NoteRect }>()
  const hoverSequence = useRef(0)
  const pickSequence = useRef(0)
  const point = useRef<DesignPoint>()
  const lastRects = useRef(new Map<string, NoteRect>())
  const busy = useStore((s) => s.composerSend?.status === 'busy')
  const sendError = useStore((s) =>
    s.composerSend?.canvasId === canvasId && s.composerSend?.status === 'error' ? s.composerSend.message : null,
  )
  const enabled = allowed && active
  const frameId = frame?.id
  const pageNotes = useMemo(
    () =>
      saved.notes.filter(
        (note) =>
          (source === 'browser' ? note.pageUrl === pageUrl : note.frameId === frameId) && note.status !== 'resolved',
      ),
    [saved.notes, source, pageUrl, frameId],
  )
  const pendingCount = saved.notes.filter((note) => note.status === 'pending').length

  const dispatch = (action: DesignNotesAction) => {
    if (allowed) changeSaved(canvasId!, (prev) => ({ ...prev, notes: designNotesReducer(prev.notes, action) }))
  }

  function clearHover() {
    hoverSequence.current++
    point.current = undefined
    setHover(null)
  }

  function cancelText() {
    const session = textSession.current
    textSession.current = undefined
    session?.win.postMessage({ type: 'doop:textEdit', action: 'cancel', id: session.id }, '*')
    setEditingText(false)
  }

  function clearInteraction() {
    cancelText()
    clearHover()
    pickSequence.current++
    drag.current = undefined
    setRegion(undefined)
    setDraft(null)
  }

  function holdPage() {
    clearHover()
    cancelDrag()
    pickSequence.current++
    setUsingPage(true)
  }

  function releasePage() {
    setUsingPage(false)
  }

  function exit() {
    releasePage()
    clearInteraction()
    setActive(false)
    setQueueOpen(false)
  }

  function enter() {
    setActive(true)
    onEnter?.()
  }

  function toggle() {
    if (!allowed) return
    if (enabled) exit()
    else enter()
  }

  function escape() {
    if (textSession.current) {
      cancelText()
      return true
    }
    if (allowed && queueOpen) {
      setQueueOpen(false)
      return true
    }
    switch (designEscape({ active: enabled, dragging: !!drag.current, noteOpen: !!draft })) {
      case 'drag':
        cancelDrag()
        return true
      case 'note':
        setDraft(null)
        pickSequence.current++
        return true
      case 'mode':
        exit()
        return true
      default:
        return false
    }
  }

  function label(target: Pick<Target, 'componentId' | 'tag'>) {
    return components?.find((component) => component.id === target.componentId)?.name ?? `<${target.tag}>`
  }

  async function ask<T>(type: 'doop:hover' | 'doop:select', payload: Record<string, unknown>) {
    const win = getWindow()
    if (!win) return null
    const reply = await askFrameWindow(win, type, { ...payload, annotation: true })
    return getWindow() === win ? ((reply?.hit as T | null | undefined) ?? null) : null
  }

  async function probe(at: DesignPoint) {
    if (!enabled || drag.current) return
    const seq = ++hoverSequence.current
    point.current = at
    const hit = await ask<Target>('doop:hover', at)
    if (seq === hoverSequence.current) setHover(hit)
  }

  async function moveHighlight(direction: 'parent' | 'child') {
    const selector = hover?.[direction]
    if (!enabled || !selector) return
    const seq = ++hoverSequence.current
    const hit = await ask<Target>('doop:select', { selector, ...point.current })
    if (seq === hoverSequence.current && hit) setHover(hit)
  }

  function asNote(value: Draft, comment: string): DesignNote {
    const stored = value.id && savedFor(canvasId).notes.find((note) => note.id === value.id)
    return {
      id: crypto.randomUUID(),
      canvasId: canvasId!,
      frameId: frame!.id,
      frameName: frame!.name,
      pageUrl,
      ...(source ? { source } : {}),
      number: 1,
      status: 'pending',
      createdAt: Date.now(),
      kind: value.textEdit ? 'textEdit' : value.region ? 'region' : 'element',
      ...(stored || {}),
      elements: value.elements,
      region: value.region,
      textEdit: value.textEdit,
      comment,
    }
  }

  function scopeOf(note: DesignNote): CardScope | undefined {
    const first = note.elements[0]
    return first && { frameId: note.frameId, selector: first.selector }
  }

  function draftToChat(value: Draft) {
    if (!frame || !allowed) return
    const note = asNote(value, value.comment.trim())
    const text = formatDesignNotes([note])
    const store = useStore.getState()
    const previous = store.composerDrafts[canvasId!]
    store.setComposerDraft(canvasId!, previous ? `${previous}\n\n${text}` : text)
    if (value.id && value.textEdit && note.status === 'pending') dispatch({ type: 'remove', ids: [value.id] })
    exit()
    onDraft({ scope: scopeOf(note), label: note.elements[0]?.label })
  }

  async function startTextEdit(at: DesignPoint) {
    const win = getWindow()
    if (!enabled || busy || !win || textSession.current) return
    const id = crypto.randomUUID()
    textSession.current = { id, win }
    pickSequence.current++
    clearHover()
    setEditingText(true)
    const reply = await askFrameWindow(win, 'doop:textEdit', { action: 'start', id, ...at })
    if (textSession.current?.id !== id) return
    if (!reply?.started || getWindow() !== win) {
      cancelText()
    }
  }

  function finishTextEdit(data: { id?: unknown; mode?: unknown; hit?: unknown; before?: unknown; after?: unknown }) {
    if (!textSession.current || textSession.current.id !== data.id) return
    textSession.current = undefined
    setEditingText(false)
    const { before, after, hit, mode } = data
    if (mode === 'revert' || typeof before !== 'string' || typeof after !== 'string' || before === after || !hit) return
    if (!frame || !allowed || !after.trim()) return
    const detail = hit as Details
    const existing = pageNotes.find(
      (note) =>
        note.status === 'pending' &&
        note.pageUrl === pageUrl &&
        note.textEdit &&
        note.elements[0]?.selector === detail.selector &&
        note.textEdit.after === before,
    )
    const textEdit: DesignTextEdit = { before: existing?.textEdit?.before ?? before, after }
    const element = existing?.elements[0] ?? { ...detail, label: label(detail), htmlExcerpt: noteHtml(detail) }
    const value = { id: existing?.id, elements: [element], comment: existing?.comment ?? '', textEdit }
    setDraft(null)
    if (textEdit.before === after && existing) dispatch({ type: 'remove', ids: [existing.id] })
    else if (mode === 'chat') draftToChat(value)
    else if (existing) dispatch({ type: 'update', id: existing.id, changes: { textEdit } })
    else dispatch({ type: 'add', note: asNote(value, '') })
  }

  useEffect(() => {
    const win = getWindow()
    if (!win || !allowed) return
    const edits = pageNotes.flatMap((note) => {
      const first = note.elements[0]
      if (
        !note.textEdit ||
        !first ||
        note.pageUrl !== pageUrl
      )
        return []
      const selector = first.doopId ? `[data-doop-id="${CSS.escape(first.doopId)}"]` : first.selector
      return [{ ...note.textEdit, id: note.id, selector, pending: note.status === 'pending' }]
    })
    win.postMessage({ type: 'doop:textEdit', action: 'sync', edits }, '*')
  }, [allowed, screenKey, documentRevision, pageUrl, getWindow, pageNotes])

  async function pick(at: DesignPoint, shift: boolean, alt: boolean) {
    const seq = ++pickSequence.current
    const previous = point.current
    const selected = previous && Math.hypot(at.x - previous.x, at.y - previous.y) < 3 ? hover : null
    const hit = selected ?? (await ask<Target>('doop:hover', at))
    if (!hit || pickSequence.current !== seq) return
    const detail = await ask<Details>('doop:select', { selector: hit.selector, ...at })
    if (!detail || pickSequence.current !== seq) return
    const element = { ...detail, label: label(detail), htmlExcerpt: noteHtml(detail) }
    if (alt) return draftToChat({ elements: [element], comment: '' })
    setDraft((current) => {
      if (shift && current && !current.region) {
        if (current.elements.some((el) => el.selector === element.selector)) return current
        return { ...current, elements: [...current.elements, element] }
      }
      return { elements: [element], comment: '' }
    })
    setHover(null)
  }

  function pointerDown(at: DesignPoint, pointerId: number) {
    if (!busy) drag.current = { start: at, pointerId }
  }

  function pointerMove(at: DesignPoint, shift: boolean, alt: boolean, scale: number) {
    const current = drag.current
    if (!current) {
      void probe(at)
      return
    }
    const dx = at.x - current.start.x
    const dy = at.y - current.start.y
    if (!current.rect && Math.hypot(dx, dy) * scale <= 4) return
    const width = Math.max(1, shift && Math.abs(dy) > Math.abs(dx) ? 1 : Math.abs(dx))
    const height = Math.max(1, shift && Math.abs(dx) >= Math.abs(dy) ? 1 : Math.abs(dy))
    current.rect = {
      x: current.start.x - (alt || dx < 0 ? width : 0),
      y: current.start.y - (alt || dy < 0 ? height : 0),
      width: width * (alt ? 2 : 1),
      height: height * (alt ? 2 : 1),
    }
    setHover(null)
    setRegion(current.rect)
  }

  function cancelDrag() {
    drag.current = undefined
    setRegion(undefined)
  }

  function pointerUp(at: DesignPoint, pointerId: number, shift: boolean, alt: boolean, scale: number) {
    const current = drag.current
    if (!current || current.pointerId !== pointerId) return
    pointerMove(at, shift, alt, scale)
    cancelDrag()
    if (current.rect) {
      pickSequence.current++
      setDraft({ region: current.rect, elements: [], comment: '' })
    } else void pick(at, shift, alt)
  }

  function openNote(note: DesignNote) {
    if (!allowed || busy) return
    enter()
    setQueueOpen(false)
    if (source === 'browser' ? note.pageUrl !== pageUrl : note.frameId !== frameId)
      onNavigate(note.frameId, note.pageUrl)
    setDraft({
      id: note.id,
      comment: note.comment,
      elements: note.elements,
      region: note.region,
      textEdit: note.textEdit,
    })
  }

  function deleteNote(id: string) {
    dispatch({ type: 'remove', ids: [id] })
    if (draft?.id === id) setDraft(null)
  }

  async function sendNotes(notes: DesignNote[]) {
    if (!canvasId || !allowed || !notes.length || busy) return false
    const result = await sendPrompt({
      canvasId,
      text: formatDesignNotes(notes),
      scope: scopeOf(notes[0]!),
      allowance,
      clearDraft: false,
    })
    if (!result) return false
    const sentAt = Date.now()
    const ids = new Set(notes.map((note) => note.id))
    changeSaved(canvasId, (prev) => ({
      ...prev,
      notes: prev.notes.map((note) =>
        ids.has(note.id) ? { ...note, status: 'sent', sentAt, resolvedAt: undefined, cardId: result.cardId } : note,
      ),
    }))
    return true
  }

  async function submit() {
    if (
      !draft ||
      (!draft.comment.trim() && !draft.textEdit) ||
      !frame ||
      !allowed ||
      useStore.getState().composerSend?.status === 'busy'
    )
      return
    const note = asNote(draft, draft.comment.trim())
    if (draft.id) {
      dispatch({
        type: 'update',
        id: draft.id,
        changes: { comment: note.comment, elements: note.elements, region: note.region },
      })
    } else {
      dispatch({ type: 'add', note })
      if (!saved.batch) {
        const queued = savedFor(canvasId).notes.find((item) => item.id === note.id)!
        setDraft({ ...draft, id: note.id })
        if (!(await sendNotes([queued]))) return
      }
    }
    setDraft(null)
  }

  async function sendPending() {
    const notes = saved.notes.filter((note) => note.status === 'pending')
    if (await sendNotes(notes)) exit()
  }

  const watching = allowed && pageNotes.length > 0
  useEffect(() => {
    const win = getWindow()
    if (!win || !watching) return
    win.postMessage({ type: 'doop:annotation-watch', on: true }, '*')
    return () => win.postMessage({ type: 'doop:annotation-watch', on: false }, '*')
  }, [screenKey, documentRevision, watching, getWindow])

  const [windowRevision, refreshWindow] = useState(0)
  const refreshPins = useCallback(() => refreshWindow((value) => value + 1), [])
  useEffect(() => {
    const win = getWindow()
    if (!win || !watching || !canvasId) return
    let cancelled = false
    let saveTimer: number | undefined
    void Promise.all(
      pageNotes.map(async (note) => {
        const first = note.elements[0]
        const last = lastRects.current.get(note.id) ?? note.lastRect ?? first?.rect ?? note.region
        if (!first || !last) return [note.id, last && { rect: last, missing: false }] as const
        const selector = first.doopId ? `[data-doop-id="${CSS.escape(first.doopId)}"]` : first.selector
        const reply = await askFrameWindow(win, 'doop:locate', { selector }, 1000, 'doop:located')
        const rect = reply?.rect as NoteRect | null | undefined
        if (!cancelled && rect) lastRects.current.set(note.id, rect)
        return [note.id, { rect: rect ?? last, missing: !rect }] as const
      }),
    ).then((entries) => {
      if (cancelled) return
      const located = Object.fromEntries(entries.filter((entry): entry is [string, LocatedPin] => !!entry[1]))
      setPins(located)
      saveTimer = window.setTimeout(() => {
        const previous = savedFor(canvasId)
        let changed = false
        const notes = previous.notes.map((note) => {
          const position = located[note.id]
          if (!note.elements.length || !position || position.missing) return note
          const last = note.lastRect ?? note.elements[0]!.rect
          const rect = position.rect
          if (last.x === rect.x && last.y === rect.y && last.width === rect.width && last.height === rect.height)
            return note
          changed = true
          return { ...note, lastRect: rect }
        })
        if (changed) changeSaved(canvasId, (saved) => ({ ...saved, notes }))
      }, 200)
    })
    return () => {
      cancelled = true
      window.clearTimeout(saveTimer)
    }
  }, [screenKey, documentRevision, watching, pageNotes, windowRevision, getWindow, canvasId])

  function handleKey(event: KeyboardEvent, target: Element | null) {
    if (!allowed) return false
    const field = target?.closest('[data-design-note-field]')
    if (field && draft && !event.isComposing) {
      if (event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'l') {
        draftToChat(draft)
        return true
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        if (!event.repeat) void submit()
        return true
      }
    }
    if (!enabled) return false
    if (event.code === 'Space' && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (target?.closest('input,textarea,select,button,[contenteditable],[role="switch"]')) return false
      if (!event.repeat) holdPage()
      return true
    }
    if (usingPage || field || target?.closest('[data-preview-toolbar],[data-design-card]')) return false
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      void moveHighlight(event.key === 'ArrowUp' ? 'parent' : 'child')
      return true
    }
    return false
  }

  return {
    enabled,
    pageNotes,
    handleKey,
    editingText,
    startTextEdit,
    finishTextEdit,
    usingPage: enabled && usingPage,
    holdPage,
    releasePage,
    allowed,
    busy,
    hover,
    draft,
    region,
    pins,
    saved,
    pendingCount,
    sendError,
    toggle,
    clearInteraction,
    exit,
    escape,
    queueOpen: allowed && queueOpen,
    setQueueOpen,
    enter,
    clearHover,
    moveHighlight,
    pointerDown,
    pointerMove,
    pointerUp,
    cancelDrag,
    openNote,
    deleteNote,
    submit,
    sendPending,
    sendNotes,
    asNote,
    draftToChat,
    refreshPins,
    setComment: (comment: string) => setDraft((value) => value && { ...value, comment }),
    setBatch: (batch: boolean) => changeSaved(canvasId!, (prev) => ({ ...prev, batch })),
    clearPending: () => {
      const ids = saved.notes.filter((note) => note.status === 'pending').map((note) => note.id)
      if (draft?.id && ids.includes(draft.id)) setDraft(null)
      dispatch({ type: 'remove', ids })
    },
    resolve: (id: string) => dispatch({ type: 'update', id, changes: { status: 'resolved', resolvedAt: Date.now() } }),
  }
}
