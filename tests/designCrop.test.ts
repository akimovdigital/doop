import { screenshotCropClip } from '../shared/screenshotCrop'
import { describe, expect, it } from 'vitest'
import { planDesignCrop } from '../src/lib/designCrop'

describe('Design Mode crop', () => {
  it('takes viewport CSS pixels plus padding, never reapplies the preview transform, and passes scroll separately', () => {
    const plan = planDesignCrop(
      [{ x: 20.25, y: 10.5, width: 40, height: 20 }],
      { width: 400, height: 300, scrollX: 30, scrollY: 500 },
      2,
    )
    expect(plan).toEqual({
      clip: { x: 12, y: 2, width: 57, height: 37 },
      viewport: { width: 400, height: 300, scrollX: 30, scrollY: 500 },
      scale: 2,
    })
  })

  it('uses one padded union for a multi-selection and clips it at the iframe edges', () => {
    const viewport = { width: 240, height: 200, scrollX: 0, scrollY: 0 }
    expect(
      planDesignCrop(
        [
          { x: -10, y: 5, width: 70, height: 75 },
          { x: 170, y: 130, width: 100, height: 80 },
        ],
        viewport,
        1,
      )?.clip,
    ).toEqual({ x: 0, y: 0, width: 240, height: 200 })
    expect(planDesignCrop([{ x: 500, y: 0, width: 30, height: 30 }], viewport, 2)).toBeNull()
  })

  it('maps the viewport rectangle to the actual, clamped document scroll for server rendering', () => {
    expect(
      screenshotCropClip(
        { x: 20, y: 12, width: 180, height: 100, scale: 2 },
        { width: 160, height: 200 },
        { x: 5, y: 330 },
      ),
    ).toEqual({ x: 25, y: 342, width: 140, height: 100 })
  })

  it('bounds PNG size by downscaling large selections while keeping the crop in CSS pixels', () => {
    const viewport = { width: 2000, height: 1000, scrollX: 0, scrollY: 0 }
    const plan = planDesignCrop([{ x: 0, y: 0, width: 2000, height: 1000 }], viewport, 3)
    expect(plan?.clip).toEqual({ x: 0, y: 0, width: 2000, height: 1000 })
    expect(plan?.scale).toBe(0.6)
  })
})
