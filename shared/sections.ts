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
