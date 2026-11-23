import { Profiler, useLayoutEffect, type ProfilerOnRenderCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { CanvasPage } from '../../src/pages/CanvasPage'
import { TooltipProvider } from '../../src/components/ui/tooltip'
import { hasFrameDocument } from '../../src/lib/frameBridge'
import { useStore, type Viewport } from '../../src/lib/store'
import { liveDocuments } from '../../src/perf/documents'
import { loadPerfHud } from '../../src/perf/hudFlag'
import { intervalStats } from '../../src/perf/metrics'
import { dragPoint, trajectory } from './gesture'
import {
  cameraRange,
  defaultDuration,
  initialCamera,
  realReadyTimeout,
  scenarios,
  type Memory,
  type Sample,
  type Scenario,
} from './protocol'
import { canvasId, framePresets, makeRealScene, makeScene } from './scene'
import '../../src/styles.css'

type Scene = ReturnType<typeof makeScene> | ReturnType<typeof makeRealScene>
const harness = {
  seed: ({ frames }: Scene) =>
    useStore
      .getState()
      .setCanvas({ id: canvasId, name: 'Performance canvas', frames, role: 'edit', createdAt: 0, updatedAt: 0 }),
  setCamera: (viewport: Viewport) => useStore.getState().setViewport(viewport),
  getCamera: () => useStore.getState().viewport,
  watchCamera: (record: (camera: Viewport) => void) =>
    useStore.subscribe((next, prev) => {
      if (next.viewport !== prev.viewport) record(next.viewport)
    }),
  hasFrameDocument,
  liveDocuments,
  commits: { count: 0, actualDuration: 0 },
}

declare global {
  interface Window {
    perfBench: typeof harness
    perfBenchResult: Promise<Sample>
    perfBenchPhase?: string
  }
}
window.perfBench = harness

const recordCommit: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  harness.commits.count++
  harness.commits.actualDuration += actualDuration
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
const settleWindowMs = 600

function FixtureCamera({ viewport }: { viewport: Viewport }) {
  // Stage fits the page in its layout effect. Run after it, before admission's first rAF.
  useLayoutEffect(() => harness.setCamera(viewport), [viewport])
  return null
}

async function vmStat(initial = false): Promise<Memory> {
  const response = await fetch(initial ? '/__memory?initial=1' : '/__memory', { cache: 'no-store' })
  if (!response.ok) throw new Error(`vm_stat sample failed: HTTP ${response.status}`)
  return (await response.json()) as Memory
}

function recordFrames() {
  const times: number[] = []
  let handle = requestAnimationFrame(tick)
  function tick(time: number) {
    times.push(time)
    handle = requestAnimationFrame(tick)
  }
  return { times, stop: () => cancelAnimationFrame(handle) }
}

async function waitGeneratedReady(scene: ReturnType<typeof makeScene>) {
  const until = performance.now() + 23_000
  while (performance.now() < until) {
    const counts = liveDocuments()
    if (
      document.querySelectorAll('[data-doop-frame-shell]').length === scene.frames.length &&
      counts.mounted === scene.live &&
      counts.ready === scene.live &&
      scene.frames.slice(0, scene.live).every((frame) => hasFrameDocument(frame.id))
    ) {
      await nextFrame()
      await nextFrame()
      return
    }
    await sleep(30)
  }
  const stage = document.querySelector('.stage')
  throw new Error(
    `Expected ${scene.frames.length} shells and ${scene.live} live documents; found ${document.querySelectorAll('[data-doop-frame-shell]').length} shells and ${JSON.stringify(liveDocuments())} at camera ${JSON.stringify(harness.getCamera())}, stage ${stage?.clientWidth}×${stage?.clientHeight}`,
  )
}

function snapshotStats(): NonNullable<Sample['snapshots']> {
  const times = [...document.querySelectorAll<HTMLElement>('[data-frame-snapshot-ready]')].map((image) => {
    const [start, end] = (image.dataset.frameSnapshotReady ?? '').split(':')
    return { start: Number(start), end: Number(end) }
  })
  return {
    ready: times.length,
    elapsedMs: times.length
      ? Math.max(...times.map(({ end }) => end)) - Math.min(...times.map(({ start }) => start))
      : null,
    captureMs: times.map(({ start, end }) => end - start),
  }
}

async function warmSnapshots(expected: number | (() => number), timeout = 3500) {
  const deadline = performance.now() + timeout
  while (
    performance.now() < deadline &&
    document.querySelectorAll('[data-frame-snapshot-ready]').length <
      (typeof expected === 'number' ? expected : expected())
  )
    await sleep(25)
}

const realSnapshotTimeout = 8_000

async function waitReady(scene: Scene, phase: string) {
  if ('seed' in scene) {
    await waitGeneratedReady(scene)
    return scene.live
  }

  const until = performance.now() + realReadyTimeout
  let stableSince = performance.now()
  let previous: HTMLIFrameElement[] | null = null
  let shells = 0
  let counts = liveDocuments()
  let pending: (string | null)[] = []
  while (performance.now() < until) {
    const now = performance.now()
    shells = document.querySelectorAll('[data-doop-frame-shell]').length
    const documents = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[data-doop-frame]'))
    pending = documents
      .map((iframe) => iframe.closest('[data-doop-frame-shell]')?.getAttribute('data-doop-frame-shell') ?? null)
      .filter((id) => !id || !hasFrameDocument(id))
    counts = { mounted: documents.length, ready: documents.length - pending.length }
    if (
      shells !== scene.frames.length ||
      pending.length ||
      !previous ||
      documents.length !== previous.length ||
      documents.some((iframe, index) => iframe !== previous![index])
    ) {
      stableSince = now
    } else if (now - stableSince >= 1500) {
      return counts.ready
    }
    previous = documents
    await sleep(50)
  }
  throw new Error(
    `Real scene ${phase} did not settle within ${realReadyTimeout} ms: ${shells}/${scene.frames.length} shells, ` +
      `${counts.mounted} mounted and ${counts.ready} ready; pending IDs: ${pending.join(', ') || 'none'}; ` +
      `camera ${JSON.stringify(harness.getCamera())}`,
  )
}

async function fetchScene() {
  const response = await fetch('/__scene.json', { cache: 'no-store' })
  if (!response.ok) throw new Error(`Scene export request failed: HTTP ${response.status}`)
  const sha256 = response.headers.get('X-Scene-SHA256')
  if (!sha256) throw new Error('Scene export has no SHA-256 identity')
  return makeRealScene(await response.json(), sha256)
}

function pointer(target: EventTarget, type: string, x: number, y: number) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: x,
      clientY: y,
      button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerup' ? 0 : 1,
      altKey: true,
    }),
  )
}

