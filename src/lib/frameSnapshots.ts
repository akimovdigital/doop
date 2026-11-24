import { rotatedBounds } from '../../shared/frameRotation'
import type { Frame } from '../../shared/types'
import type { Viewport } from './store'

type Revision = Pick<Frame, 'id' | 'updatedAt' | 'html' | 'width' | 'height'>

function sameRevision(a: Revision, b: Revision): boolean {
  return a.updatedAt === b.updatedAt && a.html === b.html && a.width === b.width && a.height === b.height
}

type Bitmap = { bytes: number; dispose: () => void }

/** Charge both the decoded RGBA surface and the encoded image backing its URL. */
export class FrameSnapshotCache {
  private readonly entries = new Map<string, { revision: Revision; bitmap: Bitmap }>()
  private bytes = 0

  constructor(private readonly budget = 64 * 1024 * 1024) {}

  touch(frame: Revision) {
    const entry = this.entries.get(frame.id)
    if (!entry) return
    if (!sameRevision(entry.revision, frame)) {
      this.delete(frame.id)
      return
    }
    this.entries.delete(frame.id)
    this.entries.set(frame.id, entry)
  }

  set(frame: Revision, bitmap: Bitmap) {
    this.delete(frame.id)
    if (bitmap.bytes > this.budget) {
      bitmap.dispose()
      return
    }
    this.entries.set(frame.id, { revision: frame, bitmap })
    this.bytes += bitmap.bytes
    for (const id of this.entries.keys()) {
      if (this.bytes <= this.budget) break
      this.delete(id)
    }
  }

  delete(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    this.bytes -= entry.bitmap.bytes
    entry.bitmap.dispose()
  }

  clear() {
    for (const id of this.entries.keys()) this.delete(id)
  }
}

export function canSnapshotFrame(
  frame: Pick<Frame, 'browser' | 'hidden' | 'html' | 'width' | 'height'>,
  {
    selected,
    editing,
    streaming,
    interacting,
    presenting,
  }: Record<'selected' | 'editing' | 'streaming' | 'interacting' | 'presenting', boolean>,
): boolean {
  return (
    !frame.browser &&
    !frame.hidden &&
    !!frame.html &&
    frame.width > 0 &&
    frame.height > 0 &&
    !(selected || editing || streaming || interacting || presenting)
  )
}

/** Keep a decoded preview above the iframe for a rendering opportunity after its HTML ACK. */
export function holdSnapshotForPaint(image: HTMLImageElement) {
  if (!image.matches('[data-frame-snapshot-ready][data-frame-snapshot-waiting]')) return
  if (image.closest('[data-frame-snapshots-disabled]')) return
  image.setAttribute('data-frame-snapshot-handoff', '')
  const release = () => {
    window.cancelAnimationFrame(frame)
    image.removeAttribute('data-frame-snapshot-handoff')
  }
  let frame = window.requestAnimationFrame(() => {
    frame = window.requestAnimationFrame(release)
  })
  return release
}

const NEAR_PX = 180
export const FRAME_SNAPSHOT_TINY_PX = 160
export const FRAME_OVERVIEW_MAX_ZOOM = 0.06
export const FRAME_CAMERA_SETTLE_MS = 220
const MIN_BITMAP_DENSITY = 0.125
const MIN_OVERVIEW_DENSITY = 1 / 32
const THUMBNAIL_CACHE_BYTES = 32 * 1024 * 1024
const OVERVIEW_CAPTURE_LIMIT = 3
const FIRST_OVERVIEW_RESOURCE_MS = 60
const FIRST_OVERVIEW_FRAME_WINDOW_MS = 4000
const CAPTURE_INTERVAL_MS = 16
const CAPTURE_TURN_FALLBACK_MS = 32
const MAX_BITMAP_EDGE = 8192
const MAX_BITMAP_PIXELS = 2_400_000
const CAPTURE_TIMEOUT_MS = 4000
const CAPTURE_DEADLINE = Symbol('snapshot deadline')
const RETRY_DELAYS_MS = [3500, 7000]

type Snapshot = { url: string; density: number; readyAt: string }

type Slot = {
  frame: Frame
  image: HTMLImageElement
  attempts: number
  retryAt: number
  near: boolean
  captured: boolean
  captureStarted: boolean
  thumbnail?: Snapshot
  detail?: Snapshot
  displayed?: Snapshot
  requestedDensity: number
}

