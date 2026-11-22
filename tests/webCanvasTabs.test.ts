// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/auth', () => ({ authClient: {} }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/shell', async (load) => ({
  ...(await load<object>()),
  isDesktopShell: () => false,
  supportsCanvasTabs: () => true,
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

it('opens and persists tabs without the desktop shell', () => {
  expect(openCanvasTab('c1', 'First')).toBe(true)
  expect(openCanvasTab('c2', 'Second')).toBe(true)
  expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual(['c1', 'c2'])
  expect(navigate).toHaveBeenCalled()

  setTabsUser(null)
  setTabsUser('web-user')
  expect(useTabs.getState().tabs.map((tab) => ({ id: tab.id, name: tab.name }))).toEqual([
    { id: 'c1', name: 'First' },
    { id: 'c2', name: 'Second' },
  ])
})

it('ensures a deep-linked canvas appears in the strip', () => {
  ensureTab('deep', 'Deep link')
  expect(useTabs.getState().tabs).toEqual([{ id: 'deep', name: 'Deep link' }])
})

it('restores legacy grouped canvases in one row and keeps pins and page links', () => {
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
  expect(useTabs.getState().tabs).toEqual([
    { id: 'c2', name: 'Pinned', pinned: true },
    { id: 'c1', name: 'First', pageId: 'page-one' },
    { id: 'c3', name: 'Third' },
  ])
})
