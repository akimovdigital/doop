// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CanvasMeta, WorkspaceSummary } from '../shared/types'
import { Home } from '../src/pages/Home'
import { api } from '../src/lib/api'
import { useTabs } from '../src/lib/desktop'
import { navigate } from '../src/lib/navigate'
import { setPromptBoxHidden } from '../src/lib/homePreferences'

vi.mock('../src/lib/auth', () => ({
  authClient: { useSession: () => ({ data: { user: { id: 'owner', name: 'Owner' } } }) },
}))
vi.mock('../src/hooks/use-user-events', () => ({ useUserEvents: vi.fn() }))
vi.mock('../src/lib/me', () => ({ useMe: () => null, offersUpgrade: () => false }))
vi.mock('../src/App', async () => ({ navigate: (await import('../src/lib/navigate')).navigate }))
vi.mock('../src/lib/navigate', () => ({ navigate: vi.fn() }))
vi.mock('../src/components/DashShell', () => ({ AccountMenu: () => null }))
vi.mock('../src/components/NativeAppPromo', () => ({ IosAppPrompt: () => null, NativeAppCard: () => null }))
vi.mock('../src/components/StarCard', () => ({ StarCard: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const personal: CanvasMeta = {
  id: 'personal',
  name: 'Personal design',
  ownerId: 'owner',
  frameCount: 1,
  createdAt: 1,
  updatedAt: 2,
}
const work = { ...personal, id: 'work', name: 'Workspace design', workspaceId: 'studio' }
const shared = { ...personal, id: 'shared', name: 'Invited design', ownerId: 'other', shared: true }
const studio: WorkspaceSummary = {
  id: 'studio',
  name: 'Studio',
  ownerId: 'owner',
  role: 'owner',
  active: true,
  status: 'active',
  plan: 'team',
  interval: null,
  seats: 1,
  seatsBought: 1,
  memberCount: 1,
  canvasCount: 1,
  cancelAtPeriodEnd: false,
  libraryPublish: 'everyone',
  createdAt: 1,
  updatedAt: 2,
}
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  history.replaceState(null, '', '/')
  localStorage.clear()
  setPromptBoxHidden(true)
  vi.mocked(navigate).mockClear()
  useTabs.setState({ tabs: [], split: null })
  vi.spyOn(api, 'listCanvases').mockResolvedValue([personal, work, shared])
  vi.spyOn(api, 'listWorkspaces').mockResolvedValue({ workspaces: [studio], billing: { enabled: false } })
  vi.spyOn(api, 'getWorkspace').mockRejectedValue(new Error('Workspace details are not needed in this test.'))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () => root.render(<Home />))
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: null })))
}
const tile = (id: string) => container.querySelector<HTMLElement>(`#home-canvas-${id}`)
const byText = (scope: ParentNode, selector: string, name: string) =>
  Array.from(scope.querySelectorAll<HTMLElement>(selector)).find((node) => node.textContent?.trim() === name)
const menuItem = (name: string) => byText(document, '[role="menuitem"], [role="menuitemcheckbox"]', name)

async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy()
  await act(async () => element!.click())
}

async function key(element: HTMLElement | null | undefined, key: string) {
  expect(element).toBeTruthy()
  await act(async () => element!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
}

async function openMenu(surface: 'context' | 'dropdown', canvas = personal) {
  const row = tile(canvas.id)
  expect(row).not.toBeNull()
  if (surface === 'context') {
    await act(async () => row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
  } else {
    await key(row!.querySelector('[aria-haspopup="menu"]'), 'Enter')
  }
}

async function choose(name: string) {
  await click(menuItem(name))
}

async function sidebar() {
  await key(menuItem('Add to sidebar'), 'ArrowRight')
}

const groups = [
  'Show in folder',
  'Open',
  '|',
  'Create new branch',
  '|',
  'Add to sidebar',
  '|',
  'Copy link',
  'Share',
  'Duplicate',
  '|',
  'Show version history',
  'Rename',
  'Move file…',
  'Move to trash',
  'Remove from recent',
]

it.each(['Grid', 'List'])('exposes the same ordered items and separators in %s view', async (view) => {
  await render()
  await click(container.querySelector(`[aria-label="${view} view"]`))
  for (const surface of ['context', 'dropdown'] as const) {
    await openMenu(surface)
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    const labels = Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]'), (item) =>
      item.getAttribute('role') === 'separator' ? '|' : item.textContent?.trim(),
    )
    expect(labels).toEqual(groups)
    await sidebar()
    expect(menuItem('Pinned')?.getAttribute('aria-checked')).toBe('false')
    expect(menuItem('Tab bar')).toBeUndefined()
    await key(menuItem('Pinned'), 'Escape')
  }
})

