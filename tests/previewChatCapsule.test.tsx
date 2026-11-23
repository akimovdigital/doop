// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UiElementContext } from '../shared/uiElementContext'
import { PreviewChatCapsule, usePreviewChat } from '../src/components/PreviewChatCapsule'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { useStore } from '../src/lib/store'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const canvasId = 'preview-canvas'
const heading: UiElementContext = {
  kind: 'element',
  label: '<h1> Sample heading',
  selector: '#title',
  rect: { x: 10, y: 20, width: 120, height: 40 },
  html: '<h1 id="title">Sample heading</h1>',
  styles6: {},
  url: 'https://example.test',
  noteId: 'heading-note',
  number: 1,
  frameId: 'home',
  frameName: 'Home',
}
const button: UiElementContext = {
  ...heading,
  label: '<button> Open',
  selector: '#go',
  html: '<button id="go">Open</button>',
  noteId: 'button-note',
  number: 2,
}

function Preview() {
  const chat = usePreviewChat(canvasId, true)
  return <PreviewChatCapsule chat={chat} canvasId={canvasId} pending={0} allowance={null} onShowQueue={() => {}} />
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  useStore.setState({ composerDrafts: {}, previewComposerTargets: {}, composerSend: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('opens a stored draft with context chips, follows store updates and removes a chip from the same draft', () => {
  const store = useStore.getState()
  store.setComposerDraft(canvasId, 'Match both', [heading])
  store.setComposerDraft('other-canvas', 'Other draft', [button])
  act(() =>
    root.render(
      <TooltipProvider>
        <Preview />
      </TooltipProvider>,
    ),
  )
  act(() => container.querySelector<HTMLButtonElement>('[data-preview-chat-handle]')!.click())

  const field = container.querySelector<HTMLTextAreaElement>('[data-preview-chat-field]')
  expect(field?.value).toBe('Match both')
  expect(document.activeElement).toBe(field)
  const labels = () => [...container.querySelectorAll('[data-context-chip]')].map((chip) => chip.textContent)
  expect(labels()).toEqual([heading.label])

  act(() => store.setComposerDraft(canvasId, 'Match both', [heading, button]))
  expect(labels()).toEqual([heading.label, button.label])

  act(() => container.querySelector<HTMLButtonElement>('[data-context-chip] button')!.click())
  expect(labels()).toEqual([button.label])
  expect(useStore.getState().composerDrafts[canvasId]).toEqual({ text: 'Match both', contexts: [button] })
  expect(useStore.getState().composerDrafts['other-canvas']).toEqual({ text: 'Other draft', contexts: [button] })
})
