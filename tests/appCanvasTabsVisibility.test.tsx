// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../src/lib/localAgent', () => ({ startLocalAgent: vi.fn() }))
vi.mock('../src/lib/navigate', () => ({ navigate: vi.fn() }))
vi.mock('../src/pages/Home', () => ({ Home: () => <main data-route="home" /> }))
vi.mock('../src/pages/Community', () => ({ Community: () => null }))
vi.mock('../src/pages/Settings', () => ({ Settings: () => null }))
vi.mock('../src/pages/CanvasPage', () => ({ CanvasPage: () => <main data-route="canvas" /> }))
vi.mock('../src/pages/PrototypePage', () => ({ PrototypePage: () => <main data-route="prototype" /> }))
vi.mock('../src/pages/AuthPage', () => ({ AuthPage: () => null }))
vi.mock('../src/pages/DesktopHandoff', () => ({ DesktopHandoff: () => null }))
vi.mock('../src/pages/DesktopSignIn', () => ({ DesktopSignIn: () => null }))
vi.mock('../src/pages/DesktopConnect', () => ({ DesktopConnect: () => null }))
vi.mock('../src/pages/DesktopCodexSetup', () => ({ DesktopCodexSetup: () => null }))
vi.mock('../src/pages/OAuthConsent', () => ({ OAuthConsent: () => null }))
vi.mock('../src/pages/Admin', () => ({ Admin: () => null }))
vi.mock('../src/pages/Automations', () => ({ Automations: () => null }))
vi.mock('../src/pages/AutomationEditor', () => ({ AutomationEditor: () => null }))
vi.mock('../src/pages/Integrations', () => ({ Integrations: () => null }))
vi.mock('../src/pages/Workspace', () => ({ Workspace: () => null }))
vi.mock('../src/components/UpgradeHost', () => ({ UpgradeHost: () => null }))
vi.mock('../src/lib/auth', () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: 'u1', name: 'Tester', email: 'tester@example.com' } }, isPending: false }),
  },
}))
vi.mock('../src/lib/store', () => ({
  useStore: (select: (state: { signInRequired: boolean }) => unknown) => select({ signInRequired: false }),
}))
vi.mock('../src/lib/identity', () => ({ setName: vi.fn() }))
vi.mock('../src/lib/posthog', () => ({
  posthog: { capture: vi.fn(), identify: vi.fn(), reset: vi.fn() },
  setSupportWidgetVisible: vi.fn(),
  syncReplayForUser: vi.fn(),
  suspendAnalyticsWhileImpersonating: vi.fn(),
}))
vi.mock('../src/lib/me', () => ({ useMe: () => ({ impersonating: false }) }))
vi.mock('../src/lib/api', () => ({ adminApi: {} }))
vi.mock('../src/components/DesktopTabs', () => ({
  DesktopTabs: () => <div role="tablist" aria-label="Open canvases" />,
  DesktopSplit: () => null,
  ShellDragBar: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))
vi.mock('../src/lib/desktop', () => ({
  setTabsUser: vi.fn(),
  useTabs: (select: (state: { split: null; tabs: never[] }) => unknown) => select({ split: null, tabs: [] }),
}))
vi.mock('../src/lib/windowFrame', () => ({
  useWindowFrame: (select: (state: { custom: boolean }) => unknown) => select({ custom: false }),
}))
vi.mock('../src/lib/i18n', () => ({ useT: () => (key: string) => key }))

const { App } = await import('../src/App')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ShellGlobal = typeof globalThis & { __DOOP_DESKTOP__?: string }
const shell = globalThis as ShellGlobal
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete shell.__DOOP_DESKTOP__
})

it.each([
  { shellVersion: undefined, path: '/', visible: false, name: 'web Home' },
  { shellVersion: undefined, path: '/c/canvas-1', visible: false, name: 'web canvas' },
  { shellVersion: '0.1.5', path: '/', visible: true, name: 'desktop Home' },
  { shellVersion: '0.1.5', path: '/c/canvas-1', visible: true, name: 'desktop canvas' },
  { shellVersion: '0.1.5', path: '/c/canvas-1/proto', visible: false, name: 'desktop prototype' },
])('shows the top canvas rail on $name: $visible', async ({ shellVersion, path, visible }) => {
  if (shellVersion) shell.__DOOP_DESKTOP__ = shellVersion
  else delete shell.__DOOP_DESKTOP__
  history.replaceState(null, '', path)

  await act(async () => root.render(<App />))

  expect(container.querySelector('[role="tablist"][aria-label="Open canvases"]') !== null).toBe(visible)
})
