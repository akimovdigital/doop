import type { Frame } from '../../shared/types'
import { FrameSnapshotCache, FrameSnapshots } from '../../src/lib/frameSnapshots'

const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
const clock = () => Math.round(performance.now())
const snapshotReady = (image: HTMLImageElement) => image.hasAttribute('data-frame-snapshot-ready')

// These probes wrap the real producer on the fixture page only. Capture still uses the app's own
// slot selection, rasterizer, timeout, image decoding and cache.
export function traceSnapshots() {
  const trace: { at: number; event: string; data: object }[] = []
  const record = (event: string, data: object = {}) => {
    trace.push({ at: clock(), event, data })
  }
  const resourceEvents = new Map<string, { count: number }>()
  const resourceEvent = (event: string, scope: string, origin: string, extra: object = {}) => {
    const key = JSON.stringify([event, scope, origin, extra])
    const previous = resourceEvents.get(key)
    if (previous) {
      previous.count++
      return
    }
    const data = { scope, origin, ...extra, count: 1 }
    resourceEvents.set(key, data)
    record(event, data)
  }
  const producer = FrameSnapshots.prototype as unknown as {
    wake(): void
    capture(slot: { frame: Frame; image: HTMLImageElement }): Promise<void>
  }
  const { wake, capture } = producer
  const set = FrameSnapshotCache.prototype.set
  let scheduling = false
  let tracingRaster = 0
  const direct = new Map<AbortSignal, 'original' | 'local-control'>()
  const idle = window.requestIdleCallback?.bind(window)
  const cancelIdle = window.cancelIdleCallback?.bind(window)
  const idleJobs = new Set<number>()
  if (idle && cancelIdle) {
    window.requestIdleCallback = (callback, options) => {
      if (!scheduling) return idle(callback, options)
      const id = idle((deadline) => {
        idleJobs.delete(id)
        record('idle-fired', { id, budgetMs: deadline.timeRemaining(), didTimeout: deadline.didTimeout })
        callback(deadline)
      }, options)
      idleJobs.add(id)
      record('idle-scheduled', { id, timeout: options?.timeout ?? null })
      return id
    }
    window.cancelIdleCallback = (id) => {
      if (idleJobs.delete(id)) record('idle-canceled', { id })
      cancelIdle(id)
    }
  }
  producer.wake = function () {
    scheduling = true
    try {
      wake.call(this)
    } finally {
      scheduling = false
    }
  }
  producer.capture = async function (slot) {
    const { id, width, height } = slot.frame
    const start = clock()
    tracingRaster++
    record('capture-start', { id, width, height })
    try {
      await capture.call(this, slot)
    } finally {
      tracingRaster--
      record('capture-end', { id, elapsedMs: clock() - start, ready: snapshotReady(slot.image) })
    }
  }
  FrameSnapshotCache.prototype.set = function (frame, bitmap) {
    record('cache-set', { id: frame.id, bytes: bitmap.bytes })
    set.call(this, frame, bitmap)
  }
  window.addEventListener('message', (event: MessageEvent<{ type?: string; html?: string | null }>) => {
    if (!tracingRaster || event.data?.type !== 'doop:snapshot-result') return
    const iframe = [...document.querySelectorAll<HTMLIFrameElement>('iframe[data-doop-frame]')].find(
      (candidate) => candidate.contentWindow === event.source,
    )
    record('bridge-snapshot-reply', {
      title: iframe?.title,
      chars: event.data.html?.length ?? null,
      origin: event.origin,
    })
  })

  const fetchResource = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    if (!tracingRaster) return fetchResource(input, init)
    const url = new URL(input instanceof Request ? input.url : input, location.href)
    if (url.origin === location.origin) return fetchResource(input, init)
    const origin = url.origin
    const scope = (init?.signal && direct.get(init.signal)) || 'producer'
    resourceEvent('fetch-start', scope, origin)
    if (scope === 'local-control') {
      // Hold the DOM and raster path constant while replacing only off-origin bytes.
      // These responses stay in memory, including for references to another loopback port.
      const css = url.hostname === 'fonts.googleapis.com' || url.pathname.endsWith('.css')
      resourceEvent('fetch-substitute', scope, origin)
      return css
        ? new Response('', { headers: { 'Content-Type': 'text/css' } })
        : new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', {
            headers: { 'Content-Type': 'image/svg+xml' },
          })
    }
    try {
      const response = await fetchResource(input, init)
      resourceEvent('fetch-end', scope, origin, { status: response.status })
      return response
    } catch (error) {
      resourceEvent('fetch-error', scope, origin, { error: errorText(error) })
      throw error
    }
  }
  document.addEventListener('securitypolicyviolation', (event) => {
    const blocked = URL.canParse(event.blockedURI) ? new URL(event.blockedURI).origin : event.blockedURI
    resourceEvent('csp', event.effectiveDirective, blocked)
  })

  async function directCapture(frame: Frame, scope: 'original' | 'local-control') {
    const start = clock()
    const signal = AbortSignal.timeout(4_000)
    direct.set(signal, scope)
    tracingRaster++
    record('direct-start', { scope, id: frame.id, name: frame.name, width: frame.width, height: frame.height })
    try {
      const { rasterizeFrame } = await import('../../src/lib/frameRaster')
      const scale = Math.min(1, 640 / Math.max(frame.width, frame.height))
      const blob = await rasterizeFrame(frame, { type: 'png', scale, signal, documentBackground: true })
      signal.throwIfAborted()
      const url = URL.createObjectURL(blob)
      try {
        const image = new Image()
        image.src = url
        await image.decode()
        signal.throwIfAborted()
        record('direct-ready', {
          scope,
          elapsedMs: clock() - start,
          width: image.naturalWidth,
          height: image.naturalHeight,
          bytes: blob.size + image.naturalWidth * image.naturalHeight * 4,
        })
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (error) {
      record('direct-error', { scope, elapsedMs: clock() - start, aborted: signal.aborted, error: errorText(error) })
    } finally {
      direct.delete(signal)
      tracingRaster--
    }
  }

  return {
    beforeGesture() {
      const images = [...document.querySelectorAll<HTMLImageElement>('[data-frame-snapshot]')]
      record('before-gesture', {
        slots: images.length,
        ready: images.filter(snapshotReady).length,
        blocked: images.filter((image) => image.hasAttribute('data-frame-snapshot-blocked')).length,
        moving: document.querySelector('.stage')?.hasAttribute('data-frame-camera-moving'),
        disabled: !!document.querySelector('[data-frame-snapshots-disabled]'),
        idleSupported: !!idle,
        idlePending: idleJobs.size,
      })
    },
    async finish(frames: Frame[]) {
      // Test the actual mounted sandbox, then run the same raster call directly, bypassing only the idle queue.
      const frame = frames.find(({ name }) => name.startsWith('Главная · 1920'))
      const iframe = frame
        ? document.querySelector<HTMLIFrameElement>(`[data-doop-frame-shell="${CSS.escape(frame.id)}"] iframe`)
        : null
      if (!frame || !iframe) {
        record('direct-unavailable', { foundFrame: !!frame, mounted: !!iframe })
        return trace
      }
      let running: Animation[] = []
      try {
        const animations = iframe.contentWindow!.document.getAnimations()
        running = animations.filter((animation) => animation.playState === 'running')
        running.forEach((animation) => animation.pause())
        await Promise.all(running.map((animation) => animation.ready))
        record('animation-access', {
          found: animations.length,
          paused: running.filter((a) => a.playState === 'paused').length,
        })
      } catch (error) {
        record('animation-access', { sandbox: iframe.sandbox.value, error: errorText(error) })
      } finally {
        running.forEach((animation) => animation.play())
      }

      await directCapture(frame, 'original')
      await directCapture(frame, 'local-control')
      // CSP events are delivered asynchronously after the rejected fetch.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      return trace
    },
  }
}