function resetAttempts(slot: Slot) {
  slot.attempts = 0
  slot.retryAt = 0
  slot.captured = false
  slot.requestedDensity = 0
}

function snapshotDensity(frame: Frame, zoom: number, dpr: number, minimum = MIN_BITMAP_DENSITY) {
  // The next bucket supplies headroom for small zoom gestures without
  // repeatedly rasterizing the same document.
  const desired = 2 ** Math.ceil(Math.log2(zoom * dpr * 1.25))
  return Math.min(
    Math.max(minimum, desired),
    MAX_BITMAP_EDGE / Math.max(frame.width, frame.height),
    Math.sqrt(MAX_BITMAP_PIXELS / (frame.width * frame.height)),
  )
}

function finishAttempt(slot: Slot, retry: boolean) {
  const delay = retry ? RETRY_DELAYS_MS[slot.attempts] : undefined
  slot.attempts++
  slot.retryAt = delay === undefined ? Infinity : performance.now() + delay
}

function decodeSnapshot(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const image = new Image()
    const cancel = () => {
      image.removeAttribute('src')
      reject(signal.reason)
    }
    signal.addEventListener('abort', cancel, { once: true })
    image.src = url
    void image
      .decode()
      .then(() => resolve(image), reject)
      .finally(() => {
        signal.removeEventListener('abort', cancel)
      })
  })
}

function onCaptureTurn(run: () => void, waitingForFrame: boolean): () => void {
  const canIdle = !waitingForFrame && typeof window.requestIdleCallback === 'function'
  const earliest = performance.now() + CAPTURE_INTERVAL_MS
  let idle: number | undefined
  let timer = window.setTimeout(finish, canIdle || waitingForFrame ? CAPTURE_TURN_FALLBACK_MS : CAPTURE_INTERVAL_MS)

  function cancel() {
    window.clearTimeout(timer)
    if (idle !== undefined) window.cancelIdleCallback(idle)
  }

  function finish() {
    cancel()
    run()
  }

  if (canIdle) {
    // A busy renderer can stop granting idle time even while timers still run.
    idle = window.requestIdleCallback(() => {
      idle = undefined
      const wait = earliest - performance.now()
      if (wait <= 0) finish()
      else {
        window.clearTimeout(timer)
        timer = window.setTimeout(finish, Math.ceil(wait))
      }
    })
  }
  return cancel
}

/** One producer per mounted page. The DOM attributes change independently of React. */
export class FrameSnapshots {
  private readonly cache = new FrameSnapshotCache()
  private readonly thumbnails = new FrameSnapshotCache(THUMBNAIL_CACHE_BYTES)
  private readonly slots = new Map<string, Slot>()
  private readonly ready = new Set<Slot>()
  private cancelCaptureTurn: (() => void) | undefined
  private retryTimer: number | undefined
  private firstOverviewUntil: number | undefined
  private overviewFrame: number | undefined
  private overviewDeadline: number | undefined
  private firstOverviewPending = 0
  private readonly pending = new Map<Slot, AbortController>()
  private stage: HTMLElement | undefined
  private layer: HTMLElement | undefined
  private zoom = 1
  private viewport: (() => Viewport) | undefined
  private useOverview = false

  connect(layer: HTMLElement, stage: HTMLElement, viewport: () => Viewport, useOverview = false) {
    this.layer = layer
    this.stage = stage
    this.viewport = viewport
    this.useOverview = useOverview
    this.zoom = viewport().zoom
    if (useOverview) this.firstOverviewUntil ??= performance.now() + FIRST_OVERVIEW_FRAME_WINDOW_MS
    const motion = new MutationObserver(() => {
      if (!stage.hasAttribute('data-frame-camera-moving')) {
        for (const slot of this.ready) {
          this.display(slot)
          this.updateTiny(slot)
        }
      }
      this.wake()
    })
    motion.observe(stage, { attributes: true, attributeFilter: ['data-frame-camera-moving'] })
    const root = document.documentElement
    let colorScheme = root.style.colorScheme
    const theme = new MutationObserver(() => {
      if (root.style.colorScheme === colorScheme) return
      colorScheme = root.style.colorScheme
      for (const abort of this.pending.values()) abort.abort()
      this.cache.clear()
      this.thumbnails.clear()
      for (const slot of this.slots.values()) resetAttempts(slot)
      this.wake()
    })
    theme.observe(root, { attributes: true, attributeFilter: ['style'] })
    const size = new ResizeObserver(() => this.wake())
    size.observe(stage)
    const visibility = () => {
      if (document.hidden) this.cancelScheduledCapture()
      this.wake()
    }
    if (useOverview) document.addEventListener('visibilitychange', visibility)
    this.wake()
    return () => {
      motion.disconnect()
      theme.disconnect()
      size.disconnect()
      if (useOverview) document.removeEventListener('visibilitychange', visibility)
      this.stage = this.layer = this.viewport = undefined
      this.cancelScheduledCapture()
      this.cancelOverviewFrame()
      window.clearTimeout(this.retryTimer)
      this.retryTimer = undefined
      for (const abort of this.pending.values()) abort.abort()
      this.cache.clear()
      this.thumbnails.clear()
      for (const slot of this.slots.values()) resetAttempts(slot)
    }
  }

