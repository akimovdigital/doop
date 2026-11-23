// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { calls, initPostHog } = vi.hoisted(() => ({
  calls: [] as unknown[][],
  initPostHog: vi.fn<(key: string, replayPolicyQueued: boolean) => void>(),
}))

vi.mock('../src/lib/posthogClient', () => {
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push([method, ...args])
    }
  return {
    initPostHog,
    posthog: {
      capture: record('capture'),
      captureException: record('exception'),
      identify: record('identify'),
      reset: record('reset'),
    },
    syncReplayForUser: record('replay'),
    suspendAnalyticsWhileImpersonating: record('impersonate'),
    setSupportWidgetVisible: record('visibility'),
    openSupportChat: () => (calls.push(['support']), true),
  }
})

let frames: FrameRequestCallback[]

async function paint() {
  const current = frames.splice(0)
  current.forEach((frame) => frame(performance.now()))
  await vi.dynamicImportSettled()
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubEnv('VITE_POSTHOG_KEY', 'test-key')
  frames = []
  calls.length = 0
  initPostHog.mockReset()
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('is inert without a key', async () => {
  vi.stubEnv('VITE_POSTHOG_KEY', '')
  const analytics = await import('../src/lib/posthog')
  analytics.schedulePostHog()
  analytics.posthog.capture('ignored')
  analytics.posthog.identify('ignored')
  analytics.posthog.reset()
  analytics.syncReplayForUser('ignored@example.test')
  analytics.setSupportWidgetVisible(false)
  expect(analytics.openSupportChat()).toBe(false)
  expect(frames).toHaveLength(0)
  await vi.runAllTimersAsync()
  expect(initPostHog).not.toHaveBeenCalled()
  expect(calls).toEqual([])
})

it('waits for a paint, initializes once and replays startup calls in order', async () => {
  const analytics = await import('../src/lib/posthog')
  const error = new Error('startup error')
  analytics.posthog.capture('before_commit', { source: 'canvas' })
  analytics.schedulePostHog()
  analytics.schedulePostHog()
  analytics.posthog.identify('person')
  analytics.syncReplayForUser('person@example.test')
  analytics.setSupportWidgetVisible(false)
  analytics.openSupportChat()
  analytics.suspendAnalyticsWhileImpersonating()
  analytics.posthog.reset()
  window.dispatchEvent(new ErrorEvent('error', { error }))
  analytics.posthog.capture('last_queued')

  await paint()
  expect(initPostHog).not.toHaveBeenCalled()
  expect(calls).toEqual([])
  await paint()
  expect(initPostHog).toHaveBeenCalledExactlyOnceWith('test-key', true)
  analytics.posthog.capture('after_load')
  expect(calls).toEqual([
    ['capture', 'before_commit', { source: 'canvas' }],
    ['identify', 'person'],
    ['replay', 'person@example.test'],
    ['visibility', false],
    ['support'],
    ['impersonate'],
    ['reset'],
    ['exception', error],
    ['capture', 'last_queued'],
    ['capture', 'after_load'],
  ])
  window.dispatchEvent(new ErrorEvent('error', { error }))
  expect(calls).toHaveLength(10)
})

it('bounds the queue, preserves identity and flushes when animation frames are suspended', async () => {
  const analytics = await import('../src/lib/posthog')
  analytics.posthog.identify('person')
  for (let i = 0; i < 250; i++) analytics.posthog.capture('queued', { i })
  analytics.schedulePostHog()
  await vi.runAllTimersAsync()
  await vi.dynamicImportSettled()
  expect(calls).toHaveLength(200)
  expect(calls.slice(0, 2)).toEqual([
    ['identify', 'person'],
    ['capture', 'queued', { i: 51 }],
  ])
  expect(calls.at(-1)).toEqual(['capture', 'queued', { i: 249 }])
  await paint()
  await paint()
  expect(initPostHog).toHaveBeenCalledTimes(1)
})

it('clears queued calls and keeps the app usable when initialization fails', async () => {
  initPostHog.mockImplementation(() => {
    throw new Error('blocked')
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const analytics = await import('../src/lib/posthog')
  analytics.posthog.capture('queued')
  analytics.schedulePostHog()
  await paint()
  await paint()
  expect(warn).toHaveBeenCalledOnce()
  expect(analytics.openSupportChat()).toBe(false)
  analytics.posthog.capture('later')
  expect(calls).toEqual([])
})
