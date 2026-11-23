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
const TINY_PX = 160
const MAX_BITMAP_EDGE = 640
const CAPTURE_TIMEOUT_MS = 4000

type Slot = { frame: Frame; image: HTMLImageElement; attempted: boolean; near: boolean }

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
        this.zoom = viewport().zoom
        for (const slot of this.ready) this.updateTiny(slot)
      }
      this.wake()
    })
    motion.observe(stage, { attributes: true, attributeFilter: ['data-frame-camera-moving'] })
    const size = new ResizeObserver(() => this.wake())
    size.observe(stage)
    this.wake()
    return () => {
      motion.disconnect()
      size.disconnect()
      this.stage = this.layer = this.viewport = undefined
      this.cancelIdle?.()
      this.cancelIdle = undefined
      this.pending?.abort.abort()
      this.cache.clear()
      for (const slot of this.slots.values()) slot.attempted = false
    }
  }

  update(frame: Frame, image: HTMLImageElement, changing: boolean) {
    const slot = this.slots.get(frame.id)
    if (slot && slot.image === image) {
      if (changing || !sameRevision(slot.frame, frame)) {
        this.cache.delete(frame.id)
        if (this.pending?.slot === slot) this.pending.abort.abort()
        slot.attempted = false
      }
      slot.frame = frame
    } else {
      this.remove(frame.id)
      this.slots.set(frame.id, { frame, image, attempted: false, near: false })
    }
    this.wake()
  }

  remove(id: string) {
    if (this.pending?.slot === this.slots.get(id)) this.pending?.abort.abort()
    this.cache.delete(id)
    this.slots.delete(id)
  }

  private updateTiny({ frame, image }: Slot) {
    image.toggleAttribute('data-frame-snapshot-tiny', frame.width * this.zoom < TINY_PX)
  }

  private paused() {
    return (
      !this.stage ||
      this.stage.hasAttribute('data-frame-camera-moving') ||
      this.layer?.hasAttribute('data-frame-snapshots-disabled')
    )
  }

  wake() {
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
    for (const slot of this.slots.values()) {
      const { frame, image } = slot
      const box = rotatedBounds(frame, frame.rotation ?? 0)
      const left = box.x * zoom + x
      const top = box.y * zoom + y
      const right = left + box.width * zoom
      const bottom = top + box.height * zoom
      const near = right >= -NEAR_PX && bottom >= -NEAR_PX && left <= width + NEAR_PX && top <= height + NEAR_PX
      // An evicted frame can get a fresh snapshot when the camera returns to it.
      if (near && !slot.near && !this.ready.has(slot)) slot.attempted = false
      slot.near = near
      if (!near || image.hasAttribute('data-frame-snapshot-blocked')) continue
      const area =
        Math.max(0, Math.min(width, right) - Math.max(0, left)) *
        Math.max(0, Math.min(height, bottom) - Math.max(0, top))
      if (area > 0) this.cache.touch(frame)
      if (!slot.attempted && area > bestArea) {
        bestArea = area
        next = slot
      }
    }
    return next
  }

  private async capture(slot: Slot) {
    const { frame, image } = slot
    const abort = new AbortController()
    this.pending = { slot, abort }
    const timeout = window.setTimeout(() => abort.abort('timeout'), CAPTURE_TIMEOUT_MS)
    const started = performance.now()
    let url: string | undefined
    try {
      const { rasterizeFrame } = await import('./frameRaster')
      abort.signal.throwIfAborted()
      const scale = Math.min(1, MAX_BITMAP_EDGE / Math.max(frame.width, frame.height))
      const blob = await rasterizeFrame(frame, { type: 'png', scale, signal: abort.signal, documentBackground: true })
      abort.signal.throwIfAborted()
      url = URL.createObjectURL(blob)
      image.src = url
      await image.decode()
      abort.signal.throwIfAborted()
      if (this.paused() || image.hasAttribute('data-frame-snapshot-blocked')) return

      const cachedUrl = url
      this.cache.set(frame, {
        bytes: image.naturalWidth * image.naturalHeight * 4 + blob.size,
        dispose: () => {
          this.ready.delete(slot)
          image.removeAttribute('data-frame-snapshot-ready')
          image.removeAttribute('src')
          URL.revokeObjectURL(cachedUrl)
        },
      })
      url = undefined
      this.ready.add(slot)
      this.updateTiny(slot)
      image.setAttribute('data-frame-snapshot-ready', `${started}:${performance.now()}`)
      slot.attempted = true
    } catch {
      // Unsupported resources, timeouts and tainted captures leave the live document in place.
      // Camera movement and revision changes can retry after the next idle period.
      if (!abort.signal.aborted || abort.signal.reason === 'timeout') slot.attempted = true
    } finally {
      window.clearTimeout(timeout)
      if (url) {
        image.removeAttribute('src')
        URL.revokeObjectURL(url)
      }
      this.pending = undefined
      this.wake()
    }
  }
}
