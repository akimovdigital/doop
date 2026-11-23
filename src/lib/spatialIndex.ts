import { canvasPages } from '../../shared/pages'
import { frameDesignPoint, rotatedBounds } from '../../shared/frameRotation'
import type { Canvas, Frame } from '../../shared/types'
import { SNAP_PX, type Rect } from './snap'

type FrameCanvas = Pick<Canvas, 'id' | 'pages' | 'frames'>
type Axis = 'x' | 'y'
type Box = { left: number; top: number; right: number; bottom: number }
type Entry = { frame: Frame; rank: number; page: PageIndex; box: Box; cells: Cell[]; x: number[]; y: number[] }
type Cell = [number, number]

const CELL = 512
const ALIGNMENT_CELL = 64
const MAX_CELLS = 256
const cell = (coordinate: number) => Math.floor(coordinate / CELL)
const alignmentCell = (coordinate: number) => Math.floor(coordinate / ALIGNMENT_CELL)
const boxOf = (r: Rect): Box => ({ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height })
const overlaps = (a: Box, b: Box) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top

function cover(box: Box): Cell[] {
  const left = cell(box.left)
  const top = cell(box.top)
  const right = cell(box.right)
  const bottom = cell(box.bottom)
  if (![left, top, right, bottom].every(Number.isSafeInteger) || (right - left + 1) * (bottom - top + 1) > MAX_CELLS)
    return []
  const result: Cell[] = []
  for (let x = left; x <= right; x++) {
    for (let y = top; y <= bottom; y++) result.push([x, y])
  }
  return result
}

function* inRange<T>(buckets: Map<number, T>, min: number, max: number) {
  if (Number.isSafeInteger(min) && Number.isSafeInteger(max) && max - min < buckets.size) {
    for (let n = min; n <= max; n++) {
      const bucket = buckets.get(n)
      if (bucket !== undefined) yield bucket
    }
  } else {
    for (const [key, bucket] of buckets) {
      if (key >= min && key <= max) yield bucket
    }
  }
}

function alignments(frame: Frame, axis: Axis) {
  const start = frame[axis]
  const size = axis === 'x' ? frame.width : frame.height
  return [...new Set([start, start + size / 2, start + size].map(alignmentCell))]
}

function add(buckets: Map<number, Set<Entry>>, key: number, entry: Entry) {
  let bucket = buckets.get(key)
  if (!bucket) buckets.set(key, (bucket = new Set()))
  bucket.add(entry)
}

function remove(buckets: Map<number, Set<Entry>>, key: number, entry: Entry) {
  const bucket = buckets.get(key)
  bucket?.delete(entry)
  if (!bucket?.size) buckets.delete(key)
}

function inPaintOrder(entries: Iterable<Entry>) {
  return [...entries].sort((a, b) => a.rank - b.rank).map(({ frame }) => frame)
}

class PageIndex {
  entries = new Set<Entry>()
  oversized = new Set<Entry>()
  cells = new Map<number, Map<number, Set<Entry>>>()
  align = { x: new Map<number, Set<Entry>>(), y: new Map<number, Set<Entry>>() }

  insert(entry: Entry) {
    this.entries.add(entry)
    if (!entry.cells.length) this.oversized.add(entry)
    for (const [x, y] of entry.cells) {
      let column = this.cells.get(x)
      if (!column) this.cells.set(x, (column = new Map()))
      add(column, y, entry)
    }
    for (const x of entry.x) add(this.align.x, x, entry)
    for (const y of entry.y) add(this.align.y, y, entry)
  }

  remove(entry: Entry) {
    this.entries.delete(entry)
    this.oversized.delete(entry)
    for (const [x, y] of entry.cells) {
      const column = this.cells.get(x)
      if (!column) continue
      remove(column, y, entry)
      if (!column.size) this.cells.delete(x)
    }
    for (const x of entry.x) remove(this.align.x, x, entry)
    for (const y of entry.y) remove(this.align.y, y, entry)
  }

  *intersect(box: Box) {
    const entries = new Set(this.oversized)
    const top = cell(box.top)
    const bottom = cell(box.bottom)
    for (const column of inRange(this.cells, cell(box.left), cell(box.right))) {
      for (const bucket of inRange(column, top, bottom)) {
        for (const entry of bucket) entries.add(entry)
      }
    }
    for (const entry of entries) {
      if (overlaps(entry.box, box)) yield entry
    }
  }

