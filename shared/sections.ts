import { rotatedBounds } from './frameRotation.ts'
import type { CanvasSection, Frame } from './types.ts'

type Box = Pick<CanvasSection, 'x' | 'y' | 'width' | 'height'>
type SectionFrame = Box & Pick<Frame, 'rotation'>

const FIT_TOLERANCE = 0.000_001

export function sectionContainsFrame(section: CanvasSection, frame: SectionFrame): boolean {
  const bounds = frame.rotation ? rotatedBounds(frame, frame.rotation) : frame
  return (
    bounds.x >= section.x - FIT_TOLERANCE &&
    bounds.y >= section.y - FIT_TOLERANCE &&
    bounds.x + bounds.width <= section.x + section.width + FIT_TOLERANCE &&
    bounds.y + bounds.height <= section.y + section.height + FIT_TOLERANCE
  )
}

/** A frame fitting more than one section is listed under its tightest container. */
export function sectionForFrame(sections: readonly CanvasSection[], frame: SectionFrame): CanvasSection | undefined {
  let closest: CanvasSection | undefined
  for (const section of sections) {
    if (
      (!closest || section.width * section.height < closest.width * closest.height) &&
      sectionContainsFrame(section, frame)
    ) {
      closest = section
    }
  }
  return closest
}

export const SECTION_FILL = { light: '#ebedf2', dark: '#30343c' } as const
export const SECTION_STROKE = { light: '#c3c9d3', dark: '#535b69' } as const
export const SECTION_RADIUS = 8
export const SECTION_BOUNDS_LIMIT = 1_000_000_000

/** A wrapper can be moved or resized independently of what it contains. */
export function sectionAround(frames: readonly SectionFrame[], padding = 64): Box | undefined {
  if (!frames.length) return
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const frame of frames) {
    const box = rotatedBounds(frame, frame.rotation ?? 0)
    left = Math.min(left, box.x)
    top = Math.min(top, box.y)
    right = Math.max(right, box.x + box.width)
    bottom = Math.max(bottom, box.y + box.height)
  }
  return { x: left - padding, y: top - padding, width: right - left + padding * 2, height: bottom - top + padding * 2 }
}

export function sectionSize(
  section: CanvasSection,
  axis: 'width' | 'height',
  value: number,
  lock = section.lockAspectRatio,
) {
  if (!lock) return { width: section.width, height: section.height, [axis]: value }
  const scale = Math.min(
    SECTION_BOUNDS_LIMIT / Math.max(section.width, section.height),
    Math.max(1 / Math.min(section.width, section.height), value / section[axis]),
  )
  return { width: section.width * scale, height: section.height * scale }
}

export function sectionPaint(color: string, opacity: number): string {
  return `${color}${Math.round((opacity / 100) * 255)
    .toString(16)
    .padStart(2, '0')}`
}
