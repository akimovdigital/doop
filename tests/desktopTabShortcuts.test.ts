// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/auth', () => ({ authClient: {} }))
vi.mock('../src/lib/shell', async (load) => ({
  ...(await load<object>()),
  isDesktopShell: () => true,
  supportsCanvasTabs: () => true,
}))
import {
  closeTab,
  ensureTab,
  pruneTabs,
  rememberTabPage,
  setCanvasTabPinned,
  setTabsUser,
  shellShortcutTarget,
  tabShortcutTarget,
  useTabs,
} from '../src/lib/desktop'
import { navigate } from '../src/App'

const tabs = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
]
const keys = (code: string, extra: Partial<KeyboardEvent> = {}) => ({
  key: code.slice(5),
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
})

afterEach(() => {
  setTabsUser(null)
  useTabs.setState({ tabs: [] })
  localStorage.clear()
  vi.clearAllMocks()
})

it('sends ⌘1 home and ⌘2 onwards to the open tabs in strip order', () => {
  expect(tabShortcutTarget(keys('Digit1', { metaKey: true }), tabs, true)).toBe('/')
  expect(tabShortcutTarget(keys('Digit2', { metaKey: true }), tabs, true)).toBe('/c/a')
  expect(tabShortcutTarget(keys('Digit3', { metaKey: true }), tabs, true)).toBe('/c/b')
})

it('ignores a slot with no tab and chords that are not the plain modifier', () => {
  expect(tabShortcutTarget(keys('Digit4', { metaKey: true }), tabs, true)).toBeNull()
  expect(tabShortcutTarget(keys('Digit1', { metaKey: true, shiftKey: true }), tabs, true)).toBeNull()
  expect(tabShortcutTarget(keys('Digit1', { ctrlKey: true }), tabs, true)).toBeNull()
  expect(tabShortcutTarget(keys('Digit0', { metaKey: true }), tabs, true)).toBeNull()
  expect(tabShortcutTarget(keys('Digit2'), tabs, true)).toBeNull()
})

it('uses Ctrl off a Mac and reads the physical key, not the typed character', () => {
  expect(tabShortcutTarget(keys('Digit2', { ctrlKey: true }), tabs, false)).toBe('/c/a')
  expect(tabShortcutTarget({ ...keys('Digit1', { ctrlKey: true }), key: '&' }, tabs, false)).toBe('/')
})

it('opens Settings on ⌘, (Ctrl+, off a Mac) and leaves the tab chords alone', () => {
  const comma = (extra: Partial<KeyboardEvent>) => ({ ...keys('Comma', extra), key: ',' })
  expect(shellShortcutTarget(comma({ metaKey: true }), tabs, true)).toBe('/settings')
  expect(shellShortcutTarget(comma({ ctrlKey: true }), tabs, false)).toBe('/settings')
  expect(shellShortcutTarget(comma({ ctrlKey: true }), tabs, true)).toBeNull()
  expect(shellShortcutTarget(comma({ metaKey: true, shiftKey: true }), tabs, true)).toBeNull()
  expect(shellShortcutTarget(comma({}), tabs, true)).toBeNull()
  expect(shellShortcutTarget(keys('Digit2', { metaKey: true }), tabs, true)).toBe('/c/a')
})

it('hears the shortcuts from a field that stops its own keys', async () => {
  const { initDesktopShell } = await import('../src/lib/desktop')
  const listener = vi.spyOn(document, 'addEventListener')
  try {
    initDesktopShell()
    useTabs.setState({ tabs })
    const field = document.createElement('input')
    field.addEventListener('keydown', (e) => e.stopPropagation())
    document.body.append(field)
    const ctrl = !/mac/i.test(navigator.platform)
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: '2', code: 'Digit2', metaKey: !ctrl, ctrlKey: ctrl, bubbles: true }),
    )
    expect(navigate).toHaveBeenCalledWith('/c/a')
    field.remove()
  } finally {
    for (const [name, handler, options] of listener.mock.calls) document.removeEventListener(name, handler, options)
    listener.mockRestore()
  }
})

it('restores existing tabs with their new pin and page state after the account is reloaded', () => {
  localStorage.setItem('doop-open-tabs:alice', JSON.stringify(tabs))
  setTabsUser('alice')
  setCanvasTabPinned('b', true)
  rememberTabPage('b', 'page b')
  ensureTab('b', 'Renamed B')
  setTabsUser(null)
  setTabsUser('alice')

  expect(useTabs.getState().tabs).toEqual([{ id: 'b', name: 'Renamed B', pinned: true, pageId: 'page b' }, tabs[0]])
  expect(tabShortcutTarget(keys('Digit2', { metaKey: true }), useTabs.getState().tabs, true)).toBe('/c/b?page=page%20b')
  setCanvasTabPinned('b', false)
  expect(useTabs.getState().tabs[0]?.pinned).toBeUndefined()
  rememberTabPage('b')
  expect(tabShortcutTarget(keys('Digit2', { metaKey: true }), useTabs.getState().tabs, true)).toBe('/c/b')
})

it('keeps restored tabs and a pre-session canvas but does not mix accounts or prune them with a stale list', () => {
  localStorage.setItem('doop-open-tabs:alice', JSON.stringify(tabs))
  localStorage.setItem('doop-open-tabs:bob', JSON.stringify([{ id: 'c', name: 'C', pinned: true }]))
  ensureTab('incoming', 'Incoming deep link')
  setTabsUser('alice')
  expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'incoming'])

  setTabsUser('bob')
  pruneTabs('alice', new Set(['a', 'b']))
  expect(useTabs.getState().tabs).toEqual([{ id: 'c', name: 'C', pinned: true }])
  pruneTabs('bob', new Set())
  expect(useTabs.getState().tabs).toEqual([])
})

it('opens the neighbouring tab on its remembered page when closing the active tab', () => {
  setTabsUser('alice')
  ensureTab('a', 'A')
  ensureTab('b', 'B')
  rememberTabPage('b', 'overview')
  closeTab('a', '/c/a')
  expect(navigate).toHaveBeenCalledWith('/c/b?page=overview')
})
