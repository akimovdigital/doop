import { contextStyleNames, type UiElementContext } from '../../shared/uiElementContext'
import type { MarkupStroke, MarkupTool } from './designMarkup'

export interface NoteRect {
  x: number
  y: number
  width: number
  height: number
}

export interface NoteElement {
  selector: string
  doopId?: string
  tag: string
  textEditable?: boolean
  id: string
  classes: string[]
  text: string
  rect: NoteRect
  styles: Record<(typeof contextStyleNames)[number], string>
  htmlExcerpt: string
  attributes: [string, string][]
  label: string
}

export interface DesignTextEdit {
  before: string
  after: string
}

export interface DesignCssEdit {
  prop: string
  before: string
  after: string
}

export interface DesignNote {
  id: string
  canvasId: string
  frameId: string
  frameName: string
  pageUrl: string
  source?: 'browser'
  number: number
  kind: 'element' | 'region' | 'textEdit'
  textEdit?: DesignTextEdit
  cssEdits?: DesignCssEdit[]
  elements: NoteElement[]
  region?: NoteRect
  /** Older saved regions used viewport coordinates. */
  regionInPage?: boolean
  markup?: MarkupStroke[]
  comment: string
  status: 'pending' | 'sent' | 'resolved'
  createdAt: number
  sentAt?: number
  resolvedAt?: number
  lastRect?: NoteRect
  cardId?: string
}

export type DesignNotesAction =
  | { type: 'add'; note: DesignNote }
  | {
      type: 'update'
      id: string
      changes: Partial<
        Pick<
          DesignNote,
          | 'comment'
          | 'elements'
          | 'region'
          | 'textEdit'
          | 'cssEdits'
          | 'regionInPage'
          | 'markup'
          | 'status'
          | 'sentAt'
          | 'resolvedAt'
          | 'cardId'
        >
      >
    }
  | { type: 'remove'; ids: string[] }
  | { type: 'clear' }
  | { type: 'restore' | 'append'; notes: DesignNote[] }

export function designNotesReducer(notes: DesignNote[], action: DesignNotesAction): DesignNote[] {
  switch (action.type) {
    case 'add': {
      const number =
        notes.reduce((max, note) => (note.pageUrl === action.note.pageUrl ? Math.max(note.number, max) : max), 0) + 1
      return [...notes, { ...action.note, number }]
    }
    case 'update':
      return notes.map((note) => (note.id === action.id ? { ...note, ...action.changes } : note))
    case 'remove':
      return notes.filter((note) => !action.ids.includes(note.id))
    case 'clear':
      return notes.filter((note) => note.status !== 'pending')
    case 'restore':
      return action.notes
    case 'append': {
      const merged = new Map(notes.map((note) => [note.id, note]))
      for (const note of action.notes) merged.set(note.id, note)
      return [...merged.values()]
    }
  }
}

