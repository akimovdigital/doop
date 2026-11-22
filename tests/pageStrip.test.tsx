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

it('does not render a page strip', async () => {
  await render()
  expect(host.querySelector('[data-slot="page-strip"]')).toBeNull()
  expect(host.textContent).not.toContain('Home')
  await render(true)
  expect(host.querySelector('[data-slot="page-strip"]')).toBeNull()
})
