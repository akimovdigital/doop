import { Profiler, type ProfilerOnRenderCallback } from 'react'
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
  scenarios,
  type Memory,
  type Sample,
  type Scenario,
} from './protocol'
import { canvasId, framePresets, makeScene } from './scene'
import '../../src/styles.css'

type Scene = ReturnType<typeof makeScene>
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
  }
}
window.perfBench = harness

const recordCommit: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  harness.commits.count++
  harness.commits.actualDuration += actualDuration
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))

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
  return () => {
    cancelAnimationFrame(handle)
    return intervalStats(times)
  }
}

async function waitReady(scene: Scene) {
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
  throw new Error(
    `Expected ${scene.frames.length} shells and ${scene.live} live documents; found ${document.querySelectorAll('[data-doop-frame-shell]').length} shells and ${JSON.stringify(liveDocuments())}`,
  )
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
  const title = dragCount ? stage.querySelector('[data-doop-frame-shell="f0"] [data-frame-title]') : null
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

async function run(): Promise<Sample> {
  const query = new URLSearchParams(location.search)
  const scenario = scenarios.find((value) => value === query.get('scenario')) ?? 'zoom'
  const frames = framePresets.find((value) => value === Number(query.get('frames'))) ?? 68
  const duration = Number(query.get('duration') ?? defaultDuration)
  const scene = makeScene(frames)
  const initial = initialCamera(scenario)
  const open = scenario === 'open'
  const endOpenFrames = open ? recordFrames() : null
  const browser = {
    userAgent: navigator.userAgent,
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
    visibility: document.visibilityState,
  }
  harness.setCamera(initial)
  harness.seed(scene)
  const canvas = (
    <TooltipProvider>
      <CanvasPage canvasId={canvasId} />
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
  createRoot(document.getElementById('root')!).render(tree)
  await waitReady(scene)

  const meta = { scenario, scene: { frames, expectedLive: scene.live, seed: scene.seed }, browser }
  const heap = () =>
    (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null
  if (endOpenFrames) {
    const openMs = performance.now()
    const counts = liveDocuments()
    const stats = endOpenFrames()
    const commits = { ...harness.commits }
    const after = await vmStat()
    const before = await vmStat(true)
    return {
      ...meta,
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

  const warm = prepareGesture(scenario, scene, 900)
  warm.select()
  await nextFrame()
  await warm.drive()
  warm.reset()
  await sleep(500)
  await waitReady(scene)
  const gesture = prepareGesture(scenario, scene, duration)
  const before = await vmStat()
  const start = performance.now()
  const startCamera = harness.getCamera()
  const observed = [startCamera]
  const liveBefore = liveDocuments()
  harness.commits.count = 0
  harness.commits.actualDuration = 0
  const off = harness.watchCamera((point) => observed.push(point))
  const endFrames = recordFrames()
  const input = await gesture.drive()
  const stats = endFrames()
  off()
  const elapsedMs = performance.now() - start
  const final = harness.getCamera()
  const commits = { ...harness.commits }
  const liveAfter = liveDocuments()
  const heapBytes = heap()
  const after = await vmStat()
  return {
    ...meta,
    elapsedMs,
    openMs: null,
    frames: stats,
    ...input,
    cameraSteps: observed.length - 1,
    camera: { actual: cameraRange(observed), expected: gesture.expected, final, expectedFinal: gesture.expectedFinal },
    commits,
    live: { before: liveBefore, after: liveAfter },
    heapBytes,
    memory: { before, after },
  }
}

window.perfBenchResult = run().then(async (sample) => {
  // Let the readout paint its latest sample before a driver takes a picture.
  if (new URLSearchParams(location.search).get('perfHud') === '1') {
    await sleep(300)
    await nextFrame()
  }
  return sample
})
