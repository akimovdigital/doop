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

const NEAR_PX = 180
export const FRAME_SNAPSHOT_TINY_PX = 160
export const FRAME_OVERVIEW_MAX_ZOOM = 0.06
const MIN_BITMAP_DENSITY = 0.125
const MAX_BITMAP_EDGE = 8192
const MAX_BITMAP_PIXELS = 2_400_000
const CAPTURE_TIMEOUT_MS = 4000
const CAPTURE_DEADLINE = Symbol('snapshot deadline')
const RETRY_DELAYS_MS = [3500, 7000]

type Slot = {
  frame: Frame
  image: HTMLImageElement
  attempts: number
  retryAt: number
  near: boolean
  captured: boolean
  density: number
  requestedDensity: number
}

function resetAttempts(slot: Slot) {
  slot.attempts = 0
  slot.retryAt = 0
  slot.captured = false
  slot.density = 0
  slot.requestedDensity = 0
}

function snapshotDensity(frame: Frame, zoom: number, dpr: number) {
  // The next bucket supplies headroom for small zoom gestures without
  // repeatedly rasterizing the same document.
  const desired = 2 ** Math.ceil(Math.log2(zoom * dpr * 1.25))
  return Math.min(
    Math.max(MIN_BITMAP_DENSITY, desired),
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

function onIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run)
    return () => window.cancelIdleCallback(id)
  }
  const id = window.setTimeout(run, 16)
  return () => window.clearTimeout(id)
}

/** One producer per mounted page. The DOM attributes change independently of React. */
export class FrameSnapshots {
  private readonly cache = new FrameSnapshotCache()
  private readonly slots = new Map<string, Slot>()
  private readonly ready = new Set<Slot>()
  private cancelIdle: (() => void) | undefined
  private retryTimer: number | undefined
  private pending: { slot: Slot; abort: AbortController } | undefined
  private stage: HTMLElement | undefined
  private layer: HTMLElement | undefined
  private zoom = 1
  private viewport: (() => Viewport) | undefined

  connect(layer: HTMLElement, stage: HTMLElement, viewport: () => Viewport) {
    this.layer = layer
    this.stage = stage
    this.viewport = viewport
    this.zoom = viewport().zoom
    const motion = new MutationObserver(() => {
      if (!stage.hasAttribute('data-frame-camera-moving')) {
        for (const slot of this.ready) this.updateTiny(slot)
      }
      this.wake()
    })
    motion.observe(stage, { attributes: true, attributeFilter: ['data-frame-camera-moving'] })
    const root = document.documentElement
    let colorScheme = root.style.colorScheme
    const theme = new MutationObserver(() => {
      if (root.style.colorScheme === colorScheme) return
      colorScheme = root.style.colorScheme
      this.pending?.abort.abort()
      this.cache.clear()
      for (const slot of this.slots.values()) resetAttempts(slot)
      this.wake()
    })
    theme.observe(root, { attributes: true, attributeFilter: ['style'] })
    const size = new ResizeObserver(() => this.wake())
    size.observe(stage)
    this.wake()
    return () => {
      motion.disconnect()
      theme.disconnect()
      size.disconnect()
      this.stage = this.layer = this.viewport = undefined
      this.cancelIdle?.()
      this.cancelIdle = undefined
      window.clearTimeout(this.retryTimer)
      this.retryTimer = undefined
      this.pending?.abort.abort()
      this.cache.clear()
      for (const slot of this.slots.values()) resetAttempts(slot)
    }
  }

