import { frameIntervals, intervalStats, nearestRank } from '../../src/perf/metrics'
import { cameraRange, type Sample } from '../../tests/perf/protocol'
import { makeScene, type FramePreset } from '../../tests/perf/scene'

/** Run the same itinerary against old fixture builds as well as the candidate. */
function installFlyOver(
  stops: { id: string; x: number; y: number; zoom: number }[],
  stats: typeof intervalStats,
  range: typeof cameraRange,
) {
  const url = new URL(location.href)
  url.searchParams.set('scenario', 'open')
  history.replaceState(null, '', url)

  Object.defineProperty(window, 'perfBenchResult', {
    configurable: true,
    set(open: Promise<Sample>) {
      Object.defineProperty(window, 'perfBenchResult', { value: open.then(drive) })
    },
  })

  async function drive(open: Sample): Promise<Sample> {
    const harness = window.perfBench
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const readMemory = async (): Promise<Sample['memory']['before']> => {
      const reply = await fetch('/__memory')
      if (!reply.ok) throw new Error('Unable to sample swap counters')
      return reply.json()
    }
    const initial = harness.getCamera()
    const stage = document.querySelector('.stage')!
    const animationBudget =
      Number(stage.querySelector('[data-animating-frame-budget]')?.getAttribute('data-animating-frame-budget')) ||
      undefined
    const expected = stops
      .map(({ x, y, zoom }) => ({
        x: stage.clientWidth / 2 - x * zoom,
        y: stage.clientHeight / 2 - y * zoom,
        zoom,
      }))
      .concat(initial)
    const observed = [initial]
    const off = harness.watchCamera((camera) => observed.push(camera))
    let peakMounted = open.live.before.mounted
    let peakAnimationAllowed = 0
    const sampleCounts = () => {
      const mounted = document.querySelectorAll('iframe[data-doop-frame]')
      peakMounted = Math.max(peakMounted, mounted.length)
      const animationAllowed = [...mounted].filter((node) => {
        const id = node.closest('[data-doop-frame-shell]')?.getAttribute('data-doop-frame-shell')
        return id && harness.hasFrameDocument(id) && !node.hasAttribute('data-frame-animation-paused')
      }).length
      peakAnimationAllowed = Math.max(peakAnimationAllowed, animationAllowed)
      return animationAllowed
    }
    const animationAllowedBefore = sampleCounts()
    const observer = new MutationObserver(sampleCounts)
    observer.observe(stage, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-frame-animation-paused'],
    })
    const times: number[] = []
    let tick = requestAnimationFrame(function record(time) {
      times.push(time)
      tick = requestAnimationFrame(record)
    })
    const before = await readMemory()
    const start = performance.now()
    let visited = 0
    harness.commits.count = 0
    harness.commits.actualDuration = 0
    try {
      for (let index = 0; index < stops.length; index++) {
        const { id } = stops[index]!
        harness.setCamera(expected[index]!)
        const until = performance.now() + 6500
        while (!harness.hasFrameDocument(id) && performance.now() < until) await sleep(30)
        if (!harness.hasFrameDocument(id)) throw new Error('Fly-over did not load ' + id)
        visited++
        sampleCounts()
      }
      harness.setCamera(initial)
      // Let the return trip settle and retire out-of-budget documents before sampling RSS.
      await sleep(2500)
      const expectedAfter = Math.min(open.liveBudget ?? Infinity, open.scene.frames)
      const until = performance.now() + 6500
      while (harness.liveDocuments().ready !== expectedAfter && performance.now() < until) await sleep(30)
      const elapsedMs = performance.now() - start
      const after = await readMemory()
      const animationAllowedAfter = sampleCounts()
      return {
        ...open,
        scenario: 'fly-over',
        elapsedMs,
        openMs: null,
        frames: stats(times),
        inputEvents: expected.length,
        plannedInputs: expected.length,
        cameraSteps: observed.length - 1,
        camera: {
          actual: range(observed),
          expected: range([initial, ...expected]),
          final: harness.getCamera(),
          expectedFinal: initial,
        },
        commits: { ...harness.commits },
        live: { before: open.live.before, after: harness.liveDocuments() },
        animationBudget,
        animationAllowed: { before: animationAllowedBefore, after: animationAllowedAfter },
        flyOver: { peakMounted, visited, peakAnimationAllowed },
        memory: { before, after },
      }
    } finally {
      observer.disconnect()
      cancelAnimationFrame(tick)
      off()
    }
  }
}

// The helpers are serialized with their dependencies into the fixture's browser realm.
export function flyOverScript(frames: FramePreset) {
  const scene = makeScene(frames)
  const stops = scene.frames.map(({ id, x, y, width, height }, index) => ({
    id,
    x: x + width / 2,
    y: y + height / 2,
    zoom: index < scene.live ? 0.5 : 0.25,
  }))
  return `
    const nearestRank = ${nearestRank.toString()};
    const frameIntervals = ${frameIntervals.toString()};
    const stats = ${intervalStats.toString()};
    const range = ${cameraRange.toString()};
    (${installFlyOver.toString()})(${JSON.stringify(stops)}, stats, range);
  `
}
