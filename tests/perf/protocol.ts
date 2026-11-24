import type { Viewport } from '../../src/lib/store'
import type { intervalStats } from '../../src/perf/metrics'
import type { liveDocuments } from '../../src/perf/documents'
import type { FramePreset } from './scene'

export const scenarios = [
  'pan',
  'scroll',
  'zoom',
  'zoom-wide',
  'zoom-out-wide',
  'drag1',
  'drag10',
  'open',
  'fly-over',
] as const
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
export type CaptureActivity = {
  pending: number
  started: number
  maxPending: number
  maxRasterEdge: number
}

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

export type WebContentFootprint = {
  points: { atMs: number; pid: number; bytes: number; lifetimePeakBytes: number }[]
  maxFootprintBytes: number | null
  samplingError?: string
  rendererPoints?: {
    atMs: number
    receivedAtMs: number
    phase: string | null
    camera: Viewport
    live: Sample['live']['before']
    layoutZoom: number
    iframeCssPixels: number
    readySnapshots: number
    overview?: boolean
    captures?: CaptureActivity | null
    internalsLayerTreeAvailable: boolean
    hostLayers: { count: number; maxWidth: number; maxHeight: number }
  }[]
}

export type CaptureRegion = { x: number; y: number; width: number; height: number }
export type Capture = {
  directory: string
  points: { file: string; atMs: number; receivedAtMs: number }[]
  regions?: Record<'left' | 'right' | 'stage', CaptureRegion>
  error?: string
  analysis?: {
    flagged: number
    panelsFlagged: number
    wholeUiFlagged: number
    framesDuringGesture: number
    sheet: string
    report: string
  }
}

type ProbeDiagnostics = { webContent?: WebContentFootprint; capture?: Capture }

export type ProbeFailure = {
  webContentTermination?: string
  benchError?: string
}

export type RunSample = (Sample | ProbeFailure) & ProbeDiagnostics

export function completedSample(sample: RunSample): sample is Sample & ProbeDiagnostics {
  return 'frames' in sample
}
