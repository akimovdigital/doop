import type { Viewport } from '../../src/lib/store'
import { cameraRange, type Scenario } from './protocol'

export function trajectory(
  scenario: Scenario,
  duration: number,
  initial: Viewport,
  pivot: { x: number; y: number },
  horizontalPan = false,
) {
  const cycles = ['zoom', 'pan', 'scroll'].includes(scenario) ? Math.max(1, Math.round(duration / 880)) : 1
  const leg = (duration / cycles - 80) / 2
  const steps = Math.ceil(leg / 20)
  const drag = scenario === 'drag1' || scenario === 'drag10'
  const out = scenario === 'zoom-out-wide'
  const targetZoom = out ? 0.015 : scenario === 'zoom-wide' ? 0.6 : 0.055 * Math.exp(0.6)
  const zoomDelta = Math.log(targetZoom / initial.zoom)
  const cameraAt = (position: number) => {
    if (scenario === 'pan' && horizontalPan) return { ...initial, x: initial.x - 120 * position }
    if (scenario === 'pan' || scenario === 'scroll') return { ...initial, y: initial.y - 80 * position }
    if (drag) return initial
    const scale = Math.exp(zoomDelta * position)
    return {
      x: pivot.x + (initial.x - pivot.x) * scale,
      y: pivot.y + (initial.y - pivot.y) * scale,
      zoom: initial.zoom * scale,
    }
  }
  if (out) {
    const steps = Math.ceil(duration / 20)
    const points = Array.from({ length: steps }, (_, index) => {
      const position = (index + 1) / steps
      return { at: duration * position, position }
    })
    const final = cameraAt(1)
    return { points, zoomDelta, expected: cameraRange([initial, final]), expectedFinal: final }
  }

  const points = []
  for (let cycle = 0; cycle < cycles; cycle++) {
    const start = (cycle * duration) / cycles
    for (let step = 1; step <= steps; step++) {
      points.push({ at: start + (leg * step) / steps, position: step / steps })
    }
    for (let step = 1; step <= steps; step++) {
      const end = drag ? 0.65 : 0
      points.push({ at: start + leg + 40 + (leg * step) / steps, position: 1 - ((1 - end) * step) / steps })
    }
  }
  return { points, zoomDelta, expected: cameraRange([initial, cameraAt(1)]), expectedFinal: cameraAt(0) }
}

export const dragPoint = (position: number) => ({ x: Math.round(100 * position), y: Math.round(64 * position) })