  update(frame: Frame, image: HTMLImageElement, changing: boolean) {
    const slot = this.slots.get(frame.id)
    if (slot && slot.image === image) {
      if (changing || !sameRevision(slot.frame, frame)) {
        this.cache.delete(frame.id)
        this.thumbnails.delete(frame.id)
        this.pending.get(slot)?.abort()
        resetAttempts(slot)
      }
      slot.frame = frame
    } else {
      this.remove(frame.id)
      this.slots.set(frame.id, {
        frame,
        image,
        attempts: 0,
        retryAt: 0,
        near: false,
        captured: false,
        captureStarted: false,
        requestedDensity: 0,
      })
    }
    this.wake()
  }

  remove(id: string) {
    const slot = this.slots.get(id)
    if (slot) this.pending.get(slot)?.abort()
    this.cache.delete(id)
    this.thumbnails.delete(id)
    this.slots.delete(id)
    if (!this.slots.size) {
      this.cancelScheduledCapture()
      this.cancelOverviewFrame()
    }
  }

  private updateTiny({ frame, image }: Slot) {
    image.toggleAttribute('data-frame-snapshot-tiny', frame.width * this.zoom < FRAME_SNAPSHOT_TINY_PX)
  }

  setZoom(zoom: number) {
    if (this.zoom === zoom) return
    this.zoom = zoom
    // Stage marks the gesture in the same store dispatch. Wait for that
    // write before deciding whether to replace a displayed bitmap.
    queueMicrotask(() => {
      if (!this.stage || this.zoom !== zoom) return
      const moving = this.stage.hasAttribute('data-frame-camera-moving')
      for (const slot of this.ready) {
        if (moving) this.updateSharp(slot)
        else this.display(slot)
      }
      this.wake()
    })
  }

  private display(slot: Slot) {
    const { image, thumbnail, detail } = slot
    const requiredDensity = this.zoom * (window.devicePixelRatio || 1)
    const bitmap =
      this.zoom <= FRAME_OVERVIEW_MAX_ZOOM && thumbnail && thumbnail.density >= requiredDensity
        ? thumbnail
        : (detail ?? thumbnail)
    if (slot.displayed !== bitmap) {
      slot.displayed = bitmap
      if (bitmap) {
        image.src = bitmap.url
        image.setAttribute('data-frame-snapshot-ready', bitmap.readyAt)
        this.ready.add(slot)
        this.updateTiny(slot)
      } else {
        this.ready.delete(slot)
        image.removeAttribute('src')
        image.removeAttribute('data-frame-snapshot-ready')
      }
    }
    this.updateSharp(slot, requiredDensity)
  }

  private updateSharp({ image, displayed }: Slot, requiredDensity = this.zoom * (window.devicePixelRatio || 1)) {
    const sharp = !!displayed && displayed.density >= requiredDensity
    if (image.hasAttribute('data-frame-snapshot-sharp') !== sharp) {
      image.toggleAttribute('data-frame-snapshot-sharp', sharp)
    }
  }

  private paused() {
    return (
      !this.stage ||
      this.stage.hasAttribute('data-stage-presenting') ||
      this.stage.hasAttribute('data-frame-camera-moving') ||
      this.layer?.hasAttribute('data-frame-snapshots-disabled')
    )
  }

  private cancelScheduledCapture() {
    this.cancelCaptureTurn?.()
    this.cancelCaptureTurn = undefined
  }

  private canRunOverviewFrames() {
    return (
      this.inOverview() &&
      !document.hidden &&
      performance.now() < (this.firstOverviewUntil ?? 0) &&
      typeof window.requestAnimationFrame === 'function'
    )
  }

