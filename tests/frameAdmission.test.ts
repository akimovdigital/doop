import { describe, expect, it } from 'vitest'
import {
  LIVE_FRAME_BUDGET,
  planFrameAdmission,
  rankFrameCandidates,
  reserveFrameSlots,
  type FrameCandidate,
} from '../src/components/frameBudget'

const candidate = (id: string, distance: number, visible = true, lastSeen = 0): FrameCandidate => ({
  id,
  distance,
  visible,
  lastSeen,
  near: visible,
  large: true,
  visiblePixelRatio: visible ? 1 : 0,
})

describe('frame admission budget', () => {
  it('ranks visible frames by screen distance, then keeps the most recently seen off-screen frames', () => {
    expect(
      rankFrameCandidates([
        candidate('old', 2, false, 1),
        candidate('outer', 11),
        candidate('new', 99, false, 2),
        candidate('inner', 10),
      ]).map(({ id }) => id),
    ).toEqual(['inner', 'outer', 'new', 'old'])
  })

  it('reserves a slot for a protected frame even with every ordinary slot occupied', () => {
    const frames = Array.from({ length: LIVE_FRAME_BUDGET + 3 }, (_, index) => candidate(String(index), index))
    const live = new Set(frames.slice(0, LIVE_FRAME_BUDGET).map(({ id }) => id))
    const desired = planFrameAdmission(frames, live, new Set(['22']), false, 100)
    expect(desired.size).toBe(LIVE_FRAME_BUDGET)
    expect(desired.has('22')).toBe(true)
    expect(desired.has('19')).toBe(false)
  })

  it('keeps mounted active frames when more than the budget are selected or in Present', () => {
    const live = new Set(Array.from({ length: LIVE_FRAME_BUDGET }, (_, index) => String(index)))
    const protectedIds = new Set(['new', ...live])
    expect(reserveFrameSlots(protectedIds, live, false)).toEqual(live)
    expect(reserveFrameSlots(new Set(['new']), live, true)).toEqual(live)
  })

  it('expires a long-unseen frame and admits it again on return', () => {
    const live = new Set(['returning'])
    expect(planFrameAdmission([candidate('returning', 5000, false)], live, new Set(), false, 11_000).size).toBe(0)
    expect(planFrameAdmission([candidate('returning', 10)], new Set(), new Set(), false, 12_000)).toEqual(live)
  })
})
