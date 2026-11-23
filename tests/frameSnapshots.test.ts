import { describe, expect, it, vi } from 'vitest'
import { FrameSnapshotCache, canSnapshotFrame } from '../src/lib/frameSnapshots'

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