  private scheduleOverviewFrame() {
    if (this.overviewFrame !== undefined) return
    this.overviewDeadline ??= window.setTimeout(
      () => this.cancelOverviewFrame(),
      (this.firstOverviewUntil ?? 0) - performance.now(),
    )
    this.overviewFrame = window.requestAnimationFrame(() => {
      this.overviewFrame = undefined
      // The timer, capture completion and camera observers wake the queue for
      // work. Keep the frame chain cheap when it is only waiting for a capture.
      if (!this.cancelCaptureTurn && this.firstOverviewPending && this.canRunOverviewFrames() && !this.paused()) {
        this.scheduleOverviewFrame()
        return
      }
      this.scheduleNextCapture(true)
    })
  }

  private cancelOverviewFrame() {
    if (this.overviewFrame !== undefined) window.cancelAnimationFrame(this.overviewFrame)
    window.clearTimeout(this.overviewDeadline)
    this.overviewFrame = this.overviewDeadline = undefined
  }

  private inOverview() {
    return this.useOverview && this.zoom <= FRAME_OVERVIEW_MAX_ZOOM
  }

  private hasCaptureCapacity() {
    return this.pending.size < (this.inOverview() ? OVERVIEW_CAPTURE_LIMIT : 1)
  }

  wake() {
    this.scheduleNextCapture(false)
  }

  private scheduleNextCapture(fromFrame: boolean) {
    window.clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    if (this.paused()) {
      this.cancelScheduledCapture()
      this.cancelOverviewFrame()
      for (const abort of this.pending.values()) abort.abort()
      return
    }
    for (const [slot, abort] of this.pending) {
      if (slot.image.hasAttribute('data-frame-snapshot-blocked')) abort.abort()
    }
    const withFrames = this.canRunOverviewFrames()
    const slot = withFrames && this.hasCaptureCapacity() ? this.nextSlot() : undefined
    const first = slot && !slot.captureStarted ? slot : undefined
    // Keep giving CEF rendering opportunities even while the queue is full.
    if (withFrames && (first || this.firstOverviewPending)) this.scheduleOverviewFrame()
    else this.cancelOverviewFrame()

    if (fromFrame && first) {
      this.cancelScheduledCapture()
      void this.capture(first)
    }
    // A frame that did not start a capture leaves the timer's deadline alone.
    if (withFrames && !slot) {
      this.cancelScheduledCapture()
      return
    }
    if (this.cancelCaptureTurn || !this.hasCaptureCapacity() || !this.slots.size) return
    this.cancelCaptureTurn = onCaptureTurn(() => {
      this.cancelCaptureTurn = undefined
      if (this.paused() || !this.hasCaptureCapacity()) return
      const slot = this.nextSlot()
      if (!slot) return
      void this.capture(slot)
      this.wake()
    }, !!first)
  }

