import { nearestRank } from '../../src/perf/metrics'
import { windowSize, type Sample } from './protocol'

export function median(values: readonly number[]): number | null {
  const lower = nearestRank(values, 50)
  if (lower === null || values.length % 2) return lower
  return (lower + nearestRank(values, 50 + 100 / values.length)!) / 2
}

export function memoryDelta(sample: Sample) {
  return {
    Swapins: sample.memory.after.Swapins - sample.memory.before.Swapins,
    Swapouts: sample.memory.after.Swapouts - sample.memory.before.Swapouts,
  }
}

function expectedDocuments(sample: Sample, boundary: string) {
  const count = sample.scenario === 'fly-over' && boundary === 'after' ? sample.scene.frames : sample.scene.expectedLive
  return Math.min(sample.liveBudget ?? Infinity, count)
}

export function rejectionReasons(sample: Sample, maxSwapins: number, maxSwapouts = 0): string[] {
  const reasons: string[] = []
  const swap = memoryDelta(sample)
  if (swap.Swapouts > maxSwapouts) reasons.push(`Swapouts grew by ${swap.Swapouts} pages`)
  if (swap.Swapins > maxSwapins) reasons.push(`Swapins grew by ${swap.Swapins} pages (limit ${maxSwapins})`)
  if (swap.Swapins < 0 || swap.Swapouts < 0) reasons.push('Swap counters went backwards')

  const { browser, camera, scene, live } = sample
  if (browser.width !== windowSize.width || browser.height !== windowSize.height || browser.dpr !== windowSize.dpr) {
    reasons.push(`Expected 1280×800 DPR 2, got ${browser.width}×${browser.height} DPR ${browser.dpr}`)
  }
  if (browser.visibility !== 'visible') reasons.push(`Document visibility was ${browser.visibility}`)
  for (const axis of ['x', 'y', 'zoom'] as const) {
    const tolerance = axis === 'zoom' ? 0.0001 : 1
    if (
      camera.actual[axis].some((value, i) => Math.abs(value - camera.expected[axis][i]!) > tolerance) ||
      Math.abs(camera.final[axis] - camera.expectedFinal[axis]) > tolerance
    ) {
      reasons.push(`Camera ${axis} range or endpoint differs from the script`)
    }
  }
  for (const [boundary, counts] of Object.entries(live)) {
    if ('sha256' in scene) {
      if (counts.mounted !== counts.ready)
        reasons.push(`Live documents ${boundary}: ${counts.mounted} mounted, ${counts.ready} ready`)
      continue
    }
    const expected = expectedDocuments(sample, boundary)
    if (counts.ready !== expected || counts.mounted !== expected) {
      reasons.push(`Live documents ${boundary}: ${counts.mounted}/${counts.ready}, expected ${expected}`)
    }
  }
  if (sample.scenario === 'fly-over') {
    if (sample.flyOver?.visited !== scene.frames) reasons.push('Fly-over did not visit every frame')
    if (sample.liveBudget && (sample.flyOver?.peakMounted ?? Infinity) > sample.liveBudget)
      reasons.push('Fly-over exceeded the live-document budget')
    if (sample.animationBudget && (sample.flyOver?.peakAnimationAllowed ?? Infinity) > sample.animationBudget)
      reasons.push('Fly-over exceeded the animation budget')
  }
  if (sample.drag && sample.drag.moved !== sample.drag.expected)
    reasons.push('Dragged frames did not reach the planned endpoint')
  if (sample.inputEvents !== sample.plannedInputs) reasons.push('Input count differs from script')
  if (sample.openMs === null && sample.frames.intervals < 10) reasons.push('Too few rAF intervals')
  if (sample.cameraSteps < 2 && ['pan', 'zoom', 'zoom-wide'].includes(sample.scenario))
    reasons.push('Too few camera updates')
  return reasons
}

export function pairRejectionReasons(a: Sample, b: Sample) {
  const reasons: string[] = []
  const real = 'sha256' in a.scene || 'sha256' in b.scene
  const explicitBudgetDifference =
    a.liveBudget !== b.liveBudget &&
    [a, b].every((sample) =>
      Object.entries(sample.live).every(([boundary, counts]) => {
        const expected = expectedDocuments(sample, boundary)
        return counts.ready === expected && counts.mounted === expected
      }),
    )
  if (
    !real &&
    !explicitBudgetDifference &&
    (a.live.before.ready !== b.live.before.ready || a.live.after.ready !== b.live.after.ready)
  ) {
    reasons.push('A/B ready-document counts differ')
  }
  const sameScene =
    'sha256' in a.scene && 'sha256' in b.scene
      ? a.scene.sha256 === b.scene.sha256
      : 'seed' in a.scene &&
        'seed' in b.scene &&
        a.scene.seed === b.scene.seed &&
        a.scene.expectedLive === b.scene.expectedLive
  if (
    !sameScene ||
    a.scene.frames !== b.scene.frames ||
    a.scenario !== b.scenario ||
    a.plannedInputs !== b.plannedInputs
  ) {
    reasons.push('A/B scenario or scene differs')
  }
  for (const axis of ['x', 'y', 'zoom'] as const) {
    const tolerance = axis === 'zoom' ? 0.0001 : 1
    if (a.camera.actual[axis].some((value, i) => Math.abs(value - b.camera.actual[axis][i]!) > tolerance)) {
      reasons.push(`A/B camera ${axis} ranges differ`)
    }
  }
  if (Math.abs(a.cameraSteps - b.cameraSteps) > Math.max(5, 0.2 * Math.max(a.cameraSteps, b.cameraSteps))) {
    reasons.push(`A/B camera step counts differ: ${a.cameraSteps} vs ${b.cameraSteps}`)
  }
  return reasons
}

export const noiseFloor = (deltas: readonly number[]) => (deltas.length ? Math.max(1, ...deltas.map(Math.abs)) : null)

export function verdict(deltas: readonly number[], floor: number | null, plannedPairs: number) {
  const delta = median(deltas)
  if (delta === null || floor === null || deltas.length < plannedPairs || plannedPairs < 3) return 'insufficient data'
  const required = Math.ceil(deltas.length * 0.8)
  if (delta < -floor && deltas.filter((value) => value < 0).length >= required) return 'win'
  if (delta > floor && deltas.filter((value) => value > 0).length >= required) return 'regression'
  return 'no change'
}
