import { describe, expect, it, vi } from 'vitest'
import { loadPerfHud } from '../../src/perf/hudFlag'
import { frameIntervals, intervalStats, nearestRank } from '../../src/perf/metrics'
import { trajectory } from './gesture'
import { noiseFloor, pairRejectionReasons, rejectionReasons, verdict } from './judgment'
import { cameraRange, initialCamera, type Sample } from './protocol'
import { framePresets, makeRealScene, makeScene } from './scene'

function trial(): Sample {
  const camera = initialCamera('pan')
  const range = cameraRange([camera, { ...camera, y: 155 }])
  return {
    scenario: 'pan',
    scene: { frames: 68, expectedLive: 41, seed: 1 },
    browser: { userAgent: 'fixture', width: 1280, height: 800, dpr: 2, visibility: 'visible' },
    elapsedMs: 3000,
    openMs: null,
    frames: { p50: 16, p95: 17, max: 20, intervals: 180, longFrames: 0 },
    inputEvents: 120,
    plannedInputs: 120,
    cameraSteps: 98,
    camera: { actual: range, expected: range, final: camera, expectedFinal: camera },
    drag: null,
    commits: { count: 0, actualDuration: 0 },
    heapBytes: null,
    live: { before: { mounted: 41, ready: 41 }, after: { mounted: 41, ready: 41 } },
    memory: { before: { Swapins: 5, Swapouts: 10 }, after: { Swapins: 9, Swapouts: 10 } },
  }
}