export function designEscape(state: { active: boolean; dragging: boolean; editingText?: boolean; noteOpen: boolean }) {
  if (!state.active) return 'player'
  if (state.dragging) return 'drag'
  if (state.editingText) return 'text'
  return state.noteOpen ? 'note' : 'mode'
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()
const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

export function elementLabel(element: NoteElement): string {
  const text = collapse(element.text).slice(0, 80)
  return text ? `${element.label} — “${text}”` : element.label
}

export function noteHtml(element: Pick<NoteElement, 'attributes' | 'tag' | 'text'>): string {
  const attrs = element.attributes.map(([name, value]) => ` ${name}="${escapeHtml(value.slice(0, 200))}"`).join('')
  return `<${element.tag}${attrs}>${escapeHtml(collapse(element.text).slice(0, 500))}</${element.tag}>`
}

function textEditSummary(edit: DesignTextEdit): string {
  const limit = 120
  const before = Array.from(edit.before)
  const after = Array.from(edit.after)
  let start = 0
  if (Math.max(before.length, after.length) > limit) {
    let common = 0
    while (common < before.length && before[common] === after[common]) common++
    start = Math.max(0, common - 30)
  }
  const excerpt = (text: string[]) => {
    const prefix = start ? '…' : ''
    const end = start + limit - prefix.length
    const middle = text.slice(start, text.length > end ? end - 1 : end).join('')
    const suffix = text.length > end ? '…' : ''
    return (prefix + middle + suffix).replaceAll('\n', '↵')
  }
  return `change text to “${excerpt(after)}” (was “${excerpt(before)}”)`
}

function elementContext(context: UiElementContext): string {
  const { x, y, width, height } = context.rect
  return [
    `[${context.number}] DOM Path: ${context.selector}`,
    `Position: top=${y}px, left=${x}px, width=${width}px, height=${height}px`,
    `HTML Element: ${context.html}`,
    `Styles: ${contextStyleNames.map((name) => `${name}: ${context.styles6[name]}`).join('; ')}`,
    `Frame: ${context.frameName} (${context.frameId})`,
    ...(context.changes ?? []),
  ].join('\n')
}

function markupSummary(markup: MarkupStroke[]) {
  const labels: Record<MarkupTool, [one: string, many: string]> = {
    draw: ['drawing', 'drawings'],
    ellipse: ['ellipse', 'ellipses'],
    rectangle: ['rectangle', 'rectangles'],
    arrow: ['arrow', 'arrows'],
  }
  const counts = new Map<MarkupTool, number>()
  for (const { tool } of markup) counts.set(tool, (counts.get(tool) ?? 0) + 1)
  return [...counts].map(([tool, count]) => `${count} ${labels[tool][count === 1 ? 0 : 1]}`).join(', ')
}

function regionSize(rect: NoteRect) {
  return `${Math.round(rect.width)} × ${Math.round(rect.height)}`
}

export function noteContexts(note: DesignNote): UiElementContext[] {
  const { number, frameId, frameName } = note
  const source = {
    noteId: note.id,
    number,
    frameId,
    frameName,
    url: note.pageUrl,
    ...(note.source && { source: note.source }),
  }
  const changes = [
    ...(note.textEdit ? [textEditSummary(note.textEdit)] : []),
    ...(note.cssEdits?.length ? [cssEditSummary(note)] : []),
    ...(note.markup?.length ? [`Markup: ${markupSummary(note.markup)}`] : []),
  ]
  const editContext = changes.length ? { changes } : {}
  if (note.region) {
    return [
      {
        ...source,
        ...editContext,
        kind: 'region',
        label: `Region ${regionSize(note.region)}`,
        selector: '',
        rect: note.region,
        html: '',
        styles6: {},
      },
    ]
  }
  return note.elements.map((el, index) => {
    const tag = `<${el.tag}>`
    const text = collapse(el.text)
    const snippet = text.length > 40 ? text.slice(0, 39) + '…' : text
    return {
      ...source,
      ...(index === 0 && editContext),
      kind: 'element',
      label: snippet ? `${tag} ${snippet}` : tag,
      selector: el.selector,
      rect: el.rect,
      html: noteHtml(el),
      styles6: el.styles,
      ...(el.label !== tag ? { component: el.label } : {}),
    }
  })
}

function withElementContext(summary: string, context: string[]) {
  return context.length ? [summary, `Element context:\n${context.join('\n\n')}`].filter(Boolean).join('\n\n') : summary
}

export function formatComposerContexts(text: string, contexts: UiElementContext[]): string {
  const numbers = new Map<string, number>()
  const details = contexts.map((context) => {
    if (!numbers.has(context.noteId)) numbers.set(context.noteId, numbers.size + 1)
    const { x, y, width, height } = context.rect
    const detail =
      context.kind === 'element'
        ? elementContext({ ...context, number: numbers.get(context.noteId)! })
        : [
            `Screenshot region ${regionSize(context.rect)}: top=${y}px, left=${x}px, width=${width}px, height=${height}px`,
            `Frame: ${context.frameName} (${context.frameId})`,
            ...(context.changes ?? []),
          ].join('\n')
    return context.source === 'browser' ? `On ${context.url}:\n${detail}` : detail
  })
  return withElementContext(text, details)
}

function cssEditSummary(note: DesignNote) {
  const changes = note.cssEdits?.map(({ prop, before, after }) => `${prop}: ${before} → ${after}`).join('; ')
  return changes ? `CSS edits — ${changes}` : ''
}

function designDraftText(note: DesignNote) {
  return [note.textEdit && textEditSummary(note.textEdit), note.comment, cssEditSummary(note)]
    .filter(Boolean)
    .join('\n\n')
}

export function designNotePrompt(notes: DesignNote[]) {
  return {
    text: notes
      .map((note) => note.comment)
      .filter(Boolean)
      .join('\n\n'),
    contexts: notes.flatMap(noteContexts),
    agentText: formatDesignNotes(notes),
  }
}

export function formatDesignNotes(notes: DesignNote[]): string {
  const byPage = new Map<string, DesignNote[]>()
  for (const note of notes) {
    const group = byPage.get(note.pageUrl) ?? []
    group.push(note)
    byPage.set(note.pageUrl, group)
  }
  const context: string[] = []
  const summary = [...byPage.entries()]
    .map(([url, group]) => {
      const lines = group
        .sort((a, b) => a.number - b.number)
        .map((note) => {
          const label = note.region
            ? `Screenshot region ${regionSize(note.region)}${note.markup?.length ? ` with markup: ${markupSummary(note.markup)}` : ''}`
            : note.textEdit
              ? `<${note.elements[0]?.tag ?? 'element'}> text edit`
              : note.elements.map(elementLabel).join(' + ')
          for (const item of noteContexts(note))
            if (item.kind === 'element') context.push(elementContext({ ...item, changes: undefined }))
          const comment = designDraftText(note)
          return `${notes.length > 1 ? `${note.number}. ` : ''}${label}${comment ? `: ${comment}` : ''}`
        })
      return (
        byPage.size > 1 || group.some((note) => note.source === 'browser') ? [`On ${url}:`, ...lines] : lines
      ).join('\n')
    })
    .join('\n\n')
  return withElementContext(summary, context)
}

export interface SavedDesignNotes {
  notes: DesignNote[]
  batch: boolean
}
export const emptyDesignNotes: SavedDesignNotes = { notes: [], batch: false }
const storageKey = (canvasId: string) => `doop.designNotes.${canvasId}`

export function readDesignNotes(storage: Pick<Storage, 'getItem'>, canvasId: string): SavedDesignNotes {
  try {
    const raw = storage.getItem(storageKey(canvasId))
    if (!raw) return emptyDesignNotes
    const saved = JSON.parse(raw) as SavedDesignNotes | null
    if (saved && Array.isArray(saved.notes))
      return {
        notes: saved.notes.filter((note) => note?.canvasId === canvasId && Array.isArray(note.elements)),
        batch: saved.batch === true,
      }
  } catch {
    // Local storage can be unavailable or contain an older, unreadable value.
  }
  return emptyDesignNotes
}

export function writeDesignNotes(storage: Pick<Storage, 'setItem'>, canvasId: string, saved: SavedDesignNotes): void {
  try {
    storage.setItem(storageKey(canvasId), JSON.stringify(saved))
  } catch {
    // Keep the session usable if the browser denies storage or it is full.
  }
}
