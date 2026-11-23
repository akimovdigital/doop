import type * as Client from './posthogClient'

type AnalyticsClient = typeof Client
type PendingCall = { run: (client: AnalyticsClient) => void; capture: boolean }

const key = import.meta.env.VITE_POSTHOG_KEY
const QUEUE_LIMIT = 200
const LOAD_TIMEOUT_MS = 1500

let client: AnalyticsClient | undefined
let scheduled = false
let failed = false
let replayPolicyQueued = false
const pending: PendingCall[] = []

function dispatch(run: PendingCall['run'], capture = false) {
  if (!key || failed) return
  if (client) {
    run(client)
    return
  }

  if (pending.length === QUEUE_LIMIT) {
    // Prefer evicting an event over losing an identity or replay transition.
    const oldestCapture = pending.findIndex((call) => call.capture)
    if (capture && oldestCapture === -1) return
    pending.splice(Math.max(0, oldestCapture), 1)
  }
  pending.push({ run, capture })
}

// Keep reporting unhandled JavaScript failures while the SDK is in flight.
function queueError(event: ErrorEvent) {
  if (!event.message && !event.error) return
  dispatch(({ posthog }) => posthog.captureException(event.error ?? new Error(event.message)), true)
}

function queueRejection(event: PromiseRejectionEvent) {
  dispatch(({ posthog }) => posthog.captureException(event.reason), true)
}

if (key && typeof window !== 'undefined') {
  window.addEventListener('error', queueError)
  window.addEventListener('unhandledrejection', queueRejection)
}

function removeBootErrorListeners() {
  window.removeEventListener('error', queueError)
  window.removeEventListener('unhandledrejection', queueRejection)
}

/** Call after React's first commit. Prefer the first contentful paint where
 * available. Otherwise leave a paint between two animation frames. The
 * timeout covers a blank screen or suspended/background frames. */
export function schedulePostHog() {
  if (!key || scheduled) return
  scheduled = true

  let started = false
  let frame = 0
  let observer: PerformanceObserver | undefined
  const load = () => {
    if (started) return
    started = true
    clearTimeout(timeout)
    cancelAnimationFrame(frame)
    observer?.disconnect()
    void import('./posthogClient')
      .then((sdk) => {
        removeBootErrorListeners()
        sdk.initPostHog(key, replayPolicyQueued)
        while (pending.length) pending.shift()!.run(sdk)
        client = sdk
      })
      .catch((error: unknown) => {
        removeBootErrorListeners()
        failed = true
        pending.length = 0
        console.warn('Could not load PostHog.', error)
      })
  }

  const timeout = setTimeout(load, LOAD_TIMEOUT_MS)
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('paint')) {
    observer = new PerformanceObserver((entries) => {
      if (entries.getEntriesByName('first-contentful-paint').length) load()
    })
    observer.observe({ type: 'paint', buffered: true })
  } else {
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(load)
    })
  }
}

type SDK = AnalyticsClient['posthog']

export const posthog = {
  capture: (...args: Parameters<SDK['capture']>) => dispatch(({ posthog }) => posthog.capture(...args), true),
  identify: (...args: Parameters<SDK['identify']>) => dispatch(({ posthog }) => posthog.identify(...args)),
  reset: (...args: Parameters<SDK['reset']>) => dispatch(({ posthog }) => posthog.reset(...args)),
}

export function syncReplayForUser(email: string | null | undefined) {
  if (!key || !email) return
  if (!client) replayPolicyQueued = true
  dispatch((sdk) => sdk.syncReplayForUser(email))
}

export function suspendAnalyticsWhileImpersonating() {
  if (!key) return
  if (!client) replayPolicyQueued = true
  dispatch((sdk) => sdk.suspendAnalyticsWhileImpersonating())
}

export function setSupportWidgetVisible(visible: boolean) {
  dispatch((sdk) => sdk.setSupportWidgetVisible(visible))
}

export function openSupportChat(): boolean {
  if (!key || failed) return false
  if (client) return client.openSupportChat()
  dispatch((sdk) => sdk.openSupportChat())
  return true
}
