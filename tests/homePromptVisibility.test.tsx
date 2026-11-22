// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HomeHero } from '../src/components/HomeHero'
import { GeneralSettings } from '../src/components/GeneralSettings'
import { Button } from '../src/components/ui/button'
import { SparkIcon } from '../src/components/ui/icons'
import { PROMPT_BOX_STORAGE_KEY, setPromptBoxHidden, usePromptBoxHidden } from '../src/lib/homePreferences'

vi.mock('../src/components/ModelPicker', () => ({ ModelPicker: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const actions = {
  onPrompt: vi.fn(),
  onImport: vi.fn(),
  onConnectAgents: vi.fn(),
  onAutomations: vi.fn(),
  onIntegrations: vi.fn(),
  onCommunity: vi.fn(),
}

beforeEach(() => {
  setPromptBoxHidden(false)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function render(busy = false) {
  await act(async () =>
    root.render(<HomeHero busy={busy} actions={actions} focusAt={0} skillScope={{ personal: true }} />),
  )
}

async function click(selector: string, scope: ParentNode = document) {
  const button = scope.querySelector<HTMLButtonElement>(selector)
  expect(button).not.toBeNull()
  await act(async () => button!.click())
}

/** Header expand control as Home mounts left of Import when the prompt is collapsed. */
function HeaderExpand() {
  const hidden = usePromptBoxHidden()
  if (!hidden) return null
  return (
    <Button variant="default" size="bar" aria-label="Show Prompt Box" onClick={() => setPromptBoxHidden(false)}>
      <SparkIcon width={15} height={15} /> Show Prompt Box
    </Button>
  )
}

it('places the labeled collapse button directly in the hero', async () => {
  await render()
  const collapse = container.querySelector('button[aria-label="Collapse prompt box"]')
  expect(collapse?.parentElement?.matches('[data-slot="home-hero"]')).toBe(true)
  expect(collapse?.getAttribute('title')).toBe('Collapse prompt box')
})

it('collapses the prompt box immediately and persists the choice', async () => {
  await render()
  expect(container.querySelector('textarea')).not.toBeNull()
  await click('[aria-label="Collapse prompt box"]')
  expect(container.querySelector('[data-slot="home-hero"]')).toBeNull()
  expect(localStorage.getItem(PROMPT_BOX_STORAGE_KEY)).toBe('true')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('shows a header expand control that restores the prompt box', async () => {
  setPromptBoxHidden(true)
  await act(async () =>
    root.render(
      <>
        <HeaderExpand />
        <HomeHero busy={false} actions={actions} focusAt={0} skillScope={{ personal: true }} />
      </>,
    ),
  )
  expect(container.querySelector('[data-slot="home-hero"]')).toBeNull()
  expect(container.querySelector('[aria-label="Show Prompt Box"]')).not.toBeNull()
  await click('[aria-label="Show Prompt Box"]')
  expect(localStorage.getItem(PROMPT_BOX_STORAGE_KEY)).toBe('false')
  expect(container.querySelector('textarea')).not.toBeNull()
  expect(container.querySelector('[aria-label="Show Prompt Box"]')).toBeNull()
})

it('persists collapsing and lets settings restore the prompt box', async () => {
  await render()
  await click('[aria-label="Collapse prompt box"]')
  expect(container.querySelector('[data-slot="home-hero"]')).toBeNull()
  expect(localStorage.getItem(PROMPT_BOX_STORAGE_KEY)).toBe('true')

  // A fresh module reads the persisted choice, as a page reload would.
  vi.resetModules()
  const fresh = await import('../src/lib/homePreferences')
  function ReloadedHome() {
    return fresh.usePromptBoxHidden() ? null : <p>Prompt box</p>
  }
  await act(async () => root.render(<ReloadedHome />))
  expect(container.textContent).toBe('')

  await act(async () => root.render(<GeneralSettings />))
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
  await click('[role="switch"]', container)
  expect(localStorage.getItem(PROMPT_BOX_STORAGE_KEY)).toBe('false')
  await render()
  expect(container.querySelector('textarea')).not.toBeNull()
})

it('cannot collapse a prompt while it is being submitted', async () => {
  await render(true)
  await click('[aria-label="Collapse prompt box"]')
  expect(container.querySelector('textarea')).not.toBeNull()
  expect(localStorage.getItem(PROMPT_BOX_STORAGE_KEY)).toBe('false')
})