  update(frame: Frame, image: HTMLImageElement, changing: boolean) {
    const slot = this.slots.get(frame.id)
    if (slot && slot.image === image) {
      if (changing || !sameRevision(slot.frame, frame)) {
        this.cache.delete(frame.id)
        if (this.pending?.slot === slot) this.pending.abort.abort()
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
        density: 0,
        requestedDensity: 0,
      })
    }
    this.wake()
  }

  remove(id: string) {
    if (this.pending?.slot === this.slots.get(id)) this.pending?.abort.abort()
    this.cache.delete(id)
    this.slots.delete(id)
  }

  private updateTiny({ frame, image }: Slot) {
    image.toggleAttribute('data-frame-snapshot-tiny', frame.width * this.zoom < FRAME_SNAPSHOT_TINY_PX)
  }

  setZoom(zoom: number) {
    if (this.zoom === zoom) return
    const previous = this.zoom
    this.zoom = zoom
    const dpr = window.devicePixelRatio || 1
    for (const { density, image } of this.ready) {
      if (density >= previous * dpr !== density >= zoom * dpr) {
        image.toggleAttribute('data-frame-snapshot-sharp', density >= zoom * dpr)
      }
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

  wake() {
    window.clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    if (this.paused()) {
      this.cancelIdle?.()
      this.cancelIdle = undefined
      this.pending?.abort.abort()
      return
    }
    if (this.pending?.slot.image.hasAttribute('data-frame-snapshot-blocked')) this.pending.abort.abort()
    if (this.cancelIdle || this.pending) return
    this.cancelIdle = onIdle(() => {
      this.cancelIdle = undefined
      if (this.paused()) return
      const slot = this.nextSlot()
      if (slot) void this.capture(slot)
    })
  }

  private nextSlot() {
    if (!this.stage || !this.viewport) return
    const { x, y, zoom } = this.viewport()
    const width = this.stage.clientWidth
    const height = this.stage.clientHeight
    if (!width || !height) return
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
      const density = snapshotDensity(frame, zoom, window.devicePixelRatio || 1)
      // A zoomed-out overview can afford thumbnails for frames evicted at
      // a higher density, even if those frames remained near the camera.
      if (near && slot.captured && !slot.density && (!slot.near || density < slot.requestedDensity)) resetAttempts(slot)
      slot.near = near
      if (!near) continue
      const area =
        Math.max(0, Math.min(width, right) - Math.max(0, left)) *
        Math.max(0, Math.min(height, bottom) - Math.max(0, top))
      if (area > 0) this.cache.touch(frame)
      if (image.hasAttribute('data-frame-snapshot-blocked')) continue
      if (density > slot.requestedDensity && (!slot.density || density > slot.density)) {
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
        Number(!!slot.density) < Number(!!next.density) ||
        (!!slot.density === !!next.density &&
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
    const abort = new AbortController()
    this.pending = { slot, abort }
    const timeout = window.setTimeout(() => abort.abort(CAPTURE_DEADLINE), CAPTURE_TIMEOUT_MS)
    const started = performance.now()
    let url: string | undefined
    let resourceFailure = false
    try {
      const { rasterizeFrame } = await import('./frameRaster')
      abort.signal.throwIfAborted()
      const scale = slot.requestedDensity
      const blob = await rasterizeFrame(frame, {
        type: 'png',
        scale,
        signal: abort.signal,
        documentBackground: true,
        preview: {
          onResourceFailure: () => (resourceFailure = true),
          // Previewing an unloaded frame must not compete for a live iframe slot.
          skipDeferredDocument: true,
        },
      })
      abort.signal.throwIfAborted()
      url = URL.createObjectURL(blob)
      const decoded = await decodeSnapshot(url, abort.signal)
      abort.signal.throwIfAborted()
      if (this.paused() || image.hasAttribute('data-frame-snapshot-blocked')) return

      const cachedUrl = url
      image.src = cachedUrl
      this.cache.set(frame, {
        bytes: decoded.naturalWidth * decoded.naturalHeight * 4 + blob.size,
        dispose: () => {
          if (image.getAttribute('src') === cachedUrl) {
            this.ready.delete(slot)
            slot.density = 0
            image.removeAttribute('data-frame-snapshot-ready')
            image.removeAttribute('data-frame-snapshot-sharp')
            image.removeAttribute('src')
          }
          URL.revokeObjectURL(cachedUrl)
        },
      })
      url = undefined
      this.ready.add(slot)
      slot.captured = true
      slot.density = scale
      image.toggleAttribute('data-frame-snapshot-sharp', scale >= this.zoom * (window.devicePixelRatio || 1))
      this.updateTiny(slot)
      image.setAttribute('data-frame-snapshot-ready', `${started}:${performance.now()}`)
      finishAttempt(slot, resourceFailure)
    } catch {
      // Camera movement and revision changes do not spend a retry.
      if (!abort.signal.aborted || abort.signal.reason === CAPTURE_DEADLINE) finishAttempt(slot, true)
    } finally {
      window.clearTimeout(timeout)
      if (url) URL.revokeObjectURL(url)
      this.pending = undefined
      this.wake()
    }
  }
}
