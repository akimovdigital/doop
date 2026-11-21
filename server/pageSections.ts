import { nanoid } from 'nanoid'
import { rotatedBounds } from '../shared/frameRotation.ts'
import { sortByStack } from '../shared/frameStack.ts'
import { canvasPages, pageFrames } from '../shared/pages.ts'
import { SECTION_BOUNDS_LIMIT, sectionContainsFrame } from '../shared/sections.ts'
import type {
  Canvas,
  CanvasFrameMove,
  CanvasGuide,
  CanvasPageLayout,
  CanvasSection,
  ElementComment,
  Frame,
} from '../shared/types.ts'

export const MAX_SECTIONS_PER_PAGE = 1000
export const MAX_SECTION_COORDINATE = SECTION_BOUNDS_LIMIT

export class PageLayoutLimitError extends Error {}

export interface PageLayoutWrite extends CanvasPageLayout {
  guides?: CanvasGuide[]
  comments?: ElementComment[]
}

type Point = Pick<CanvasSection, 'x' | 'y'>

function moveFrame(frame: Frame, pageId: string, delta: Point, by: string, z = frame.z): CanvasFrameMove {
  return {
    id: frame.id,
    pageId,
    x: frame.x + delta.x,
    y: frame.y + delta.y,
    ...(z !== undefined ? { z } : {}),
    updatedAt: Math.max(Date.now(), frame.updatedAt + 1),
    updatedBy: by,
  }
}

/** Section children are inferred from bounds. Equal boxes do not nest. */
export function moveSection(
  canvas: Canvas,
  pageId: string,
  sectionId: string,
  to: Point,
  by: string,
): PageLayoutWrite | undefined {
  const pages = canvasPages(canvas)
  const page = pages.find((p) => p.id === pageId)
  const section = page?.sections?.find((s) => s.id === sectionId)
  if (!section) return undefined
  const delta = { x: to.x - section.x, y: to.y - section.y }
  if (!delta.x && !delta.y) return { pages, frameMoves: [] }

  const sections = page!.sections!.map((s) => {
    if (s.id === sectionId) return { ...s, ...to }
    return (s.width < section.width || s.height < section.height) && sectionContainsFrame(section, s)
      ? { ...s, x: s.x + delta.x, y: s.y + delta.y }
      : s
  })
  const frameMoves = pageFrames(canvas, pageId)
    .filter((frame) => sectionContainsFrame(section, frame))
    .map((frame) => moveFrame(frame, pageId, delta, by))
  return { pages: pages.map((p) => (p.id === pageId ? { ...p, sections } : p)), frameMoves }
}

const PAGE_PADDING = 64
const SECTION_GAP = 192
const COLUMNS = 3

/** Pack original pages side by side, preserving the relative positions and
 * stack inside each page. Frame IDs and editable documents are reused. */
export function consolidatePages(
  canvas: Canvas,
  pageId: string,
  name: string,
  by: string,
  comments: readonly ElementComment[] = [],
): PageLayoutWrite | undefined {
  const pages = canvasPages(canvas)
  const target = pages.find((page) => page.id === pageId)
  if (!target) return undefined
  if (pages.length === 1) {
    const landingSectionId = target.landingSectionId ?? target.sections?.[0]?.id
    return {
      pages:
        target.name === name && landingSectionId === target.landingSectionId
          ? pages
          : [{ ...target, name, landingSectionId }],
      frameMoves: [],
    }
  }

  const sections: CanvasSection[] = []
  const sectionIds = new Set<string>()
  const frameMoves: CanvasFrameMove[] = []
  const deltas = new Map<string, Point>()
  let columnX = 0
  let rowY = 0
  let rowHeight = 0
  for (const [index, page] of [target, ...pages.filter((p) => p !== target)].entries()) {
    const frames = sortByStack(pageFrames(canvas, page.id))
    const pageSections = page.sections ?? []
    if (sections.length + pageSections.length + 1 > MAX_SECTIONS_PER_PAGE) {
      throw new PageLayoutLimitError('There are too many sections to put on one page.')
    }

    const bounds = [...pageSections, ...frames.map((frame) => rotatedBounds(frame, frame.rotation ?? 0))]
    let left = bounds.length ? Infinity : 0
    let top = left
    let right = bounds.length ? -Infinity : 192
    let bottom = bounds.length ? -Infinity : 128
    for (const box of bounds) {
      left = Math.min(left, box.x)
      top = Math.min(top, box.y)
      right = Math.max(right, box.x + box.width)
      bottom = Math.max(bottom, box.y + box.height)
    }
    const width = right - left + 2 * PAGE_PADDING
    const height = bottom - top + 2 * PAGE_PADDING
    if (
      width < 1 ||
      height < 1 ||
      ![columnX + width, rowY + height].every((v) => Number.isFinite(v) && v <= MAX_SECTION_COORDINATE)
    ) {
      throw new PageLayoutLimitError('The combined pages exceed the supported canvas size.')
    }
    const delta = { x: columnX + PAGE_PADDING - left, y: rowY + PAGE_PADDING - top }
    deltas.set(page.id, delta)
    const id = nanoid(10)
    sectionIds.add(id)
    sections.push({ id, name: page.name, x: columnX, y: rowY, width, height })
    for (const section of pageSections) {
      const id = sectionIds.has(section.id) ? nanoid(10) : section.id
      sectionIds.add(id)
      sections.push({ ...section, id, x: section.x + delta.x, y: section.y + delta.y })
    }
    for (const frame of frames) frameMoves.push(moveFrame(frame, pageId, delta, by, frameMoves.length))

    columnX += width + SECTION_GAP
    rowHeight = Math.max(rowHeight, height)
    if ((index + 1) % COLUMNS === 0) {
      columnX = 0
      rowY += rowHeight + SECTION_GAP
      rowHeight = 0
    }
  }

  const guides = canvas.guides?.map((guide) => {
    const delta = deltas.get(guide.pageId)
    return delta ? { ...guide, pageId, at: guide.at + (guide.axis === 'v' ? delta.x : delta.y) } : guide
  })
  const movedComments = comments.flatMap((comment) => {
    if (comment.frameId || !comment.pageId || comment.x === undefined || comment.y === undefined) return []
    const delta = deltas.get(comment.pageId)
    return delta ? [{ ...comment, pageId, x: comment.x + delta.x, y: comment.y + delta.y }] : []
  })
  return {
    pages: [{ ...target, name, sections, landingSectionId: sections[0]!.id }],
    frameMoves,
    guides,
    comments: movedComments,
  }
}
