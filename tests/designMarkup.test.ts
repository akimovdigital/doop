import { describe, expect, it } from 'vitest'
import { constrainMarkup, markupPath, renderMarkupSvg, undoMarkup, type MarkupStroke } from '../src/lib/designMarkup'

const point = (x: number, y: number) => ({ x, y })
const stroke = (tool: MarkupStroke['tool'], ...points: MarkupStroke['points']): MarkupStroke => ({ tool, points })

describe('design markup', () => {
  it('constrains ellipses to circles and rectangles to squares, preserving drag direction', () => {
    expect(constrainMarkup('ellipse', point(10, 20), point(25, 15))).toEqual(point(25, 5))
    expect(constrainMarkup('rectangle', point(10, 20), point(8, 30))).toEqual(point(0, 30))
  })

  it('snaps arrows to the closest 45-degree direction without changing the length', () => {
    const start = point(20, 10)
    const end = constrainMarkup('arrow', start, point(100, 70))
    expect(end.x - start.x).toBeCloseTo(end.y - start.y)
    expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeCloseTo(100)
    expect(constrainMarkup('draw', start, point(34, 23))).toEqual(point(34, 23))
  })

  it('renders every tool, including shapes drawn backwards, and ignores degenerate drags', () => {
    expect(markupPath(stroke('draw', point(1, 2), point(4, 5), point(12, 8)))).toBe('M 1 2 L 4 5 L 12 8')
    expect(markupPath(stroke('arrow', point(0, 0), point(30, 0)))).toBe('M 0 0 L 30 0 M 18 6 L 30 0 L 18 -6')
    expect(markupPath(stroke('ellipse', point(30, 25), point(10, 5)))).toBe(
      'M 10 15 a 10 10 0 1 0 20 0 a 10 10 0 1 0 -20 0 Z',
    )
    expect(markupPath(stroke('rectangle', point(30, 25), point(10, 5)))).toBe('M 10 5 h 20 v 20 h -20 Z')
    expect(markupPath(stroke('arrow', point(0, 0), point(0, 0)))).toBe('')
    expect(markupPath(stroke('rectangle', point(10, 10), point(20, 10)))).toBe('')
  })

  it('undoes the last stroke without changing previous strokes or the original array', () => {
    const a = stroke('arrow', point(1, 1), point(3, 5))
    const b = stroke('ellipse', point(5, 5), point(8, 9))
    const original = [a, b]
    expect(undoMarkup(original)).toEqual([a])
    expect(original).toEqual([a, b])
    expect(undoMarkup([])).toEqual([])
  })

  it('exports a crop-sized SVG that maps page coordinates without modifying the strokes', () => {
    const svg = renderMarkupSvg([stroke('draw', point(105, 190), point(130, 220))], {
      x: 100,
      y: 200,
      width: 40,
      height: 35,
    })
    expect(svg).toContain('width="40" height="35" viewBox="100 200 40 35"')
    expect(svg).toContain('stroke-width="2"')
    expect(svg).toContain('<path d="M 105 190 L 130 220"/>')
    expect(renderMarkupSvg([], { x: 0, y: 0, width: 0, height: 2 })).toBe('')
  })
})
