import { expect, it } from 'vitest'
import { farOverviewAtZoom } from '../src/lib/farOverview'

it('keeps the current presentation through repeated zoom reversals between its two thresholds', () => {
  let active = false
  const states = [0.07, 0.06, 0.075, 0.065, 0.08, 0.079, 2.5, 0.01].map((zoom) => {
    active = farOverviewAtZoom(active, zoom)
    return active
  })
  expect(states).toEqual([false, true, true, true, false, false, false, true])
})
