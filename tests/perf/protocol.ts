import type { Viewport } from '../../src/lib/store'
import type { intervalStats } from '../../src/perf/metrics'
import type { liveDocuments } from '../../src/perf/documents'
import type { FramePreset } from './scene'

export const scenarios = ['pan', 'zoom', 'zoom-wide', 'drag1', 'drag10', 'open', 'fly-over'] as const
export type Scenario = (typeof scenarios)[number]
export const windowSize = { width: 1280, height: 800, dpr: 2 }
export const defaultDuration = 3000
export const realReadyTimeout = 90_000
export const initialCamera = (scenario: Scenario): Viewport => ({
  x: 420,
  y: 235,
  zoom: scenario === 'zoom-wide' ? 0.05 : 0.055,
})

export type Memory = { Swapins: number; Swapouts: number }
export type Axes = Record<keyof Viewport, [number, number]>

export function cameraRange(points: readonly Viewport[]): Axes {
  const range = (axis: keyof Viewport): [number, number] => {
    const values = points.map((point) => point[axis])
    return [Math.min(...values), Math.max(...values)]
  }
  return { x: range('x'), y: range('y'), zoom: range('zoom') }
}

export type SceneIdentity = { source: string; sha256: string }

export interface Sample {
  scenario: Scenario
  scene: { expectedLive: number } & (
    { frames: FramePreset; seed: number } | ({ frames: number; openReadyMs?: number } & SceneIdentity)
  )
  browser: { userAgent: string; width: number; height: number; dpr: number; visibility: string }
  elapsedMs: number
  openMs: number | null
  frames: ReturnType<typeof intervalStats>
  settle?: {
    maxMs: number | null
    intervals: number
    layoutChanges?: number
    deferredPeak?: number
    maxDriftPx?: number
  }
  inputEvents: number
  plannedInputs: number
  cameraSteps: number
  camera: { actual: Axes; expected: Axes; final: Viewport; expectedFinal: Viewport }
  drag: { expected: number; moved: number } | null
  commits: { count: number; actualDuration: number }
  live: { before: ReturnType<typeof liveDocuments>; after: ReturnType<typeof liveDocuments> }
  liveBudget?: number
  animationBudget?: number
  animationAllowed?: { before: number; after: number }
  flyOver?: { peakMounted: number; visited: number; peakAnimationAllowed?: number }
  webContentRssKiB?: number
  snapshots?: { ready: number; elapsedMs: number | null; captureMs: number[] }
  snapshotDiagnostics?: { at: number; event: string; data: object }[]
  heapBytes: number | null
  memory: { before: Memory; after: Memory }
}
