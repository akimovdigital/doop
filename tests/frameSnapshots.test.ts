// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrameSnapshotCache, FrameSnapshots, canSnapshotFrame } from '../src/lib/frameSnapshots'
import { rasterizeFrame } from '../src/lib/frameRaster'
import type { Frame } from '../shared/types'

vi.mock('../src/lib/frameRaster', () => ({ rasterizeFrame: vi.fn() }))

const frame = { id: 'a', updatedAt: 1, html: '<h1>One</h1>', width: 680, height: 300 }
const eligible = { selected: false, editing: false, streaming: false, interacting: false, presenting: false }

describe('frame snapshots', () => {
  it.each([{ updatedAt: 2 }, { html: '<h1>Two</h1>' }, { width: 700 }, { height: 400 }])(
    'disposes the stale bitmap when the revision changes by %o',
    (change) => {
      const cache = new FrameSnapshotCache(100)
      const dispose = vi.fn()
      cache.set(frame, { bytes: 60, dispose })
      cache.touch({ ...frame })
      expect(dispose).not.toHaveBeenCalled()
      cache.touch({ ...frame, ...change })
      expect(dispose).toHaveBeenCalledOnce()
      cache.clear()
      expect(dispose).toHaveBeenCalledOnce()
    },
  )

  it('evicts by the byte limit in least recently used order and releases everything at teardown', () => {
    const cache = new FrameSnapshotCache(120)
    const a = vi.fn()
    const b = vi.fn()
    const c = vi.fn()
    const oversized = vi.fn()
    cache.set(frame, { bytes: 60, dispose: a })
    cache.set({ ...frame, id: 'b' }, { bytes: 50, dispose: b })
    cache.touch(frame)
    cache.set({ ...frame, id: 'c' }, { bytes: 60, dispose: c })
    expect(b).toHaveBeenCalledOnce()
    cache.set({ ...frame, id: 'oversized' }, { bytes: 121, dispose: oversized })
    expect(oversized).toHaveBeenCalledOnce()
    expect(a).not.toHaveBeenCalled()
    expect(c).not.toHaveBeenCalled()
    cache.clear()
    expect(a).toHaveBeenCalledOnce()
    expect(c).toHaveBeenCalledOnce()
  })

  it.each(['selected', 'editing', 'streaming', 'interacting', 'presenting'] as const)('excludes %s frames', (mode) => {
    expect(canSnapshotFrame(frame, eligible)).toBe(true)
    expect(canSnapshotFrame(frame, { ...eligible, [mode]: true })).toBe(false)
  })
})

describe('snapshot capture queue', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.mocked(rasterizeFrame).mockReset()
  })

  function queue() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    vi.stubGlobal('requestIdleCallback', undefined)
    const stage = document.createElement('div')
    Object.defineProperties(stage, {
      clientWidth: { value: 1000 },
      clientHeight: { value: 800 },
    })
    const snapshots = new FrameSnapshots()
    const stop = snapshots.connect(document.createElement('div'), stage, () => ({ x: 0, y: 0, zoom: 1 }))
    snapshots.update({ ...frame, x: 0, y: 0 } as Frame, new Image(), false)
    function move(moving: boolean) {
      stage.toggleAttribute('data-frame-camera-moving', moving)
      snapshots.wake()
    }
    return { snapshots, stage, move, stop }
  }

  it('retries at increasing intervals, waits for camera idle, and caps attempts', async () => {
    const raster = vi.mocked(rasterizeFrame).mockRejectedValue(new Error('capture failed'))
    const { move, stop } = queue()
    try {
      await vi.advanceTimersByTimeAsync(20)
      expect(raster).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(3000)
      expect(raster).toHaveBeenCalledTimes(1)
      move(true)
      await vi.advanceTimersByTimeAsync(4000)
      expect(raster).toHaveBeenCalledTimes(1)
      move(false)
      await vi.advanceTimersByTimeAsync(20)
      expect(raster).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(6000)
      expect(raster).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1500)
      expect(raster).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(15000)
      expect(raster).toHaveBeenCalledTimes(3)
    } finally {
      stop()
    }
  })

  it('aborts a running capture on camera movement and starts again without back-off', async () => {
    const raster = vi.mocked(rasterizeFrame).mockImplementation(
      (_frame, { signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const { move, stop } = queue()
    try {
      await vi.advanceTimersByTimeAsync(20)
      expect(raster).toHaveBeenCalledTimes(1)
      const signal = raster.mock.calls[0]![1].signal!
      move(true)
      await vi.advanceTimersByTimeAsync(100)
      expect(signal.aborted).toBe(true)
      expect(raster).toHaveBeenCalledTimes(1)
      move(false)
      await vi.advanceTimersByTimeAsync(20)
      expect(raster).toHaveBeenCalledTimes(2)
    } finally {
      stop()
    }
  })

  it('backs off when the overall deadline expires', async () => {
    const raster = vi
      .mocked(rasterizeFrame)
      .mockImplementationOnce(
        (_frame, { signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
      )
      .mockRejectedValue(new Error('capture failed'))
    const { stop } = queue()
    try {
      await vi.advanceTimersByTimeAsync(3999)
      const signal = raster.mock.calls[0]![1].signal!
      expect(signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(30)
      expect(signal.aborted).toBe(true)
      expect(raster).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(3600)
      expect(raster).toHaveBeenCalledTimes(2)
    } finally {
      stop()
    }
  })
})
