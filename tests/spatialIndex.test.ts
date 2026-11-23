import { describe, expect, it } from 'vitest'
import { frameDesignPoint, rotatedBounds } from '../shared/frameRotation'
import { framePageId } from '../shared/pages'
import type { Frame } from '../shared/types'
import { drawingDropFrame } from '../src/lib/drawingMove'
import { currentPageSpatialIndex } from '../src/lib/pages'
import { snapFrame } from '../src/lib/snap'
import { SpatialIndex } from '../src/lib/spatialIndex'
import { useStore } from '../src/lib/store'

function makeFrames(count: number) {
  let seed = 647
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  const frames: Frame[] = Array.from({ length: count }, (_, i) => ({
    id: String(i),
    canvasId: 'c',
    name: String(i),
    createdAt: i,
    updatedAt: i,
    updatedBy: 'test',
    html: '',
    x: Math.floor(random() * 16000 - 8000),
    y: Math.floor(random() * 16000 - 8000),
    width: 10 + Math.floor(random() * 850),
    height: 10 + Math.floor(random() * 2200),
    rotation: i % 3 ? 0 : Math.floor(random() * 360),
    pageId: i % 3 ? undefined : 'page-2',
    hidden: i % 11 === 0,
    locked: i % 13 === 0,
  }))
  const canvas = {
    id: 'c',
    frames,
    pages: [
      { id: 'home', name: 'Home' },
      { id: 'page-2', name: 'Two' },
    ],
  }
  return { canvas, random }
}