function prepareGesture(scenario: Scenario, scene: Scene, duration: number) {
  const initial = initialCamera(scenario)
  const stage = document.querySelector<HTMLElement>('.stage')
  if (!stage) throw new Error('Stage did not mount')
  const wheelTarget = stage
  const box = stage.getBoundingClientRect()
  const client = scenario === 'zoom-wide' ? { x: 520, y: 295 } : { x: 680, y: 420 }
  const plan = trajectory(scenario, duration, initial, { x: client.x - box.left, y: client.y - box.top })
  const dragCount = scenario === 'drag10' ? 10 : scenario === 'drag1' ? 1 : 0
  const originals = scene.frames.slice(0, dragCount)
  if (originals.length !== dragCount) throw new Error(`Drag needs ${dragCount} frames; export has ${originals.length}`)
  const title = dragCount
    ? stage.querySelector(`[data-doop-frame-shell="${CSS.escape(originals[0]!.id)}"] [data-frame-title]`)
    : null
  if (dragCount && !title) throw new Error('Drag title did not mount')
  const titleBox = title?.getBoundingClientRect()
  const origin = { x: Math.round(titleBox?.left ?? 0) + 4, y: Math.round(titleBox?.top ?? 0) + 4 }
  const reset = () => {
    harness.setCamera(initial)
    for (const { id, x, y } of originals) useStore.getState().patchFrameLocal(id, { x, y })
  }

  async function drive() {
    let inputEvents = 0
    let latest = 0
    const start = performance.now()
    if (title) {
      pointer(title, 'pointerdown', origin.x, origin.y)
      inputEvents++
    }
    for (const point of plan.points) {
      const delay = start + point.at - performance.now()
      if (delay > 0) await sleep(delay)
      if (title) {
        const delta = dragPoint(point.position)
        pointer(window, 'pointermove', origin.x + delta.x, origin.y + delta.y)
      } else {
        const delta = point.position - latest
        wheelTarget.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: client.x,
            clientY: client.y,
            ctrlKey: scenario !== 'pan',
            deltaY: scenario === 'pan' ? delta * 80 : -delta * plan.zoomDelta * 100,
          }),
        )
      }
      latest = point.position
      inputEvents++
    }
    await sleep(Math.max(0, start + duration - performance.now()))
    if (title) {
      const delta = dragPoint(latest)
      pointer(window, 'pointerup', origin.x + delta.x, origin.y + delta.y)
      inputEvents++
    }
    await nextFrame()
    await nextFrame()
    const offset = dragPoint(latest)
    const current = useStore.getState().canvas?.frames ?? []
    const moved = originals.filter((original) => {
      const frame = current.find((entry) => entry.id === original.id)
      return (
        frame?.x === Math.round(original.x + offset.x / initial.zoom) &&
        frame.y === Math.round(original.y + offset.y / initial.zoom)
      )
    }).length
    return {
      inputEvents,
      plannedInputs: plan.points.length + (title ? 2 : 0),
      drag: dragCount ? { expected: dragCount, moved } : null,
    }
  }
  return { ...plan, drive, reset, select: () => useStore.getState().selectMany(originals.map(({ id }) => id)) }
}

