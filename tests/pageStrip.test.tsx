// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas } from '../shared/types'

const { useStore } = await import('../src/lib/store')
const { PageStrip } = await import('../src/components/PageStrip')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

const canvas: Canvas = {
  id: 'c1',
  name: 'Design',
  pages: [
    { id: 'p1', name: 'Home' },
    { id: 'p2', name: 'Pricing' },
    { id: 'p3', name: 'Prototyping' },
  ],
  frames: [],
  createdAt: 0,
  updatedAt: 0,
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  useStore.getState().setCanvas(structuredClone(canvas))
  useStore.getState().setActivePage('p1')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (hidden = false) =>
  act(() =>
    root.render(
      <TooltipProvider>
        <PageStrip hidden={hidden} />
      </TooltipProvider>,
    ),
  )

it('shows every page on the stage strip and switches on click', async () => {
  await render()
  const strip = host.querySelector('[data-slot="page-strip"]')!
  expect(strip.getAttribute('aria-label')).toBe('Pages')
  expect(host.querySelector('[data-page-strip-id="p1"]')?.getAttribute('aria-current')).toBe('page')
  expect(host.querySelector('[data-page-strip-id="p2"]')?.getAttribute('aria-current')).toBeNull()

  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-page-strip-id="p2"]')!.click()
  })
  expect(useStore.getState().activePageId).toBe('p2')
  expect(host.querySelector('[data-page-strip-id="p2"]')?.getAttribute('aria-current')).toBe('page')
})

it('steps with previous and next when there are several pages', async () => {
  await render()
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.click()
  })
  expect(useStore.getState().activePageId).toBe('p2')
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-label="Previous page"]')!.click()
  })
  expect(useStore.getState().activePageId).toBe('p1')
})

it('hides with the rest of the chrome', async () => {
  await render(true)
  expect(host.querySelector('[data-slot="page-strip"]')).toBeNull()
})
