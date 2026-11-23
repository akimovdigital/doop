import { describe, expect, it } from 'vitest'
import { agentPromptText, readContextPrompt, serializeContextPrompt } from '../shared/uiElementContext'
import {
  designEscape,
  designNotePrompt,
  designNotesReducer,
  formatDesignNotes,
  readDesignNotes,
  writeDesignNotes,
  type DesignNote,
  type NoteElement,
} from '../src/lib/designNotes'

const rect = { x: 12, y: 3, width: 80, height: 40 }
const element: NoteElement = {
  selector: '#go',
  tag: 'button',
  id: 'go',
  classes: [],
  label: '<button>',
  text: ' Open \n now ',
  rect,
  htmlExcerpt: '',
  attributes: [['id', 'go']],
  styles: {
    color: 'red',
    'background-color': 'white',
    'font-size': '16px',
    'font-family': 'Arial',
    display: 'block',
    position: 'static',
  },
}
const note: DesignNote = {
  id: 'a',
  canvasId: 'canvas',
  frameId: 'f',
  frameName: 'Home',
  pageUrl: 'https://example.test/a',
  number: 1,
  kind: 'element',
  elements: [element],
  comment: 'Move this',
  status: 'pending',
  createdAt: 1,
}
const context =
  '[1] DOM Path: #go\nPosition: top=3px, left=12px, width=80px, height=40px\nHTML Element: <button id="go">Open now</button>\nStyles: color: red; background-color: white; font-size: 16px; font-family: Arial; display: block; position: static\nFrame: Home (f)'

