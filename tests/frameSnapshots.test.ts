// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrameSnapshotCache, FrameSnapshots, canSnapshotFrame, holdSnapshotForPaint } from '../src/lib/frameSnapshots'
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

  function animationFrames() {
    const callbacks = new Map<number, FrameRequestCallback>()
    let id = 0
    return {
      callbacks,
      request: vi.fn((run: FrameRequestCallback) => {
        callbacks.set(++id, run)
        return id
      }),
      cancel: (id: number) => callbacks.delete(id),
      tick: async () => {
        for (const [id, run] of [...callbacks]) {
          if (callbacks.delete(id)) run(performance.now())
        }
        await vi.advanceTimersByTimeAsync(0)
      },
    }
  }

  function queue(
    zoom = 1,
    useOverview = false,
    idle?: typeof window.requestIdleCallback,
    frames?: ReturnType<typeof animationFrames>,
  ) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    vi.stubGlobal('requestIdleCallback', idle)
    vi.stubGlobal('requestAnimationFrame', frames?.request)
    vi.stubGlobal('cancelAnimationFrame', frames?.cancel)
    const stage = document.createElement('div')
    Object.defineProperties(stage, {
      clientWidth: { value: 1000 },
      clientHeight: { value: 800 },
    })
    const snapshots = new FrameSnapshots()
    const layer = document.createElement('div')
    if (useOverview) layer.setAttribute('data-frame-overview', '')
    const stop = snapshots.connect(layer, stage, () => ({ x: 0, y: 0, zoom }), useOverview)
    snapshots.update({ ...frame, x: 0, y: 0 } as Frame, new Image(), false)
    function move(moving: boolean) {
      stage.toggleAttribute('data-frame-camera-moving', moving)
      snapshots.wake()
    }
    function zoomTo(value: number) {
      zoom = value
      snapshots.setZoom(value)
    }
    return { snapshots, stage, layer, move, stop, zoomTo }
  }

  it('holds a ready snapshot over the newly acknowledged iframe through one paint opportunity', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const frames = animationFrames()
    vi.stubGlobal('requestAnimationFrame', frames.request)
    vi.stubGlobal('cancelAnimationFrame', frames.cancel)
    const image = new Image()
    const held = 'data-frame-snapshot-handoff'
    image.setAttribute('data-frame-snapshot-waiting', '')
    expect(holdSnapshotForPaint(image)).toBeUndefined()
    expect(frames.callbacks.size).toBe(0)
    image.setAttribute('data-frame-snapshot-ready', '')
    const stop = holdSnapshotForPaint(image)
    try {
      expect(image.hasAttribute(held)).toBe(true)
      await frames.tick()
      expect(image.hasAttribute(held)).toBe(true)
      await frames.tick()
      expect(image.hasAttribute(held)).toBe(false)
      expect(frames.callbacks.size).toBe(0)
    } finally {
      stop?.()
    }
    const cancel = holdSnapshotForPaint(image)
    cancel?.()
    expect(image.hasAttribute(held)).toBe(false)
    expect(frames.callbacks.size).toBe(0)

    image.removeAttribute('data-frame-snapshot-waiting')
    expect(holdSnapshotForPaint(image)).toBeUndefined()
    expect(frames.callbacks.size).toBe(0)
  })

  it('starts one first overview capture per frame and lets slow resources retry without a frame', async () => {
    const frames = animationFrames()
    const decode = vi.spyOn(Image.prototype, 'decode').mockResolvedValue(undefined)
    const raster = vi.mocked(rasterizeFrame).mockImplementation(async (_frame, { preview }) => {
      if (preview?.resourceBudgetMs !== undefined) preview.onResourceFailure?.()
      return new Blob(['bitmap'], { type: 'image/png' })
    })
    const { snapshots, stop } = queue(0.02, true, undefined, frames)
    const next = new Image()
    snapshots.update({ ...frame, id: 'next', x: 800, y: 0 } as Frame, next, false)
    snapshots.update({ ...frame, id: 'offscreen', x: 70_000, y: 0 } as Frame, new Image(), false)
    try {
      expect(raster).not.toHaveBeenCalled()
      expect(frames.callbacks.size).toBe(1)
      await frames.tick()
      expect(raster).toHaveBeenCalledTimes(1)
      expect(frames.callbacks.size).toBe(1)
      await frames.tick()
      expect(raster).toHaveBeenCalledTimes(2)
      expect(next.hasAttribute('data-frame-snapshot-ready')).toBe(true)
      expect(frames.callbacks.size).toBe(0)

      await vi.advanceTimersByTimeAsync(3600)
      expect(raster.mock.calls.slice(2).map(([, { preview }]) => preview?.resourceBudgetMs)).toEqual([
        undefined,
        undefined,
      ])
      expect(frames.callbacks.size).toBe(0)
    } finally {
      stop()
      decode.mockRestore()
    }
  })

  it.each(['camera', 'Present', 'disabled', 'hidden', 'leaving overview', 'page exit'] as const)(
    'cancels the queued overview frame on %s',
    async (pause) => {
      const frames = animationFrames()
      const raster = vi.mocked(rasterizeFrame).mockRejectedValue(new Error('capture failed'))
      const { snapshots, stage, layer, move, stop, zoomTo } = queue(0.02, true, undefined, frames)
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
      try {
        expect(frames.callbacks.size).toBe(1)
        if (pause === 'camera') move(true)
        if (pause === 'Present') stage.setAttribute('data-stage-presenting', '')
        if (pause === 'disabled') layer.setAttribute('data-frame-snapshots-disabled', '')
        if (pause === 'Present' || pause === 'disabled') snapshots.wake()
        if (pause === 'hidden') {
          hidden.mockReturnValue(true)
          document.dispatchEvent(new Event('visibilitychange'))
        }
        if (pause === 'leaving overview') {
          zoomTo(0.08)
          await Promise.resolve()
        }
        if (pause === 'page exit') stop()

        expect(frames.callbacks.size).toBe(0)
        await vi.advanceTimersByTimeAsync(80)
        expect(raster).toHaveBeenCalledTimes(pause === 'hidden' || pause === 'leaving overview' ? 1 : 0)
        expect(frames.callbacks.size).toBe(0)
      } finally {
        stop()
        hidden.mockRestore()
      }
    },
  )

  it('uses a timer when a frame does not arrive and after the initial fill window', async () => {
    const frames = animationFrames()
    const decode = vi.spyOn(Image.prototype, 'decode').mockResolvedValue(undefined)
    const raster = vi.mocked(rasterizeFrame).mockResolvedValue(new Blob(['bitmap'], { type: 'image/png' }))
    const { snapshots, stop } = queue(0.02, true, undefined, frames)
    try {
      expect(frames.callbacks.size).toBe(1)
      await vi.advanceTimersByTimeAsync(80)
      expect(raster).toHaveBeenCalledTimes(1)
      expect(frames.callbacks.size).toBe(0)

      await vi.advanceTimersByTimeAsync(4100)
      const next = new Image()
      snapshots.update({ ...frame, id: 'late', x: 800, y: 0 } as Frame, next, false)
      expect(frames.callbacks.size).toBe(0)
      await vi.advanceTimersByTimeAsync(80)
      expect(next.hasAttribute('data-frame-snapshot-ready')).toBe(true)
      expect(raster).toHaveBeenCalledTimes(2)
    } finally {
      stop()
      decode.mockRestore()
    }
  })

  it.each([0, 3])('finishes with only %i idle callbacks and cancels on Present or page exit', async (granted) => {
    const idle = vi.fn<typeof window.requestIdleCallback>()
    const cancelIdle = vi.fn()
    idle.mockImplementation((run) => {
      const id = idle.mock.calls.length
      if (id <= granted) window.setTimeout(() => run({ didTimeout: false, timeRemaining: () => 50 }), 0)
      return id
    })
    vi.stubGlobal('cancelIdleCallback', cancelIdle)
    const starts: number[] = []
    const decode = vi.spyOn(Image.prototype, 'decode').mockResolvedValue(undefined)
    const raster = vi.mocked(rasterizeFrame).mockImplementation(async () => {
      starts.push(performance.now())
      return new Blob(['bitmap'], { type: 'image/png' })
    })
    const { snapshots, stage, stop } = queue(0.02, true, idle)
    const images = []
    for (let i = 0; i < 5; i++) {
      const image = new Image()
      images.push(image)
      snapshots.update({ ...frame, id: `starved-${i}`, x: i * 800, y: 0 } as Frame, image, false)
    }
    try {
      await vi.advanceTimersByTimeAsync(240)
      expect(images.filter((image) => image.hasAttribute('data-frame-snapshot-ready'))).toHaveLength(5)
      expect(raster).toHaveBeenCalledTimes(6)
      expect(starts.slice(1).every((start, i) => start - starts[i]! >= 16)).toBe(true)

      snapshots.update({ ...frame, id: 'held', x: 0, y: 0 } as Frame, new Image(), false)
      stage.setAttribute('data-stage-presenting', '')
      snapshots.wake()
      await vi.advanceTimersByTimeAsync(4000)
      expect(raster).toHaveBeenCalledTimes(6)

      stage.removeAttribute('data-stage-presenting')
      snapshots.wake()
      const pendingIdle = idle.mock.results.at(-1)?.value
      stop()
      expect(cancelIdle).toHaveBeenCalledWith(pendingIdle)
      await vi.advanceTimersByTimeAsync(4000)
      expect(raster).toHaveBeenCalledTimes(6)
    } finally {
      stop()
      decode.mockRestore()
    }
  })

  it.each(['timer', 'animation frame'])('limits concurrent overview captures started by %s to three', async (turn) => {
    const raster = vi.mocked(rasterizeFrame).mockImplementation(
      (_frame, { signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const frames = turn === 'animation frame' ? animationFrames() : undefined
    const { snapshots, move, stop } = queue(0.02, true, undefined, frames)
    try {
      for (let i = 0; i < 4; i++) {
        snapshots.update({ ...frame, id: `overview-${i}`, x: i * 800, y: 0 } as Frame, new Image(), false)
      }
      if (frames) {
        await frames.tick()
        await frames.tick()
        await frames.tick()
        expect(frames.callbacks.size).toBe(1)
        await frames.tick()
        expect(frames.callbacks.size).toBe(1)
      } else await vi.advanceTimersByTimeAsync(80)
      expect(raster).toHaveBeenCalledTimes(3)
      expect(new Set(raster.mock.calls.map(([frame]) => frame.id)).size).toBe(3)
      move(true)
      if (frames) expect(frames.callbacks.size).toBe(0)
      await vi.advanceTimersByTimeAsync(80)
      expect(raster.mock.calls.every(([, { signal }]) => signal?.aborted)).toBe(true)
      expect(raster).toHaveBeenCalledTimes(3)
    } finally {
      stop()
    }
  })

  it('schedules the next frame while one capture is pending and stops once its snapshot is ready', async () => {
    const frames = animationFrames()
    const decode = vi.spyOn(Image.prototype, 'decode').mockResolvedValue(undefined)
    const bitmap = new Blob(['bitmap'], { type: 'image/png' })
    let complete: (bitmap: Blob) => void = () => {}
    const raster = vi.mocked(rasterizeFrame).mockReturnValue(new Promise((resolve) => (complete = resolve)))
    const { stop } = queue(0.02, true, undefined, frames)
    try {
      await frames.tick()
      expect(raster).toHaveBeenCalledOnce()
      expect(frames.callbacks.size).toBe(1)
      await frames.tick()
      expect(raster).toHaveBeenCalledOnce()
      expect(frames.callbacks.size).toBe(1)
      complete(bitmap)
      await vi.advanceTimersByTimeAsync(0)
      expect(frames.callbacks.size).toBe(0)
    } finally {
      complete(bitmap)
      stop()
      decode.mockRestore()
    }
  })

  it('cancels a stalled frame at four seconds even while its first capture is still pending', async () => {
    const frames = animationFrames()
    const raster = vi.mocked(rasterizeFrame).mockImplementation(
      (_frame, { signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const { stop } = queue(0.02, true, undefined, frames)
    try {
      await vi.advanceTimersByTimeAsync(31)
      expect(raster).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(raster).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(3967)
      expect(frames.callbacks.size).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(frames.callbacks.size).toBe(0)
      expect(raster).toHaveBeenCalledOnce()
      expect(raster.mock.calls[0]![1].signal?.aborted).toBe(false)
    } finally {
      stop()
    }
  })

  it('fills a cold overview before retrying slow resources at the overview density', async () => {
    const decode = vi.spyOn(Image.prototype, 'decode').mockResolvedValue(undefined)
    const width = vi.spyOn(Image.prototype, 'naturalWidth', 'get').mockReturnValue(120)
    const height = vi.spyOn(Image.prototype, 'naturalHeight', 'get').mockReturnValue(475)
    const bitmap = new Blob([new Uint8Array(96 * 1024)], { type: 'image/png' })
    const raster = vi.mocked(rasterizeFrame).mockImplementation(
      (_frame, { preview }) =>
        new Promise((resolve) => {
          const resourceDelay = 650
          const budget = preview?.resourceBudgetMs ?? Infinity
          window.setTimeout(
            () => {
              if (budget < resourceDelay) preview?.onResourceFailure?.()
              resolve(bitmap)
            },
            Math.min(resourceDelay, budget),
          )
        }),
    )
    vi.stubGlobal('devicePixelRatio', 2)
    const { snapshots, stop } = queue(0.02, true)
    const images = Array.from({ length: 40 }, () => new Image())
    try {
      for (const [i, image] of images.entries()) {
        snapshots.update(
          {
            ...frame,
            id: i === 0 ? 'a' : String(i),
            width: 1920,
            height: 7600,
            x: (i % 8) * 2200,
            y: Math.floor(i / 8) * 7800,
          } as Frame,
          image,
          false,
        )
      }
      await vi.advanceTimersByTimeAsync(4000)
      const ready = images.filter((image) => image.hasAttribute('data-frame-snapshot-ready')).length
      console.info('Synthetic 650 ms resource delay: ready at 4 s =', ready)
      expect(ready).toBe(40)
      const firstPass = images.map((image) => image.src)
      await vi.advanceTimersByTimeAsync(14_000)
      expect(images.every((image, i) => image.src !== firstPass[i])).toBe(true)
      expect(raster.mock.calls.filter(([, options]) => options.preview?.resourceBudgetMs === undefined)).toHaveLength(
        40,
      )
      // 1920 × 7600 at 2% on a 2x display needs at least 77 × 304 pixels.
      expect(new Set(raster.mock.calls.map(([, options]) => options.scale))).toEqual(new Set([0.0625]))
    } finally {
      stop()
      decode.mockRestore()
      width.mockRestore()
      height.mockRestore()
    }
  })

  it('starts a newly visible frame ahead of a retry that is already due', async () => {
    const decode = vi.spyOn(Image.prototype, 'decode').mockResolvedValue(undefined)
    const raster = vi.mocked(rasterizeFrame).mockImplementation(async (_frame, { preview }) => {
      if (preview?.resourceBudgetMs !== undefined) preview.onResourceFailure?.()
      return new Blob(['bitmap'], { type: 'image/png' })
    })
    const { snapshots, move, stop } = queue(0.02, true)
    try {
      await vi.advanceTimersByTimeAsync(40)
      move(true)
      await vi.advanceTimersByTimeAsync(3600)
      snapshots.update({ ...frame, id: 'new', x: 800, y: 0 } as Frame, new Image(), false)
      move(false)
      await vi.advanceTimersByTimeAsync(80)
      expect(raster.mock.calls.map(([item]) => item.id)).toEqual(['a', 'new', 'a'])
    } finally {
      stop()
      decode.mockRestore()
    }
  })

  it('starts with a reusable thumbnail when a heavy page opens zoomed in', async () => {
    const raster = vi.mocked(rasterizeFrame).mockRejectedValue(new Error('capture failed'))
    const { stop } = queue(0.13, true)
    try {
      await vi.advanceTimersByTimeAsync(20)
      expect(raster.mock.calls[0]?.[1].scale).toBe(0.125)
    } finally {
      stop()
    }
  })

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

  it.each([
    ['ordinary', false, 1],
    ['heavy', true, 0.085],
  ])('keeps the first image on a %s page when a higher-density image is evicted', async (_page, heavy, zoomedIn) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    vi.stubGlobal('requestIdleCallback', undefined)
    const decode = vi.spyOn(Image.prototype, 'decode').mockResolvedValue(undefined)
    const width = vi.spyOn(Image.prototype, 'naturalWidth', 'get').mockReturnValue(5000)
    const height = vi.spyOn(Image.prototype, 'naturalHeight', 'get').mockReturnValue(3000)
    vi.mocked(rasterizeFrame).mockResolvedValue(new Blob(['bitmap'], { type: 'image/png' }))
    const stage = document.createElement('div')
    const layer = document.createElement('div')
    Object.defineProperties(stage, { clientWidth: { value: 1000 }, clientHeight: { value: 800 } })
    const snapshots = new FrameSnapshots()
    const viewport = { x: 0, y: 0, zoom: 0.04 }
    const stop = snapshots.connect(layer, stage, () => viewport, heavy)
    const overview = new Image()
    try {
      // Only the detailed captures consume almost the whole detailed budget.
      width.mockReturnValueOnce(85)
      height.mockReturnValueOnce(38)
      snapshots.update({ ...frame, x: 0, y: 0 } as Frame, overview, false)
      await vi.advanceTimersByTimeAsync(40)
      const thumbnail = overview.getAttribute('src')
      expect(thumbnail).toBeTruthy()

      viewport.zoom = zoomedIn
      snapshots.setZoom(zoomedIn)
      snapshots.wake()
      await vi.advanceTimersByTimeAsync(40)
      expect(overview.getAttribute('src')).not.toBe(thumbnail)
      const detail = overview.getAttribute('src')

      stage.setAttribute('data-frame-camera-moving', 'zoom')
      viewport.zoom = 0.04
      snapshots.setZoom(0.04)
      await vi.advanceTimersByTimeAsync(20)
      expect(overview.getAttribute('src')).toBe(detail)
      stage.removeAttribute('data-frame-camera-moving')
      await vi.advanceTimersByTimeAsync(20)
      expect(overview.getAttribute('src')).toBe(thumbnail)

      viewport.x = -4000 * zoomedIn
      viewport.zoom = zoomedIn
      snapshots.setZoom(zoomedIn)
      snapshots.update({ ...frame, id: 'b', x: 4000, y: 0 } as Frame, new Image(), false)
      await vi.advanceTimersByTimeAsync(40)
      viewport.x = 0
      viewport.zoom = 0.04
      snapshots.setZoom(0.04)
      await Promise.resolve()
      expect(overview.getAttribute('src')).toBe(thumbnail)
      expect(overview.hasAttribute('data-frame-snapshot-ready')).toBe(true)
    } finally {
      stop()
      decode.mockRestore()
      width.mockRestore()
      height.mockRestore()
    }
  })
})
