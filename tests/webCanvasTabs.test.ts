// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/auth', () => ({ authClient: {} }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/shell', async (load) => ({
  ...(await load<object>()),
  isDesktopShell: () => false,
  supportsCanvasTabs: () => false,
}))

const { ensureTab, openCanvasTab, setTabsUser, useTabs } = await import('../src/lib/desktop')
const { navigate } = await import('../src/App')

beforeEach(() => {
  localStorage.clear()
  setTabsUser(null)
  setTabsUser('web-user')
  useTabs.setState({ tabs: [], split: null })
  vi.mocked(navigate).mockClear()
})

it('does not create or persist tab state without the desktop shell', () => {
  expect(openCanvasTab('c1', 'First')).toBe(false)
  expect(openCanvasTab('c2', 'Second')).toBe(false)
  expect(useTabs.getState().tabs).toEqual([])
  expect(navigate).not.toHaveBeenCalled()

  setTabsUser(null)
  setTabsUser('web-user')
  expect(useTabs.getState().tabs).toEqual([])
  expect(localStorage.getItem('doop-open-tabs:web-user')).toBeNull()
})

it('does not add a deep-linked canvas to hidden web tab state', () => {
  ensureTab('deep', 'Deep link')
  expect(useTabs.getState().tabs).toEqual([])
})

it('does not restore legacy tab state into the web shell', () => {
  setTabsUser(null)
  localStorage.setItem(
    'doop-open-tabs:web-user',
    JSON.stringify([
      { id: 'c1', name: 'First', group: 'Editorial', pageId: 'page-one' },
      { id: 'c2', name: 'Pinned', pinned: true },
      { id: 'c3', name: 'Third', group: 'Other' },
    ]),
  )
  localStorage.setItem('doop-tab-groups:web-user', JSON.stringify({ groupFilter: 'Editorial' }))

  setTabsUser('web-user')
  expect(useTabs.getState().tabs).toEqual([])
})
