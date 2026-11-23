export interface ScreenshotCrop {
  x: number
  y: number
  width: number
  height: number
  scale: number
}

/** CDP's clip starts in document coordinates, while the annotation uses the
 * scrolled viewport. Use the actual scroll offset, which can be clamped. */
export function screenshotCropClip(
  crop: ScreenshotCrop,
  viewport: { width: number; height: number },
  scroll: { x: number; y: number },
) {
  const width = Math.min(crop.width, viewport.width - crop.x)
  const height = Math.min(crop.height, viewport.height - crop.y)
  if (width <= 0 || height <= 0) return null
  return { x: crop.x + scroll.x, y: crop.y + scroll.y, width, height }
}