it('switches to the workspace folder and scrolls again from inside the folder', async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
  await render()
  await openMenu('context', work)
  await choose('Show in folder')
  expect(tile(personal.id)).toBeNull()
  expect(tile(work.id)).not.toBeNull()
  expect(scroll.mock.contexts).toContain(tile(work.id))
  expect(tile(work.id)?.className).toContain('after:ring-brand')
  await openMenu('dropdown', work)
  await choose('Show in folder')
  expect(scroll).toHaveBeenCalledTimes(2)
})

it('hides a removed canvas only in All and keeps Show in folder working', async () => {
  await render()
  await openMenu('dropdown')
  await choose('Remove from recent')
  expect(tile(personal.id)).toBeNull()
  expect(localStorage.getItem('doop.home.removed-recents')).toBe('["personal"]')
  await click(byText(container, 'nav button', 'Owned by me'))
  expect(tile(personal.id)).not.toBeNull()
  await openMenu('context')
  expect(menuItem('Remove from recent')?.hasAttribute('data-disabled')).toBe(true)
  await choose('Show in folder')
  expect(tile(personal.id)?.className).toContain('after:ring-brand')

  await click(byText(container, 'nav button', 'Shared with me'))
  await openMenu('context', shared)
  await choose('Remove from recent')
  expect(tile(shared.id)).not.toBeNull()
  await openMenu('context', shared)
  await choose('Show in folder')
  expect(tile(shared.id)?.className).toContain('after:ring-brand')
  expect(byText(container, 'nav button', 'Owned by me')?.hasAttribute('data-active')).toBe(true)
})

it('pins the canvas in the side rail, opens it from there and unpins it', async () => {
  await render()
  await openMenu('context')
  await sidebar()
  await choose('Pinned')
  const pinnedRow = byText(container, 'nav[aria-label="Pinned"] button', personal.name)
  expect(pinnedRow).toBeDefined()
  expect(localStorage.getItem('doop.home.pinned-canvases')).toBe('["personal"]')
  await click(pinnedRow)
  expect(navigate).toHaveBeenCalledWith('/c/personal')
  await openMenu('dropdown')
  await sidebar()
  expect(menuItem('Pinned')?.getAttribute('aria-checked')).toBe('true')
  await choose('Pinned')
  expect(container.querySelector('nav[aria-label="Pinned"]')).toBeNull()
  expect(localStorage.getItem('doop.home.pinned-canvases')).toBe('[]')
})

it('pins and unpins an existing desktop tab and opens history in a canvas tab', async () => {
  vi.stubGlobal('__DOOP_DESKTOP__', '0.15.0')
  await render()
  await openMenu('dropdown')
  await sidebar()
  await choose('Tab bar')
  expect(useTabs.getState().tabs).toEqual([{ id: 'personal', name: 'Personal design', pinned: true }])
  expect(navigate).not.toHaveBeenCalled()
  await openMenu('context')
  await sidebar()
  expect(menuItem('Tab bar')?.getAttribute('aria-checked')).toBe('true')
  await choose('Tab bar')
  expect(useTabs.getState().tabs[0]?.pinned).toBeUndefined()
  await openMenu('context', work)
  await choose('Show version history')
  expect(navigate).toHaveBeenCalledWith('/c/work?history=1')
  expect(useTabs.getState().tabs).toContainEqual({ id: 'work', name: 'Workspace design' })
})

it('opens, copies the link and requests version history from the web menu', async () => {
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  await render()
  await openMenu('dropdown')
  await choose('Open')
  expect(navigate).toHaveBeenCalledWith('/c/personal')
  await openMenu('context')
  await choose('Copy link')
  expect(clipboard).toHaveBeenCalledWith(location.origin + '/c/personal')
  await openMenu('dropdown')
  await choose('Show version history')
  expect(navigate).toHaveBeenLastCalledWith('/c/personal?history=1')
  expect(useTabs.getState().tabs).toEqual([])
})

it('opens the existing Share dialog for the selected canvas', async () => {
  const get = vi.spyOn(api, 'getCanvas').mockResolvedValue({ ...personal, frames: [] })
  vi.spyOn(api, 'listMembers').mockResolvedValue([])
  await render()
  await openMenu('dropdown')
  await choose('Share')
  expect(get).toHaveBeenCalledWith('personal')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Share “Personal design”')
})