  addSnapCandidates(axis: Axis, start: number, size: number, tolerance: number, result: Set<Entry>) {
    const buckets = this.align[axis]
    for (const line of [start, start + size / 2, start + size]) {
      // Include an adjacent bin at exact float boundaries. snapFrame owns
      // the tolerance check and preserves its original arithmetic/tie order.
      const lo = alignmentCell(line - tolerance) - 1
      const hi = alignmentCell(line + tolerance) + 1
      for (const bucket of inRange(buckets, lo, hi)) {
        for (const entry of bucket) result.add(entry)
      }
    }
  }
}

export class SpatialIndex {
  private pages = new Map<string, PageIndex>()
  private byId = new Map<string, Entry>()
  private frames?: readonly Frame[]
  private firstPageId?: string

  update(canvas: FrameCanvas) {
    const firstPageId = canvasPages(canvas)[0]!.id
    if (canvas.frames === this.frames && firstPageId === this.firstPageId) return this
    this.frames = canvas.frames
    this.firstPageId = firstPageId

    // Zustand publishes an immutable array. Reconcile it once per change
    // and only re-bin geometry for frames whose spatial keys changed.
    for (const [rank, frame] of canvas.frames.entries()) {
      if (frame.hidden) continue
      const pageId = frame.pageId ?? firstPageId
      let page = this.pages.get(pageId)
      if (!page) this.pages.set(pageId, (page = new PageIndex()))
      const old = this.byId.get(frame.id)
      if (old) {
        const f = old.frame
        if (
          old.page === page &&
          f.x === frame.x &&
          f.y === frame.y &&
          f.width === frame.width &&
          f.height === frame.height &&
          f.rotation === frame.rotation
        ) {
          old.frame = frame
          old.rank = rank
          continue
        }
        old.page.remove(old)
      }
      const raw = boxOf(frame)
      const turned = frame.rotation ? boxOf(rotatedBounds(frame, frame.rotation)) : raw
      // The broad phase must include coordinates rounded the other way by
      // the inverse rotated-point and viewport calculations.
      const epsilon =
        Number.EPSILON *
        8 *
        Math.max(
          1,
          Math.abs(raw.left),
          Math.abs(raw.top),
          Math.abs(raw.right),
          Math.abs(raw.bottom),
          frame.width,
          frame.height,
        )
      const box = {
        left: Math.min(raw.left, turned.left) - epsilon,
        top: Math.min(raw.top, turned.top) - epsilon,
        right: Math.max(raw.right, turned.right) + epsilon,
        bottom: Math.max(raw.bottom, turned.bottom) + epsilon,
      }
      const entry = { frame, rank, page, box, cells: cover(box), x: alignments(frame, 'x'), y: alignments(frame, 'y') }
      page.insert(entry)
      this.byId.set(frame.id, entry)
    }

    for (const [id, entry] of this.byId) {
      if (canvas.frames[entry.rank] === entry.frame && !entry.frame.hidden) continue
      entry.page.remove(entry)
      this.byId.delete(id)
    }
    for (const [id, page] of this.pages) if (!page.entries.size) this.pages.delete(id)
    return this
  }

  all(pageId: string) {
    return inPaintOrder(this.pages.get(pageId)?.entries ?? [])
  }

  intersect(pageId: string, rect: Rect) {
    return inPaintOrder(this.pages.get(pageId)?.intersect(boxOf(rect)) ?? [])
  }

  snapCandidates(pageId: string, rect: Rect, zoom: number, excluded?: ReadonlySet<string>) {
    const page = this.pages.get(pageId)
    if (!page) return []
    const candidates = new Set<Entry>()
    page.addSnapCandidates('x', rect.x, rect.width, SNAP_PX / zoom, candidates)
    page.addSnapCandidates('y', rect.y, rect.height, SNAP_PX / zoom, candidates)
    return inPaintOrder(candidates).filter((frame) => !excluded?.has(frame.id))
  }

  frameAtPoint(pageId: string | null, point: { x: number; y: number }) {
    const pages = pageId === null ? this.pages.values() : [this.pages.get(pageId)]
    const bounds = boxOf({ ...point, width: 0, height: 0 })
    let topmost: Entry | undefined
    for (const page of pages) {
      for (const entry of page?.intersect(bounds) ?? []) {
        if (topmost && topmost.rank > entry.rank) continue
        const { frame } = entry
        const d = frameDesignPoint(point, frame)
        if (d.x >= 0 && d.y >= 0 && d.x <= frame.width && d.y <= frame.height) topmost = entry
      }
    }
    return topmost?.frame
  }
}

let cache: { id: string; index: SpatialIndex } | undefined

export function frameSpatialIndex(canvas: FrameCanvas) {
  if (cache?.id !== canvas.id) cache = { id: canvas.id, index: new SpatialIndex() }
  return cache.index.update(canvas)
}
