export interface NoteRect {
  x: number
  y: number
  width: number
  height: number
}

const styleNames = ['color', 'background-color', 'font-size', 'font-family', 'display', 'position'] as const

export interface NoteElement {
  selector: string
  doopId?: string
  tag: string
  id: string
  classes: string[]
  text: string
  rect: NoteRect
  styles: Record<(typeof styleNames)[number], string>
  htmlExcerpt: string
  attributes: [string, string][]
  label: string
}

export interface DesignNote {
  id: string
  canvasId: string
  frameId: string
  frameName: string
  pageUrl: string
  number: number
  kind: 'element' | 'region'
  elements: NoteElement[]
  region?: NoteRect
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
        Pick<DesignNote, 'comment' | 'elements' | 'region' | 'status' | 'sentAt' | 'resolvedAt' | 'cardId'>
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

function elementContext(note: DesignNote, element: NoteElement): string {
  const { x, y, width, height } = element.rect
  return [
    `[${note.number}] DOM Path: ${element.selector}`,
    `Position: top=${y}px, left=${x}px, width=${width}px, height=${height}px`,
    `HTML Element: ${noteHtml(element)}`,
    `Styles: ${styleNames.map((name) => `${name}: ${element.styles[name]}`).join('; ')}`,
    `Frame: ${note.frameName} (${note.frameId})`,
  ].join('\n')
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
            ? `Screenshot region ${Math.round(note.region.width)} × ${Math.round(note.region.height)}`
            : note.elements.map(elementLabel).join(' + ')
          for (const element of note.elements) context.push(elementContext(note, element))
          return `${notes.length > 1 ? `${note.number}. ` : ''}${label}${note.comment ? `: ${note.comment}` : ''}`
        })
      return (byPage.size > 1 ? [`On ${url}:`, ...lines] : lines).join('\n')
    })
    .join('\n\n')
  return context.length ? `${summary}\n\nElement context:\n${context.join('\n\n')}` : summary
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
