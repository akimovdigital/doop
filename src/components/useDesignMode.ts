import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CardScope, Frame } from '../../shared/types'
import type { ComponentDef } from '../../shared/components'
import { constrainMarkup, markupPath, undoMarkup, type MarkupStroke, type MarkupTool } from '../lib/designMarkup'
import { askFrameWindow } from '../lib/frameBridge'
import {
  designEscape,
  designNotesReducer,
  emptyDesignNotes,
  designDraftText,
  designNotePrompt,
  noteContexts,
  noteHtml,
  readDesignNotes,
  writeDesignNotes,
  type DesignCssEdit,
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
type Draft = Pick<
  DesignNote,
  'elements' | 'region' | 'comment' | 'textEdit' | 'cssEdits' | 'regionInPage' | 'markup'
> & { id?: string }
type CssInspector = { selector: string; properties: Record<string, string> }
type LocatedPin = { rect: NoteRect; missing: boolean }

function annotationSelector(element: NoteElement) {
  return element.doopId ? `[data-doop-id="${CSS.escape(element.doopId)}"]` : element.selector
}

const zeroOffset = { x: 0, y: 0 }

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
  const [cssInspector, setCssInspector] = useState<CssInspector | null>(null)
  const cssRequest = useRef(0)
  const [editingText, setEditingText] = useState(false)
  const textSession = useRef<{ id: string; win: Window }>()
  const [hover, setHover] = useState<Target | null>(null)
  const [region, setRegion] = useState<NoteRect>()
  const [markupTool, setMarkupTool] = useState<MarkupTool | 'move'>('move')
  const [markupStroke, setMarkupStroke] = useState<MarkupStroke>()
  const regionMove = useRef<{ start: DesignPoint; pointerId: number; draft: Draft }>()
  const stroke = useRef<{ pointerId: number; markup: MarkupStroke }>()
  const [pageScroll, setPageScroll] = useState<{ screen: number; revision: number; offset: DesignPoint }>()
  const pageOffset =
    pageScroll?.screen === screenKey && pageScroll.revision === documentRevision ? pageScroll.offset : zeroOffset
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

  function closeCssInspector() {
    cssRequest.current++
    setCssInspector(null)
  }

  function closeDraft() {
    cancelMarkup()
    closeCssInspector()
    setDraft(null)
  }

  function clearInteraction() {
    cancelText()
    clearHover()
    pickSequence.current++
    cancelDrag()
    closeDraft()
  }

  function holdPage() {
    clearHover()
    cancelDrag()
    cancelMarkup()
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
    if (stroke.current) {
      cancelMarkup()
      return true
    }
    if (regionMove.current) {
      cancelDrag()
      return true
    }
    if (draft?.region && markupTool !== 'move') {
      setMarkupTool('move')
      return true
    }
    if (textSession.current) {
      cancelText()
      return true
    }
    if (allowed && queueOpen) {
      setQueueOpen(false)
      return true
    }
    if (cssInspector) {
      closeCssInspector()
      return true
    }
    switch (designEscape({ active: enabled, dragging: !!drag.current, noteOpen: !!draft })) {
      case 'drag':
        cancelDrag()
        return true
      case 'note':
        closeDraft()
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
      regionInPage: value.regionInPage,
      markup: value.markup,
      textEdit: value.textEdit,
      cssEdits: value.cssEdits,
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
    const store = useStore.getState()
    const previous = store.composerDrafts[canvasId!]
    const text = [previous?.text, designDraftText(note)].filter(Boolean).join('\n\n')
    store.setComposerDraft(canvasId!, text, [...(previous?.contexts ?? []), ...noteContexts(note)])
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
    closeDraft()
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
      if (!note.textEdit || !first || note.pageUrl !== pageUrl) return []
      const selector = annotationSelector(first)
      return [{ ...note.textEdit, id: note.id, selector, pending: note.status === 'pending' }]
    })
    win.postMessage({ type: 'doop:textEdit', action: 'sync', edits }, '*')
  }, [allowed, screenKey, documentRevision, pageUrl, getWindow, pageNotes])

  async function toggleCssInspector() {
    const first = draft?.elements[0]
    if (!enabled || busy || !draft || !first || draft.elements.length !== 1 || draft.textEdit) return
    if (cssInspector) return closeCssInspector()
    const win = getWindow()
    if (!win) return
    const request = ++cssRequest.current
    const selector = annotationSelector(first)
    const reply = await askFrameWindow(win, 'doop:css', { action: 'inspect', selector })
    if (request !== cssRequest.current || win !== getWindow() || !reply?.properties) return
    const properties = { ...(reply.properties as Record<string, string>) }
    for (const { prop, before } of draft.cssEdits ?? []) properties[prop] = before
    setCssInspector({ selector, properties })
  }

  async function addCssProperty(prop: string) {
    const win = getWindow()
    const inspector = cssInspector
    if (!win || !inspector || (!prop.startsWith('--') && !CSS.supports(prop, 'initial'))) return false
    if (Object.hasOwn(inspector.properties, prop)) return true
    const request = cssRequest.current
    const reply = await askFrameWindow(win, 'doop:css', { action: 'inspect', selector: inspector.selector, prop })
    if (request !== cssRequest.current || win !== getWindow() || !reply?.properties) return false
    setCssInspector({
      ...inspector,
      properties: { ...inspector.properties, ...(reply.properties as Record<string, string>) },
    })
    return true
  }

  function setCssProperty(prop: string, after: string) {
    if (!cssInspector || busy) return
    after = after.trim()
    if (after && !CSS.supports(prop, after)) return
    const computed = cssInspector.properties[prop] ?? ''
    setDraft((current) => {
      if (!current) return current
      const edits = current.cssEdits ?? []
      const existing = edits.find((edit) => edit.prop === prop)
      const before = existing?.before ?? computed
      const next = edits.filter((edit) => edit.prop !== prop)
      if (after && after !== before) next.push({ prop, before, after })
      return { ...current, cssEdits: next }
    })
  }

  useEffect(() => {
    const win = getWindow()
    if (!win || !allowed) return
    const targets = new Map<string, Record<string, string>>()
    function add(element: NoteElement, edits: DesignCssEdit[]) {
      const selector = annotationSelector(element)
      const properties = targets.get(selector) ?? (Object.create(null) as Record<string, string>)
      for (const { prop, after } of edits) properties[prop] = after
      targets.set(selector, properties)
    }
    for (const note of pageNotes) {
      if (note.status !== 'pending' || note.pageUrl !== pageUrl) continue
      if (enabled && draft?.id === note.id && draft.cssEdits) continue
      if (note.elements[0] && note.cssEdits?.length) add(note.elements[0], note.cssEdits)
    }
    if (enabled && draft?.elements[0] && draft.cssEdits?.length) add(draft.elements[0], draft.cssEdits)
    win.postMessage(
      {
        type: 'doop:css',
        action: 'sync',
        targets: [...targets].map(([selector, properties]) => ({ selector, properties })),
      },
      '*',
    )
  }, [allowed, screenKey, documentRevision, pageUrl, getWindow, pageNotes, enabled, draft])

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
    closeCssInspector()
    setDraft((current) => {
      if (shift && current && !current.region && !current.textEdit && !current.cssEdits?.length) {
        if (current.elements.some((el) => el.selector === element.selector)) return current
        return { ...current, elements: [...current.elements, element] }
      }
      return { elements: [element], comment: '' }
    })
    setHover(null)
  }

  function cancelMarkup() {
    stroke.current = undefined
    setMarkupStroke(undefined)
  }

  function undoStroke() {
    if (!enabled || !draft?.region) return false
    if (stroke.current) {
      cancelMarkup()
      return true
    }
    if (!draft.markup?.length) return false
    setDraft((current) => current && { ...current, markup: undoMarkup(current.markup ?? []) })
    return true
  }

  function visibleRegion(note: Pick<DesignNote, 'region' | 'regionInPage'>) {
    const rect = note.region
    if (!rect || !note.regionInPage) return rect
    return { ...rect, x: rect.x - pageOffset.x, y: rect.y - pageOffset.y }
  }

  function pagePoint(at: DesignPoint) {
    return { x: at.x + pageOffset.x, y: at.y + pageOffset.y }
  }

  function extendStroke(current: MarkupStroke, at: DesignPoint, shift: boolean): MarkupStroke {
    const end = pagePoint(at)
    const start = current.points[0]!
    if (current.tool === 'draw') {
      const last = current.points.at(-1)!
      if (last.x === end.x && last.y === end.y) return current
      return { ...current, points: [...current.points, end] }
    }
    return { ...current, points: [start, shift ? constrainMarkup(current.tool, start, end) : end] }
  }

  function pointerDown(at: DesignPoint, pointerId: number) {
    if (busy) return
    if (draft?.region) {
      if (markupTool === 'move') {
        const rect = visibleRegion(draft)!
        if (at.x >= rect.x && at.x <= rect.x + rect.width && at.y >= rect.y && at.y <= rect.y + rect.height) {
          regionMove.current = { start: at, pointerId, draft }
        }
        return
      }
      const markup = { tool: markupTool, points: [pagePoint(at)] }
      stroke.current = { pointerId, markup }
      setMarkupStroke(markup)
      return
    }
    drag.current = { start: at, pointerId }
  }

  function pointerMove(at: DesignPoint, shift: boolean, alt: boolean, scale: number) {
    const drawing = stroke.current
    if (drawing) {
      drawing.markup = extendStroke(drawing.markup, at, shift)
      setMarkupStroke(drawing.markup)
      return
    }
    const moving = regionMove.current
    if (moving) {
      const dx = at.x - moving.start.x
      const dy = at.y - moving.start.y
      const rect = moving.draft.region!
      setDraft(
        (value) =>
          value && {
            ...value,
            region: { ...rect, x: rect.x + dx, y: rect.y + dy },
            markup: moving.draft.markup?.map((mark) => ({
              ...mark,
              points: mark.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
            })),
          },
      )
      return
    }
    if (draft?.region) return
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
    if (regionMove.current) {
      setDraft(regionMove.current.draft)
      regionMove.current = undefined
    }
    drag.current = undefined
    setRegion(undefined)
  }

  function pointerUp(at: DesignPoint, pointerId: number, shift: boolean, alt: boolean, scale: number) {
    if (regionMove.current?.pointerId === pointerId) {
      pointerMove(at, shift, alt, scale)
      regionMove.current = undefined
      return
    }
    const drawing = stroke.current
    if (drawing?.pointerId === pointerId) {
      const markup = extendStroke(drawing.markup, at, shift)
      if (markupPath(markup))
        setDraft((current) => (current?.region ? { ...current, markup: [...(current.markup ?? []), markup] } : current))
      cancelMarkup()
      return
    }
    const current = drag.current
    if (!current || current.pointerId !== pointerId) return
    pointerMove(at, shift, alt, scale)
    cancelDrag()
    if (current.rect) {
      pickSequence.current++
      closeCssInspector()
      setMarkupTool('move')
      const rect = current.rect
      setDraft({ region: { ...rect, ...pagePoint(rect) }, regionInPage: true, elements: [], comment: '' })
    } else void pick(at, shift, alt)
  }

  function openNote(note: DesignNote) {
    if (!allowed || busy) return
    enter()
    cancelMarkup()
    setMarkupTool('move')
    closeCssInspector()
    setQueueOpen(false)
    if (source === 'browser' ? note.pageUrl !== pageUrl : note.frameId !== frameId)
      onNavigate(note.frameId, note.pageUrl)
    setDraft({
      id: note.id,
      comment: note.comment,
      elements: note.elements,
      region: note.region,
      regionInPage: note.regionInPage,
      markup: note.markup,
      textEdit: note.textEdit,
      cssEdits: note.cssEdits,
    })
  }

  function deleteNote(id: string) {
    dispatch({ type: 'remove', ids: [id] })
    if (draft?.id === id) closeDraft()
  }

  async function sendNotes(notes: DesignNote[]) {
    if (!canvasId || !allowed || !notes.length || busy) return false
    const result = await sendPrompt({
      canvasId,
      ...designNotePrompt(notes),
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
      (!draft.comment.trim() && !draft.textEdit && !draft.cssEdits?.length && !draft.markup?.length) ||
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
        changes: {
          comment: note.comment,
          elements: note.elements,
          region: note.region,
          regionInPage: note.regionInPage,
          markup: note.markup,
          cssEdits: note.cssEdits,
          ...(note.status !== 'pending' && note.cssEdits?.length
            ? { status: 'pending' as const, cardId: undefined, sentAt: undefined, resolvedAt: undefined }
            : {}),
        },
      })
    } else {
      dispatch({ type: 'add', note })
      if (!saved.batch) {
        const queued = savedFor(canvasId).notes.find((item) => item.id === note.id)!
        setDraft({ ...draft, id: note.id })
        if (!(await sendNotes([queued]))) return
      }
    }
    closeDraft()
  }

  async function sendPending() {
    const notes = saved.notes.filter((note) => note.status === 'pending')
    if (await sendNotes(notes)) exit()
  }

  const watching = allowed && (enabled || pageNotes.length > 0)
  useEffect(() => {
    const win = getWindow()
    if (!win || !watching) return
    win.postMessage({ type: 'doop:annotation-watch', on: true }, '*')
    return () => win.postMessage({ type: 'doop:annotation-watch', on: false }, '*')
  }, [screenKey, documentRevision, watching, getWindow])

  const [windowRevision, refreshWindow] = useState(0)
  const refreshPins = useCallback(
    (x: unknown, y: unknown) => {
      if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y))
        setPageScroll((previous) =>
          previous?.screen === screenKey &&
          previous.revision === documentRevision &&
          previous.offset.x === x &&
          previous.offset.y === y
            ? previous
            : { screen: screenKey, revision: documentRevision, offset: { x, y } },
        )
      refreshWindow((value) => value + 1)
    },
    [screenKey, documentRevision],
  )
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
        const selector = annotationSelector(first)
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
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.altKey &&
      !event.isComposing &&
      event.key.toLowerCase() === 'z' &&
      !target?.closest('input,[contenteditable]') &&
      undoStroke()
    )
      return true
    if (target?.closest('[data-design-css-inspector]')) {
      if (event.key === 'Escape') {
        target.closest('[data-design-card]')?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')?.focus()
        return escape()
      }
      return false
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
    markupTool,
    setMarkupTool,
    markupStroke,
    pageOffset,
    visibleRegion,
    undoStroke,
    cancelPointer: () => {
      cancelMarkup()
      cancelDrag()
    },
    cssInspector,
    toggleCssInspector,
    closeCssInspector,
    addCssProperty,
    setCssProperty,
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
      if (draft?.id && ids.includes(draft.id)) closeDraft()
      dispatch({ type: 'remove', ids })
    },
    resolve: (id: string) => dispatch({ type: 'update', id, changes: { status: 'resolved', resolvedAt: Date.now() } }),
  }
}