describe('page frame spatial index', () => {
  it('finds the source frame under an in-frame drawing drag after the canvas is seeded', () => {
    const source: Frame = {
      id: 'source',
      canvasId: 'c',
      pageId: 'first',
      name: 'Source',
      html: '<div data-doop-drawing="rectangle"></div>',
      x: 20,
      y: 20,
      width: 250,
      height: 250,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'test',
    }
    const canvas = {
      id: 'c',
      name: 'Draw',
      pages: [
        { id: 'first', name: 'Main' },
        { id: 'second', name: 'Other' },
      ],
      createdAt: 0,
      updatedAt: 0,
    }
    const store = useStore.getState()
    store.setCanvas({ ...canvas, frames: [] })
    try {
      expect(currentPageSpatialIndex()?.index.all('first')).toEqual([])
      const frames = [
        source,
        { ...source, id: 'hidden', hidden: true },
        { ...source, id: 'other-page', pageId: 'second' },
      ]
      store.setCanvas({ ...canvas, frames })
      const point = { x: 143, y: 217 }
      const brute = [...frames].reverse().find(
        (frame) =>
          !frame.hidden &&
          framePageId(canvas, frame) === 'first' &&
          point.x >= frame.x &&
          point.x <= frame.x + frame.width &&
          point.y >= frame.y &&
          point.y <= frame.y + frame.height,
      )
      expect(brute?.id).toBe('source')
      expect(drawingDropFrame(point)).toEqual(brute)
    } finally {
      store.setCanvas(null)
    }
  })

  it('matches admission candidates and rotated point hits after edits and reordering', () => {
    const { canvas, random } = makeFrames(500)
    const index = new SpatialIndex()
    for (let change = 0; change < 12; change++) {
      index.update(canvas)
      const pageId = change % 2 ? 'home' : 'page-2'
      const visible = canvas.frames.filter((frame) => !frame.hidden && framePageId(canvas, frame) === pageId)
      expect(index.all(pageId)).toEqual(visible)
      for (let step = 0; step < 40; step++) {
        const frame = visible[step]!
        const point = { x: frame.x + random() * frame.width, y: frame.y + random() * frame.height }
        const rect = { ...point, width: 350 + step * 80, height: 150 + step * 50 }
        const near = (f: Frame) => {
          const b = rotatedBounds(f, f.rotation ?? 0)
          return (
            b.x <= rect.x + rect.width &&
            b.y <= rect.y + rect.height &&
            b.x + b.width >= rect.x &&
            b.y + b.height >= rect.y
          )
        }
        expect(index.intersect(pageId, rect).filter(near)).toEqual(visible.filter(near))
        const hit = (f: Frame) => {
          const p = frameDesignPoint(point, f)
          return p.x >= 0 && p.x <= f.width && p.y >= 0 && p.y <= f.height
        }
        expect(index.frameAtPoint(pageId, point)).toBe([...visible].reverse().find(hit))
        expect(index.frameAtPoint(null, point)).toBe([...canvas.frames].reverse().find((f) => !f.hidden && hit(f)))
      }
      const [source, ...rest] = canvas.frames
      canvas.frames = [
        ...rest.slice(0, -1).reverse(),
        {
          ...source!,
          hidden: !source!.hidden,
          pageId: 'page-2',
          x: 10,
          y: -12,
          width: 500_000,
          height: 6000,
        },
        { ...source!, id: `new-${change}`, hidden: false, rotation: 117, width: 200 },
      ]
    }
    canvas.pages = [...canvas.pages].reverse()
    index.update(canvas)
    expect(index.all('home')).toEqual(canvas.frames.filter((f) => !f.hidden && framePageId(canvas, f) === 'home'))
  })

  it('preserves move/resize snaps and guides, including ties and distant alignments', () => {
    const { canvas, random } = makeFrames(500)
    const index = new SpatialIndex().update(canvas)
    const page = 'home'
    const excluded = new Set(['2', '4', '5', '7'])
    const others = canvas.frames.filter((f) => !f.hidden && framePageId(canvas, f) === page && !excluded.has(f.id))
    const guides = [{ id: 'gv', pageId: page, axis: 'v' as const, at: 23 }]
    for (let i = 0; i < 400; i++) {
      const anchor = others[i % others.length]!
      const rect = { x: anchor.x + random() * 8 - 4, y: i % 3 ? anchor.y : 15_000, width: i % 560, height: i % 390 }
      const zoom = [0.05, 0.5, 1, 2, 16][i % 5]!
      const mode = i % 3 ? 'move' : 'resize'
      const handle = (['se', 'nw', 's', 'w', 'ne'] as const)[i % 5]!
      expect(snapFrame(mode, rect, index.snapCandidates(page, rect, zoom, excluded), zoom, guides, handle)).toEqual(
        snapFrame(mode, rect, others, zoom, guides, handle),
      )
    }
    const [base] = others
    canvas.frames = [
      { ...base!, id: 'far', x: 10, y: -90000, width: 100 },
      { ...base!, id: 'near', x: 10, y: 100, width: 100 },
    ]
    index.update(canvas)
    const rect = { x: 11, y: 15, width: 1, height: 1 }
    const snap = snapFrame('move', rect, index.snapCandidates(page, rect, 1), 1)
    expect(snap.guides[0]).toMatchObject({ at: 10, from: -90000 })
  })

  it('times viewport and snap queries against brute force at 68 and 500 frames', () => {
    for (const count of [68, 500]) {
      const { canvas, random } = makeFrames(count)
      const index = new SpatialIndex().update(canvas)
      const page = 'home'
      const others = canvas.frames.filter((f) => !f.hidden && framePageId(canvas, f) === page)
      const rects = Array.from({ length: 2000 }, () => ({
        x: random() * 16000 - 8000,
        y: random() * 16000 - 8000,
        width: 1200,
        height: 800,
      }))
      const visible = (f: Frame, r: (typeof rects)[number]) => {
        const b = rotatedBounds(f, f.rotation ?? 0)
        return b.x <= r.x + r.width && b.x + b.width >= r.x && b.y <= r.y + r.height && b.y + b.height >= r.y
      }
      const workloads = {
        viewport: {
          raw: (r: (typeof rects)[number]) => others.filter((f) => visible(f, r)).length,
          indexed: (r: (typeof rects)[number]) => index.intersect(page, r).filter((f) => visible(f, r)).length,
        },
        snap: {
          raw: (r: (typeof rects)[number]) => snapFrame('move', r, others, 1).guides.length,
          indexed: (r: (typeof rects)[number]) =>
            snapFrame('move', r, index.snapCandidates(page, r, 1), 1).guides.length,
        },
      }
      for (const [name, { raw, indexed }] of Object.entries(workloads)) {
        const time = (query: typeof raw) => {
          const start = performance.now()
          const hits = rects.reduce((sum, rect) => sum + query(rect), 0)
          return { hits, ms: performance.now() - start }
        }
        expect(time(indexed).hits).toBe(time(raw).hits)
        const results = Array.from({ length: 7 }, () => [time(raw).ms, time(indexed).ms])
        const median = (column: number) =>
          results
            .map((r) => r[column]!)
            .sort((a, b) => a - b)[3]!
            .toFixed(2)
        process.stdout.write(`${name} queries, ${count} frames: brute ${median(0)} ms, index ${median(1)} ms\n`)
      }
    }
  })
})