describe('design notes', () => {
  it('formats a single selection and its context exactly', () => {
    expect(formatDesignNotes([note])).toBe('<button> — “Open now”: Move this\n\nElement context:\n' + context)
  })
  it('prefixes even a single browser-frame annotation with its source URL', () => {
    expect(formatDesignNotes([{ ...note, source: 'browser' }])).toBe(
      'On https://example.test/a:\n<button> — “Open now”: Move this\n\nElement context:\n' + context,
    )
  })
  it('joins targets, sorts notes and groups pages', () => {
    const empty = { ...element, label: 'SearchBox', text: '' }
    const a = { ...note, elements: [element, empty] }
    const b: DesignNote = { ...note, id: 'b', number: 2, kind: 'region', region: rect, elements: [], comment: 'Align' }
    const c = { ...b, id: 'c', number: 1, pageUrl: 'https://example.test/b' }
    expect(formatDesignNotes([b, a])).toBe(
      '1. <button> — “Open now” + SearchBox: Move this\n2. Screenshot region 80 × 40: Align\n\nElement context:\n' +
        context +
        '\n\n' +
        context.replace('Open now</button>', '</button>'),
    )
    expect(formatDesignNotes([b, a, c]).split('\n\nElement context:')[0]).toBe(
      'On https://example.test/a:\n1. <button> — “Open now” + SearchBox: Move this\n2. Screenshot region 80 × 40: Align\n\nOn https://example.test/b:\n1. Screenshot region 80 × 40: Align',
    )
    expect(formatDesignNotes([b])).toBe('Screenshot region 80 × 40: Align')
  })
  it('formats a single text edit for Send or the chat shortcut', () => {
    const edit: DesignNote = {
      ...note,
      kind: 'textEdit',
      comment: '',
      textEdit: { before: 'Open now', after: 'Read\nmore' },
    }
    expect(formatDesignNotes([edit])).toBe(
      '<button> text edit: change text to “Read↵more” (was “Open now”)\n\nElement context:\n' + context,
    )
  })
  it('keeps late changes inside the text edit excerpt', () => {
    const shared = 'a'.repeat(180)
    const edit: DesignNote = {
      ...note,
      kind: 'textEdit',
      comment: '',
      textEdit: { before: `${shared}last line`, after: `${shared}new line` },
    }
    const summary = formatDesignNotes([edit]).split('\n\n')[0]
    expect(summary).toContain(`“…${'a'.repeat(30)}new line” (was “…${'a'.repeat(30)}last line”)`)
  })
  it('numbers text edits in mixed batches and preserves them in storage', () => {
    const edit: DesignNote = {
      ...note,
      id: 'text',
      number: 2,
      kind: 'textEdit',
      comment: '',
      textEdit: { before: 'Open now', after: 'Read more' },
    }
    const second = { ...edit, id: 'text2', number: 3, textEdit: { before: 'Details', after: 'Learn more' } }
    expect(formatDesignNotes([second, edit]).split('\n\n')[0]).toBe(
      '2. <button> text edit: change text to “Read more” (was “Open now”)\n' +
        '3. <button> text edit: change text to “Learn more” (was “Details”)',
    )
    let raw = ''
    const storage = {
      getItem: () => raw,
      setItem: (_key: string, value: string) => {
        raw = value
      },
    }
    writeDesignNotes(storage, note.canvasId, { batch: false, notes: [note, edit] })
    expect(formatDesignNotes(readDesignNotes(storage, note.canvasId).notes).split('\n\n')[0]).toBe(
      '1. <button> — “Open now”: Move this\n2. <button> text edit: change text to “Read more” (was “Open now”)',
    )
  })
  it('formats CSS changes with and without prose using the Cursor CSS header', () => {
    const cssEdits = [
      { prop: 'color', before: '#fff', after: '#000' },
      { prop: 'font-size', before: '16px', after: '20px' },
    ]
    const css = 'CSS edits — color: #fff → #000; font-size: 16px → 20px'
    expect(formatDesignNotes([{ ...note, cssEdits }])).toBe(
      `<button> — “Open now”: Move this\n\n${css}\n\nElement context:\n${context}`,
    )
    expect(formatDesignNotes([{ ...note, comment: '', cssEdits }])).toBe(
      `<button> — “Open now”: ${css}\n\nElement context:\n${context}`,
    )
  })
  it('summarizes the markup tools on a region and preserves page coordinates in storage', () => {
    const arrow = {
      tool: 'arrow' as const,
      points: [
        { x: 40, y: 120 },
        { x: 60, y: 150 },
      ],
    }
    const region: DesignNote = {
      ...note,
      kind: 'region',
      region: { ...rect, y: 100 },
      regionInPage: true,
      elements: [],
      comment: '',
      markup: [arrow, arrow, { ...arrow, tool: 'ellipse' }],
    }
    let raw = ''
    const storage = {
      getItem: () => raw,
      setItem: (_key: string, value: string) => {
        raw = value
      },
    }
    writeDesignNotes(storage, note.canvasId, { batch: true, notes: [region] })
    const restored = readDesignNotes(storage, note.canvasId).notes
    expect(restored).toEqual([region])
    expect(formatDesignNotes(restored)).toBe('Screenshot region 80 × 40 with markup: 2 arrows, 1 ellipse')
  })
  it('clips the label text, attribute and HTML text independently', () => {
    const el = { ...element, text: 't'.repeat(501), attributes: [['title', 'a'.repeat(201)]] as [string, string][] }
    const out = formatDesignNotes([{ ...note, elements: [el] }])
    expect(out).toContain('“' + 't'.repeat(80) + '”:')
    expect(out).toContain('<button title="' + 'a'.repeat(200) + '">' + 't'.repeat(500) + '</button>')
  })
  it('numbers per page and supports update, remove, clear, restore and append', () => {
    const reduce = designNotesReducer
    const a = reduce([], { type: 'add', note })
    const b = reduce(a, { type: 'add', note: { ...note, id: 'b', status: 'sent' } })
    const c = reduce(b, { type: 'add', note: { ...note, id: 'c', pageUrl: '/other' } })
    expect(c.map((n) => n.number)).toEqual([1, 2, 1])
    const updated = reduce(c, { type: 'update', id: 'a', changes: { comment: 'new' } })
    expect(updated[0]?.comment).toBe('new')
    expect(reduce(updated, { type: 'remove', ids: ['a', 'missing'] })).toEqual(c.slice(1))
    expect(reduce(updated, { type: 'clear' })).toEqual([b[1]])
    expect(reduce(updated, { type: 'restore', notes: a })).toEqual(a)
    expect(reduce(a, { type: 'append', notes: c })).toEqual(c)
  })
  it('round-trips notes and batch preference independently for each canvas', () => {
    const items = new Map<string, string>()
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, data: string) => {
        items.set(key, data)
      },
    }
    writeDesignNotes(storage, 'canvas', { notes: [note], batch: true })
    expect(readDesignNotes(storage, 'canvas')).toEqual({ notes: [note], batch: true })
    expect(readDesignNotes(storage, 'other')).toEqual({ notes: [], batch: false })
    storage.setItem('doop.designNotes.canvas', '{broken')
    expect(readDesignNotes(storage, 'canvas')).toEqual({ notes: [], batch: false })
  })
  it('cancels the innermost active interaction before leaving the player', () => {
    const state = { active: true, dragging: true, editingText: true, noteOpen: true }
    expect(designEscape(state)).toBe('drag')
    expect(designEscape({ ...state, dragging: false })).toBe('text')
    expect(designEscape({ ...state, dragging: false, editingText: false })).toBe('note')
    expect(designEscape({ ...state, dragging: false, editingText: false, noteOpen: false })).toBe('mode')
    expect(designEscape({ ...state, active: false })).toBe('player')
  })
})

it('round-trips a note separately from the original agent brief and preserves legacy prompts', () => {
  const { contexts } = designNotePrompt([note])
  const original = formatDesignNotes([note])
  const wire = serializeContextPrompt(original, 'Move this', contexts)
  expect(wire).toContain('DOM Path: #go')
  expect(agentPromptText(wire)).toBe(original)
  expect(readContextPrompt(wire)).toEqual({ text: 'Move this', contexts })
  expect(readContextPrompt('Plain note\n\n<doop-context>bad</doop-context>')).toEqual({
    text: 'Plain note\n\n<doop-context>bad</doop-context>',
    contexts: [],
  })
})
