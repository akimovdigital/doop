import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/shell', async (load) => ({
  ...(await load<object>()),
  isDesktopShell: () => false,
  supportsCanvasTabs: () => true,
}))

vi.mock('../src/App', () => ({ navigate: vi.fn() }))

const { ensureTab, openCanvasTab, setTabsUser, useTabs } = await import('../src/lib/desktop')
const { navigate } = await import('../src/App')

beforeEach(() => {
  localStorage.clear()
  setTabsUser(null)
  setTabsUser('web-user')
  useTabs.setState({ tabs: [], split: null, groupNames: [], groupFilter: null })
  vi.mocked(navigate).mockClear()
})

afterEach(() => {
  setTabsUser(null)
  localStorage.clear()
})

describe('web canvas tabs', () => {
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
})