// Keep the established motion trajectory and time its release separately. The
// ordinary zoom exercises a reusable layout scale, the wide zoom a cold raise.
async function measureSettle(scenario: 'zoom' | 'zoom-wide'): Promise<Sample['settle']> {
  const warm = scenario === 'zoom'
  const world = document.querySelector<HTMLElement>('.world')!
  const iframe = world.querySelector<HTMLIFrameElement>('[data-doop-frame-shell="f0"] iframe')!
  if (!iframe) throw new Error('Settle probe requires the first live iframe')
  const target = warm ? 1.5 : 2
  const from = warm ? 2 : 0.7
  harness.setCamera({ x: 50, y: 50, zoom: from })
  await sleep(600)
  for (let step = 1; step < 8; step++) {
    harness.setCamera({ x: 50, y: 50, zoom: from + ((target - from) * step) / 8 })
    await nextFrame()
  }

  const release = performance.now()
  harness.setCamera({ x: 50, y: 50, zoom: target })
  const first = await nextFrame()
  const before = iframe.getBoundingClientRect()
  let layout = world.style.zoom
  let layoutChanges = 0
  let maxDriftPx = 0
  let deferredPeak = 0
  const times = [first]
  while (times.at(-1)! < release + settleWindowMs) {
    times.push(await nextFrame())
    if (world.style.zoom === layout) continue
    layout = world.style.zoom
    layoutChanges++
    deferredPeak = Math.max(
      deferredPeak,
      world.querySelectorAll('[data-frame-layout-root][style*="content-visibility: hidden"]').length,
    )
    const after = iframe.getBoundingClientRect()
    maxDriftPx = Math.max(
      maxDriftPx,
      ...(['x', 'y', 'width', 'height'] as const).map((key) => Math.abs(after[key] - before[key])),
    )
  }
  const { max, intervals } = intervalStats(times)
  return { maxMs: max, intervals, layoutChanges, maxDriftPx, deferredPeak }
}