describe('canvas benchmark', () => {
  it('uses differences between rAF arguments and nearest-rank percentiles', () => {
    expect(frameIntervals([90, 106, 122, 172])).toEqual([16, 16, 50])
    expect(intervalStats([90, 106, 122, 172])).toEqual({ p50: 16, p95: 50, max: 50, intervals: 3, longFrames: 1 })
    expect(nearestRank([9, 4, 1, 5], 50)).toBe(4)
    expect(nearestRank([], 95)).toBeNull()
    expect(
      nearestRank(
        Array.from({ length: 20 }, (_, index) => index + 1),
        95,
      ),
    ).toBe(19)
  })

  it('rejects swap noise, wrong camera trajectory and changed live counts', () => {
    expect(rejectionReasons(trial(), 4)).toEqual([])
    const sample = trial()
    sample.memory.after = { Swapins: 10, Swapouts: 11 }
    sample.camera.actual = { ...sample.camera.actual, y: [162, 235] }
    sample.live.after.ready--
    expect(rejectionReasons(sample, 4)).toEqual([
      'Swapouts grew by 1 pages',
      'Swapins grew by 5 pages (limit 4)',
      'Camera y range or endpoint differs from the script',
      'Live documents after: 41/40, expected 41',
    ])
    sample.cameraSteps = 50
    expect(pairRejectionReasons(trial(), sample)).toEqual([
      'A/B ready-document counts differ',
      'A/B camera y ranges differ',
      'A/B camera step counts differ: 98 vs 50',
    ])
  })

  it('accepts different fully ready document budgets on the same exported scene', () => {
    const a = trial()
    const b = trial()
    a.scene = { frames: 40, expectedLive: 17, source: 'test-scene', sha256: 'test-hash' }
    b.scene = { ...a.scene, expectedLive: 5 }
    a.live = { before: { mounted: 17, ready: 17 }, after: { mounted: 18, ready: 18 } }
    b.live = { before: { mounted: 5, ready: 5 }, after: { mounted: 6, ready: 6 } }
    expect(rejectionReasons(a, 256)).toEqual([])
    expect(rejectionReasons(b, 256)).toEqual([])
    expect(pairRejectionReasons(a, b)).toEqual([])
    b.live.after.ready--
    expect(rejectionReasons(b, 256)).toEqual(['Live documents after: 6 mounted, 5 ready'])
    b.scene.sha256 = 'different-hash'
    expect(pairRejectionReasons(a, b)).toEqual(['A/B scenario or scene differs'])
    expect(pairRejectionReasons(a, trial())).toContain('A/B scenario or scene differs')
  })

  it('imports exported frames in stable drag order on the fixture page', () => {
    const frame = { y: 0, width: 300, height: 100, html: '<p>Fixture</p>', pageId: 'exported-page' }
    const frames = [
      { ...frame, x: 900, id: 'right' },
      { ...frame, x: 0, id: 'left-b' },
      { ...frame, x: 0, id: 'left-a' },
    ]
    const scene = makeRealScene({ source: 'fixture', exportedAt: '2026-11-23', frames }, 'hash')
    expect(scene.frames.map(({ id }) => id)).toEqual(['left-a', 'left-b', 'right'])
    expect(scene.frames[0]).toMatchObject({ canvasId: 'perf-canvas', pageId: undefined, html: '<p>Fixture</p>' })
    expect(frames[0]?.pageId).toBe('exported-page')
    expect(() => makeRealScene({ source: 'fixture', frames: [frames[0], frames[0]] }, 'hash')).toThrow('duplicate')
  })

  it('allows an explicit inclusive swapout limit', () => {
    const sample = trial()
    sample.memory.after.Swapouts += 8
    expect(rejectionReasons(sample, 256)).toEqual(['Swapouts grew by 8 pages'])
    expect(rejectionReasons(sample, 256, 8)).toEqual([])
    expect(rejectionReasons(sample, 256, 7)).toEqual(['Swapouts grew by 8 pages'])
  })

  it('compares explicit document budgets while still rejecting partially booted documents', () => {
    const base = trial()
    const candidate = trial()
    candidate.liveBudget = 20
    candidate.live = { before: { mounted: 20, ready: 20 }, after: { mounted: 20, ready: 20 } }
    expect(rejectionReasons(candidate, 4)).toEqual([])
    expect(pairRejectionReasons(base, candidate)).toEqual([])
    candidate.live.after.ready = 19
    expect(rejectionReasons(candidate, 4)).toEqual(['Live documents after: 20/19, expected 20'])
    expect(pairRejectionReasons(base, candidate)).toEqual(['A/B ready-document counts differ'])
  })

  it('requires agreement across pairs and a median outside the A/A noise floor', () => {
    const floor = noiseFloor([-2, 0, 1, 2, -1])
    expect(floor).toBe(2)
    expect(verdict([-3, -4, -4, -5, 1], floor, 5)).toBe('win')
    expect(verdict([3, 4, 4, 5, -1], floor, 5)).toBe('regression')
    expect(verdict([-3, -4, -4, 1, 2], floor, 5)).toBe('no change')
    expect(verdict([-2, -2, -2, -2, -2], floor, 5)).toBe('no change')
    expect(verdict([-4, -4, -4, -4], floor, 5)).toBe('insufficient data')
  })

  it('uses held zoom extremes and distinct zoom-wide bounds', () => {
    const zoom = trajectory('zoom', 880, initialCamera('zoom'), { x: 680, y: 420 })
    expect(zoom.expected.zoom[1]).toBeCloseTo(0.1002165)
    expect(zoom.points[20]!.at - zoom.points[19]!.at).toBe(60)
    expect(zoom.expectedFinal.zoom).toBe(0.055)
    const wide = trajectory('zoom-wide', 3000, initialCamera('zoom-wide'), { x: 680, y: 420 })
    expect(wide.expected.zoom[1]).toBeCloseTo(0.6)
  })

  it('generates deterministic local documents and only two animations per scene', () => {
    for (const count of framePresets) {
      const scene = makeScene(count)
      expect(scene).toEqual(makeScene(count))
      expect(scene.frames).toHaveLength(count)
      expect(scene.frames.filter(({ html }) => html.includes('@keyframes'))).toHaveLength(2)
      expect(scene.frames.filter(({ height }) => height === 2200)).toMatchObject([{ width: 800 }])
      expect(scene.frames[0]?.html).not.toBe(makeScene(count, 1).frames[0]?.html)
    }
  })

  it('does not load the HUD or schedule its rAF by default', () => {
    const raf = vi.fn()
    const load = vi.fn(() => raf())
    const storage = { getItem: vi.fn(() => null as string | null) }
    expect(loadPerfHud('', storage, load)).toBeUndefined()
    expect(loadPerfHud('?perfHud=0', storage, load)).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
    expect(raf).not.toHaveBeenCalled()
    loadPerfHud('?perfHud=1', storage, load)
    storage.getItem.mockReturnValue('1')
    loadPerfHud('', storage, load)
    expect(raf).toHaveBeenCalledTimes(2)
  })
})
