import { createContext } from 'react'
import type { Frame } from '../../shared/types'
import type { Viewport } from '../lib/store'

/** The Stage's screen-space layer the selected frame's size badge is portalled
 *  into: outside the zoomed world, so it keeps its size, its gap to the frame
 *  and crisp text at every zoom. Frame names are not here: they sit inside
 *  their frame so they stack with it. Null outside a Stage. */
export const FrameLabelLayer = createContext<HTMLElement | null>(null)

/** The Stage's screen-space layer an open comment thread is portalled into,
 *  above the size badges, so no badge covers it (CommentPin keeps it on its
 *  pin). Null outside a Stage, where the thread hangs off its pin. */
export const CommentThreadLayer = createContext<HTMLElement | null>(null)

type FrameTitleBox = Pick<Frame, 'x' | 'y' | 'width' | 'height' | 'rotation'>
type TitleBounds = { left: number; right: number; top: number; bottom: number }
type Title = { element: HTMLDivElement; bounds: TitleBounds; zoom: number }

function titleBounds(frame: FrameTitleBox): TitleBounds {
  const angle = ((frame.rotation ?? 0) * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const centerX = frame.x + (frame.width + frame.height * sin) / 2
  const centerY = frame.y + (frame.height * (1 - cos)) / 2
  const halfX = Math.abs(frame.width * cos) / 2
  const halfY = Math.abs(frame.width * sin) / 2
  return { left: centerX - halfX, right: centerX + halfX, top: centerY - halfY, bottom: centerY + halfY }
}

/* Bounds cover the transformed top edge. Allow space for the fixed screen-px
   title, gap and badges, including when they extend sideways under rotation. */
const TITLE_MARGIN = 64

export function createFrameTitleZoom(initial: Viewport) {
  const titles = new Set<Title>()
  const pending = new Set<Title>()
  let viewport = initial

  const register = (element: HTMLDivElement, frame: FrameTitleBox) => {
    const title = { element, bounds: titleBounds(frame), zoom: viewport.zoom }
    element.style.setProperty('--zoom', String(title.zoom))
    titles.add(title)
    return () => {
      titles.delete(title)
      pending.delete(title)
    }
  }

  function update(next: Viewport, size: { width: number; height: number }) {
    const changed = next.zoom !== viewport.zoom
    viewport = next
    if (!changed && pending.size === 0) return

    const { x, y, zoom } = next
    const { width, height } = size
    const cssZoom = String(zoom)
    for (const title of changed ? titles : pending) {
      if (title.zoom === zoom) {
        pending.delete(title)
        continue
      }
      const bounds = title.bounds
      const outside =
        width > 0 &&
        height > 0 &&
        (x + bounds.right * zoom < -TITLE_MARGIN ||
          x + bounds.left * zoom > width + TITLE_MARGIN ||
          y + bounds.bottom * zoom < -TITLE_MARGIN ||
          y + bounds.top * zoom > height + TITLE_MARGIN)
      if (outside) {
        pending.add(title)
        continue
      }
      title.element.style.setProperty('--zoom', cssZoom)
      title.zoom = zoom
      pending.delete(title)
    }
  }

  return { register, update }
}

/** Scales names inside their original frame stack without relaying new zoom
 *  values to offscreen title layouts. Null in fixtures without a Stage. */
export const FrameTitleZoom = createContext<ReturnType<typeof createFrameTitleZoom>['register'] | null>(null)