it('duplicates with the API name, and makes a numbered branch when the base is taken', async () => {
  vi.mocked(api.listCanvases).mockResolvedValue([
    personal,
    { ...personal, id: 'existing', name: 'Personal design (branch)' },
  ])
  const duplicate = vi
    .spyOn(api, 'duplicateCanvas')
    .mockResolvedValue({ ...personal, id: 'copy', name: 'API copy', frames: [] })
  const rename = vi.spyOn(api, 'renameCanvas').mockResolvedValue({ ok: true })
  await render()
  await openMenu('context')
  await choose('Duplicate')
  expect(duplicate).toHaveBeenCalledWith('personal')
  expect(rename).not.toHaveBeenCalled()
  expect(navigate).toHaveBeenLastCalledWith('/c/copy')
  vi.mocked(navigate).mockClear()
  await openMenu('dropdown')
  await choose('Create new branch')
  expect(duplicate).toHaveBeenCalledTimes(2)
  expect(rename).toHaveBeenCalledWith('copy', 'Personal design (branch) 2')
  expect(navigate).toHaveBeenCalledWith('/c/copy')
})

it('renames inline once on Enter, saves on blur and cancels with Escape', async () => {
  const rename = vi.spyOn(api, 'renameCanvas').mockImplementation(async (_, name) => {
    vi.mocked(api.listCanvases).mockResolvedValue([{ ...personal, name }])
    return { ok: true }
  })
  await render()
  await click(container.querySelector('[aria-label="List view"]'))
  await openMenu('dropdown')
  await choose('Rename')
  const input = tile(personal.id)?.querySelector<HTMLInputElement>('input')
  expect(input?.value).toBe('Personal design')
  input!.value = '  Renamed design  '
  await key(input, 'Enter')
  expect(rename).toHaveBeenCalledExactlyOnceWith('personal', 'Renamed design')
  const renamed = { ...personal, name: 'Renamed design' }
  expect(tile(personal.id)?.textContent).toContain(renamed.name)

  await openMenu('context', renamed)
  await choose('Rename')
  const blurring = tile(personal.id)!.querySelector<HTMLInputElement>('input')!
  blurring.value = 'Saved on blur'
  await act(async () => blurring.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(rename).toHaveBeenLastCalledWith('personal', 'Saved on blur')
  await openMenu('context', { ...personal, name: 'Saved on blur' })
  await choose('Rename')
  const cancelled = tile(personal.id)!.querySelector<HTMLInputElement>('input')!
  cancelled.value = 'Discard this'
  await key(cancelled, 'Escape')
  expect(rename).toHaveBeenCalledTimes(2)
  expect(tile(personal.id)?.textContent).toContain('Saved on blur')
})

it('offers Move file even without workspaces, and moves a workspace canvas to Personal', async () => {
  vi.mocked(api.listWorkspaces).mockResolvedValue({ workspaces: [], billing: { enabled: false } })
  const move = vi.spyOn(api, 'moveCanvas').mockResolvedValue({ ok: true })
  await render()
  await openMenu('context')
  await choose('Move file…')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Move “Personal design”')
  await click(byText(document, '[role="dialog"] button', 'Cancel'))
  await openMenu('dropdown', work)
  await choose('Move file…')
  await key(document.querySelector('[aria-label="Destination"]'), 'Enter')
  await click(byText(document, '[role="option"]', 'Personal — just you and invitees'))
  await click(byText(document, '[role="dialog"] button', 'Move canvas'))
  expect(move).toHaveBeenCalledWith('work', null)
})

it('moves to trash only after the destructive confirmation', async () => {
  const remove = vi.spyOn(api, 'deleteCanvas').mockResolvedValue({ ok: true })
  await render()
  await openMenu('dropdown')
  await choose('Move to trash')
  const confirm = document.querySelector('[role="alertdialog"]')!
  expect(confirm.textContent).toContain('Move “Personal design” to trash?')
  expect(remove).not.toHaveBeenCalled()
  await click(byText(confirm, 'button', 'Move to trash'))
  expect(remove).toHaveBeenCalledExactlyOnceWith('personal')
})

it('keeps view actions usable and disables or hides management actions on shared canvases', async () => {
  await render()
  await openMenu('context', shared)
  for (const name of ['Rename', 'Move file…', 'Create new branch']) {
    expect(menuItem(name)?.hasAttribute('data-disabled')).toBe(true)
  }
  expect(menuItem('Move to trash')).toBeUndefined()
  for (const name of [
    'Open',
    'Copy link',
    'Show in folder',
    'Show version history',
    'Add to sidebar',
    'Remove from recent',
    'Duplicate',
  ]) {
    expect(menuItem(name)?.hasAttribute('data-disabled')).toBe(false)
  }
})