async function run(): Promise<Sample> {
  const query = new URLSearchParams(location.search)
  const scenario = scenarios.find((value) => value === query.get('scenario')) ?? 'zoom'
  const frames = framePresets.find((value) => value === Number(query.get('frames'))) ?? 68
  const duration = Number(query.get('duration') ?? defaultDuration)
  const real = query.get('scene') === 'real'
  const diagnostics = query.has('diagnoseSnapshots')
    ? (await import('./snapshotDiagnostics')).traceSnapshots()
    : undefined
  const initial = initialCamera(scenario)
  const open = scenario === 'open'
  const phase = (name: string) => {
    if (real) window.perfBenchPhase = name
  }
  const generated = real ? null : makeScene(frames)
  const endOpenFrames = open ? recordFrames() : null
  phase('fetching export')
  const scene = generated ?? (await fetchScene())
  const browser = {
    userAgent: navigator.userAgent,
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
    visibility: document.visibilityState,
  }
  harness.seed(scene)
  const canvas = (
    <TooltipProvider>
      <CanvasPage canvasId={canvasId} />
      <FixtureCamera viewport={initial} />
    </TooltipProvider>
  )
  const hud = await loadPerfHud(location.search, localStorage, () => import('../../src/perf/PerfHud'))
  // One profiler in either mode; the HUD can observe this same tree.
  const tree = hud ? (
    <hud.PerfHud onRender={recordCommit}>{canvas}</hud.PerfHud>
  ) : (
    <Profiler id="root" onRender={recordCommit}>
      {canvas}
    </Profiler>
  )
  phase('opening canvas')
  createRoot(document.getElementById('root')!).render(tree)
  const initialLive = await waitReady(scene, 'after opening')
  const openReadyMs = real ? performance.now() : undefined

  const sceneMeta = (expectedLive: number): Sample['scene'] =>
    'seed' in scene
      ? { frames, expectedLive, seed: scene.seed }
      : { frames: scene.frames.length, expectedLive, source: scene.source, sha256: scene.sha256, openReadyMs }
  const heap = () =>
    (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null
  if (endOpenFrames) {
    phase('sampling open counters')
    const openMs = openReadyMs ?? performance.now()
    const counts = liveDocuments()
    endOpenFrames.stop()
    const stats = intervalStats(endOpenFrames.times)
    const commits = { ...harness.commits }
    const after = await vmStat()
    const before = await vmStat(true)
    return {
      scenario,
      scene: sceneMeta(initialLive),
      browser,
      elapsedMs: openMs,
      openMs,
      frames: stats,
      inputEvents: 0,
      plannedInputs: 0,
      cameraSteps: 0,
      camera: {
        actual: cameraRange([harness.getCamera()]),
        expected: cameraRange([initial]),
        final: harness.getCamera(),
        expectedFinal: initial,
      },
      drag: null,
      commits,
      live: { before: counts, after: counts },
      heapBytes: heap(),
      memory: { before, after },
    }
  }

  const cameraGesture = scenario === 'pan' || scenario === 'zoom' || scenario === 'zoom-wide'
  if (cameraGesture && !real) await warmSnapshots(initialLive)
  phase('warm-up gesture')
  const warm = prepareGesture(scenario, scene, 900)
  warm.select()
  await nextFrame()
  await warm.drive()
  warm.reset()
  await sleep(500)
  phase('settling after warm-up')
  const expectedLive = await waitReady(scene, 'after warm-up reset')
  if (cameraGesture && real) {
    phase('warming snapshots before measurement')
    // Admission can mount more documents after the camera has settled.
    await warmSnapshots(() => Math.max(expectedLive, liveDocuments().mounted), realSnapshotTimeout)
  }
  phase('measured gesture')
  const gesture = prepareGesture(scenario, scene, duration)
  const before = await vmStat()
  const snapshots = cameraGesture ? snapshotStats() : undefined
  diagnostics?.beforeGesture()
  const start = performance.now()
  const startCamera = harness.getCamera()
  const observed = [startCamera]
  const liveBefore = liveDocuments()
  harness.commits.count = 0
  harness.commits.actualDuration = 0
  const recordRealSettle = real && cameraGesture
  let lastCameraUpdate: number | undefined
  const off = harness.watchCamera((point) => {
    observed.push(point)
    if (recordRealSettle) lastCameraUpdate = performance.now()
  })
  const measuredFrames = recordFrames()
  const input = await gesture.drive()
  const stats = intervalStats(measuredFrames.times)
  if (!recordRealSettle) {
    measuredFrames.stop()
    off()
  }
  const elapsedMs = performance.now() - start
  const final = harness.getCamera()
  const cameraSteps = observed.length - 1
  const actualCamera = cameraRange(observed)
  const commits = { ...harness.commits }
  const liveAfter = liveDocuments()
  phase('sampling gesture counters')
  const heapBytes = heap()
  let settle: Sample['settle']
  if (recordRealSettle) {
    phase('sampling camera settle')
    // Observe the actual release, including frames that arrived while drive() was finishing.
    while (lastCameraUpdate !== undefined && measuredFrames.times.at(-1)! < lastCameraUpdate + settleWindowMs)
      await nextFrame()
    measuredFrames.stop()
    off()
    const releasedAt = lastCameraUpdate ?? Infinity
    const windowEnd = measuredFrames.times.findIndex((time) => time >= releasedAt + settleWindowMs)
    const settleTimes = measuredFrames.times.slice(0, windowEnd + 1).filter((time) => time >= releasedAt)
    const { max, intervals } = intervalStats(settleTimes)
    settle = { maxMs: max, intervals }
  } else if (scenario === 'zoom' || scenario === 'zoom-wide') {
    settle = await measureSettle(scenario)
  }
  const after = await vmStat()
  if (diagnostics) phase('diagnosing snapshots')
  const snapshotDiagnostics = diagnostics ? await diagnostics.finish(scene.frames) : undefined
  return {
    scenario,
    scene: sceneMeta(expectedLive),
    browser,
    ...(settle ? { settle } : {}),
    elapsedMs,
    openMs: null,
    frames: stats,
    ...input,
    cameraSteps,
    camera: { actual: actualCamera, expected: gesture.expected, final, expectedFinal: gesture.expectedFinal },
    commits,
    live: { before: liveBefore, after: liveAfter },
    heapBytes,
    snapshots,
    ...(snapshotDiagnostics ? { snapshotDiagnostics } : {}),
    memory: { before, after },
  }
}

window.perfBenchResult = run().then(async (sample) => {
  if (window.perfBenchPhase) window.perfBenchPhase = 'painting HUD or returning sample'
  // Let the readout paint its latest sample before a driver takes a picture.
  if (new URLSearchParams(location.search).get('perfHud') === '1') {
    await sleep(300)
    await nextFrame()
  }
  return sample
})