  private nextSlot() {
    if (!this.stage || !this.viewport) return
    const { x, y, zoom } = this.viewport()
    const width = this.stage.clientWidth
    const height = this.stage.clientHeight
    if (!width || !height) return
    const dpr = window.devicePixelRatio || 1
    const overview = this.useOverview && zoom <= FRAME_OVERVIEW_MAX_ZOOM
    const thumbnailFits = overview && zoom * dpr <= MIN_BITMAP_DENSITY
    let next: Slot | undefined
    let bestArea = -1
    let bestDistance = Infinity
    let nextRetry = Infinity
    const now = performance.now()
    for (const slot of this.slots.values()) {
      const { frame, image } = slot
      const box = rotatedBounds(frame, frame.rotation ?? 0)
      const left = box.x * zoom + x
      const top = box.y * zoom + y
      const right = left + box.width * zoom
      const bottom = top + box.height * zoom
      const near = right >= -NEAR_PX && bottom >= -NEAR_PX && left <= width + NEAR_PX && top <= height + NEAR_PX
      const zoomDensity = snapshotDensity(frame, zoom, dpr, overview ? MIN_OVERVIEW_DENSITY : MIN_BITMAP_DENSITY)
      const density =
        thumbnailFits || (this.useOverview && !slot.displayed) ? Math.min(zoomDensity, MIN_BITMAP_DENSITY) : zoomDensity
      const availableDensity = Math.max(slot.detail?.density ?? 0, slot.thumbnail?.density ?? 0)
      if (near && slot.captured && density > availableDensity && (!slot.near || density < slot.requestedDensity)) {
        resetAttempts(slot)
      }
      slot.near = near
      if (!near) continue
      const area =
        Math.max(0, Math.min(width, right) - Math.max(0, left)) *
        Math.max(0, Math.min(height, bottom) - Math.max(0, top))
      if (area > 0) {
        this.cache.touch(frame)
        this.thumbnails.touch(frame)
      }
      if (this.pending.has(slot) || image.hasAttribute('data-frame-snapshot-blocked')) continue
      if (density > slot.requestedDensity && density > availableDensity) {
        slot.attempts = 0
        slot.retryAt = 0
        slot.requestedDensity = density
      }
      if (slot.retryAt > now) {
        nextRetry = Math.min(nextRetry, slot.retryAt)
        continue
      }
      const distance = Math.hypot(
        Math.max(left - width / 2, width / 2 - right, 0),
        Math.max(top - height / 2, height / 2 - bottom, 0),
      )
      if (
        !next ||
        Number(!!slot.displayed) < Number(!!next.displayed) ||
        (!!slot.displayed === !!next.displayed &&
          (slot.attempts < next.attempts ||
            (slot.attempts === next.attempts && (area > bestArea || (area === bestArea && distance < bestDistance)))))
      ) {
        bestArea = area
        bestDistance = distance
        next = slot
      }
    }
    if (!next && Number.isFinite(nextRetry)) this.retryTimer = window.setTimeout(() => this.wake(), nextRetry - now)
    return next
  }

  private async capture(slot: Slot) {
    const { frame, image } = slot
    const firstOverviewCapture = this.inOverview() && !slot.captureStarted
    if (firstOverviewCapture) this.firstOverviewPending++
    slot.captureStarted = true
    const abort = new AbortController()
    this.pending.set(slot, abort)
    const timeout = window.setTimeout(() => abort.abort(CAPTURE_DEADLINE), CAPTURE_TIMEOUT_MS)
    const started = performance.now()
    let url: string | undefined
    let resourceFailure = false
    try {
      const { rasterizeFrame } = await import('./frameRaster')
      abort.signal.throwIfAborted()
      const scale = slot.requestedDensity
      const firstOverview = this.useOverview && !slot.displayed && slot.attempts === 0
      const blob = await rasterizeFrame(frame, {
        type: 'png',
        scale,
        signal: abort.signal,
        documentBackground: true,
        preview: {
          onResourceFailure: () => (resourceFailure = true),
          // Previewing an unloaded frame must not compete for a live iframe slot.
          skipDeferredDocument: true,
          resourceBudgetMs: firstOverview ? FIRST_OVERVIEW_RESOURCE_MS : undefined,
        },
      })
      abort.signal.throwIfAborted()
      url = URL.createObjectURL(blob)
      const decoded = await decodeSnapshot(url, abort.signal)
      abort.signal.throwIfAborted()
      if (this.paused() || image.hasAttribute('data-frame-snapshot-blocked')) return

      // Keep the inexpensive overview bitmap across upgrades and detailed
      // evictions so a return to the overview doesn't show an empty frame.
      const key =
        scale <= MIN_BITMAP_DENSITY && (!this.useOverview || !slot.thumbnail || scale <= slot.thumbnail.density)
          ? 'thumbnail'
          : 'detail'
      const cache = key === 'thumbnail' ? this.thumbnails : this.cache
      const bitmap = { url, density: scale, readyAt: `${started}:${performance.now()}` }
      const install = {
        bytes: decoded.naturalWidth * decoded.naturalHeight * 4 + blob.size,
        dispose: () => {
          if (slot[key] === bitmap) {
            delete slot[key]
            this.display(slot)
          }
          URL.revokeObjectURL(bitmap.url)
        },
      }
      slot[key] = bitmap
      cache.set(frame, install)
      url = undefined
      slot.captured = true
      this.display(slot)
      finishAttempt(slot, resourceFailure)
    } catch {
      // Camera movement and revision changes do not spend a retry.
      if (!abort.signal.aborted || abort.signal.reason === CAPTURE_DEADLINE) finishAttempt(slot, true)
    } finally {
      window.clearTimeout(timeout)
      if (url) URL.revokeObjectURL(url)
      this.pending.delete(slot)
      if (firstOverviewCapture) this.firstOverviewPending--
      this.wake()
    }
  }
}
