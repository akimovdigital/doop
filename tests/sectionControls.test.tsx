// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, CanvasPageInfo, CanvasSection, Frame } from '../shared/types'
import { Inspector } from '../src/components/Inspector'
import { CanvasPage } from '../src/pages/CanvasPage'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { wrapSelectionInSection } from '../src/lib/canvasSections'
import { actionById, isEnabled, runAction } from '../src/lib/actions/registry'
import { useStore } from '../src/lib/store'
import { removeSections } from '../server/pageSections'

// Each case mounts the whole canvas editor, as the keyboard listener lives on CanvasPage.
vi.setConfig({ testTimeout: 30_000 })

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() }, POSTHOG_EVENTS: {} }))
vi.mock('../src/lib/auth', () => ({
  authClient: { useSession: () => ({ data: { user: { id: 'u', name: 'Tester' } }, isPending: false }) },
}))

const pageId = 'main'
const section: CanvasSection = { id: 'section', name: 'First section', x: 0, y: 0, width: 250, height: 250 }
const other: CanvasSection = { ...section, id: 'second', name: 'Second section', x: 650 }
const frame: Frame = {
  id: 'frame',
  canvasId: 'fixture',
  pageId,
  name: 'Artboard',
  x: 40,
  y: 50,
  width: 100,
  height: 100,
  html: '<body><p>Hi</p></body>',
  updatedAt: 0,
  createdAt: 0,
  updatedBy: 'Tester',
}
const shape: Frame = {
  ...frame,
  id: 'shape',
  name: 'Loose shape',
  x: 380,
  html: '<body data-doop-canvas-element="true"><svg></svg></body>',
}
const canvas: Canvas = {
  id: frame.canvasId,
  name: 'Fixture',
  frames: [frame, shape],
  pages: [{ id: pageId, name: 'Main', sections: [section, other] }],
  createdAt: 0,
  updatedAt: 0,
  role: 'edit',
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const write = vi.fn()
let pages: CanvasPageInfo[]

beforeEach(() => {
  pages = canvas.pages!
  write.mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const match = typeof path === 'string' && /\/sections\/([^/]+)$/.exec(path)
      if (!match) return Promise.resolve(Response.json([]))
      const id = match[1]!
      const body = JSON.parse(String(init?.body))
      write(id, init?.method, body)
      const state = useStore.getState().canvas!
      if (init?.method === 'DELETE') {
        const layout = removeSections(
          { ...state, components: undefined },
          pageId,
          [id, ...body.additionalSections],
          body.keepContents,
        )!
        pages = layout.pages
        return Promise.resolve(Response.json(layout))
      }
      pages = pages.map((p) => ({ ...p, sections: [...(p.sections ?? []), { ...body, id }] }))
      return Promise.resolve(Response.json({ pages, frameMoves: [] }))
    }),
  )
  vi.stubGlobal(
    'WebSocket',
    class {
      static OPEN = 1
      readyState = 0
      close() {}
    },
  )
  useStore.getState().setCanvas(canvas)
  useStore.getState().select(null)
  useStore.getState().setLayersOpen(true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useStore.getState().setCanvas(null)
  vi.unstubAllGlobals()
})

async function showCanvas() {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <CanvasPage canvasId={canvas.id} />
      </TooltipProvider>,
    ),
  )
}

async function press(key: string, modifiers: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event
}

it.each(['Delete', 'Backspace'])('handles %s from the canvas once and removes the section contents', async (key) => {
  await showCanvas()
  await act(async () => useStore.getState().selectSection(section.id))
  const prevented = new KeyboardEvent('keydown', { key, cancelable: true })
  prevented.preventDefault()
  await act(async () => {
    window.dispatchEvent(prevented)
  })
  expect(write).not.toHaveBeenCalled()
  expect((await press(key)).defaultPrevented).toBe(true)
  expect(write).toHaveBeenCalledExactlyOnceWith(section.id, 'DELETE', { keepContents: false, additionalSections: [] })
  expect(useStore.getState().canvas?.frames.map((item) => item.id)).toEqual([shape.id])
  expect(useStore.getState().selectedSectionId).toBeNull()
})

it('enables Edit → Delete for a section and runs the same command', async () => {
  await showCanvas()
  await act(async () => useStore.getState().selectSection(section.id))
  const action = actionById('delete')
  expect(isEnabled(action)).toBe(true)
  await act(async () => runAction(action))
  expect(write).toHaveBeenCalledExactlyOnceWith(section.id, 'DELETE', { keepContents: false, additionalSections: [] })
})

it('uses the same delete command when the section row has focus', async () => {
  await showCanvas()
  const sections = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === 'Sections',
  )!
  await act(async () => {
    sections.click()
  })
  const row = container.querySelector<HTMLButtonElement>(`button[title="${section.name}"][aria-pressed]`)!
  expect(row).toBeTruthy()
  await act(async () => {
    row.focus()
    row.click()
  })
  expect((await press('Delete', {}, row)).defaultPrevented).toBe(true)
  expect(write).toHaveBeenCalledExactlyOnceWith(section.id, 'DELETE', { keepContents: false, additionalSections: [] })
})

it.each([{ ctrlKey: true }, { metaKey: true }])(
  'unwraps with %j + Backspace and keeps frame coordinates',
  async (modifiers) => {
    await showCanvas()
    await act(async () => useStore.getState().selectSection(section.id))
    expect((await press('Backspace', modifiers)).defaultPrevented).toBe(true)
    expect(write).toHaveBeenCalledExactlyOnceWith(section.id, 'DELETE', { keepContents: true, additionalSections: [] })
    expect(useStore.getState().canvas?.frames).toEqual(canvas.frames)
    expect(useStore.getState().selectedSectionId).toBeNull()
  },
)

it('wraps a frame, loose shape and multiple selected sections through the same command', async () => {
  const state = useStore.getState()
  state.selectMany([frame.id, shape.id])
  state.selectSection(section.id, true)
  state.selectSection(other.id, true)
  await act(async () => {
    await wrapSelectionInSection('Section', { sectionId: section.id })
  })
  expect(write).toHaveBeenCalledTimes(1)
  const [id, method, body] = write.mock.calls[0]!
  expect(method).toBe('PUT')
  expect(body).toMatchObject({ x: -64, y: -64, width: 1028, height: 378 })
  expect(useStore.getState().selectedSectionId).toBe(id)
  expect(useStore.getState().canvas?.frames).toEqual(canvas.frames)
})

it('shows the shared frame geometry groups and section paint controls in the active inspector', async () => {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Inspector frame={frame} />
      </TooltipProvider>,
    ),
  )
  const label = (text: string) => container.querySelector(`[aria-label="${text}"]`)
  const geometry = ['X position', 'Y position', 'Width', 'Height']
  const headings = () => [...container.querySelectorAll('h3')].map((heading) => heading.textContent)
  const frameHeadings = headings()
  for (const name of geometry) expect(label(name), name).not.toBeNull()

  await showCanvas()
  await act(async () => useStore.getState().selectSection(section.id))
  expect(container.querySelector('[data-section-inspector]')).not.toBeNull()
  for (const name of geometry) expect(label(name), name).not.toBeNull()
  expect(headings().slice(0, 3)).toEqual(frameHeadings.filter((name) => ['Position', 'Layout', 'Fill'].includes(name!)))
  for (const name of [
    'Section name',
    'Fill color',
    'Border color',
    'Border width',
    'Corner radius',
    'Link width and height',
  ])
    expect(label(name), name).not.toBeNull()
  expect(headings()).toContain('Stroke')
  expect(label('Rotation')).toBeNull()
  expect(headings()).not.toContain('Export')
})
