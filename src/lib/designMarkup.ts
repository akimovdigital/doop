export type MarkupTool = 'draw' | 'ellipse' | 'rectangle' | 'arrow'
export type MarkupPoint = { x: number; y: number }
export interface MarkupStroke {
  tool: MarkupTool
  points: MarkupPoint[]
}

export const markupStrokeWidth = 2
// Matches the preview accent, while remaining usable in a standalone PNG renderer.
const standaloneAccent = '#0177d3'

export function constrainMarkup(tool: MarkupTool, start: MarkupPoint, end: MarkupPoint): MarkupPoint {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (tool === 'arrow') {
    const step = Math.PI / 4
    const angle = Math.round(Math.atan2(dy, dx) / step) * step
    const length = Math.hypot(dx, dy)
    return { x: start.x + length * Math.cos(angle), y: start.y + length * Math.sin(angle) }
  }
  if (tool === 'ellipse' || tool === 'rectangle') {
    const size = Math.max(Math.abs(dx), Math.abs(dy))
    return { x: start.x + (dx < 0 ? -size : size), y: start.y + (dy < 0 ? -size : size) }
  }
  return end
}

function pointString({ x, y }: MarkupPoint) {
  return `${x} ${y}`
}

export function markupPath({ tool, points }: MarkupStroke): string {
  const start = points[0]
  const end = points.at(-1)
  if (!start || !end || points.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))) return ''
  if (tool === 'draw') return points.length > 1 ? `M ${points.map(pointString).join(' L ')}` : ''
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (tool === 'arrow') {
    const length = Math.hypot(dx, dy)
    if (!length) return ''
    const head = Math.min(12, length * 0.4)
    const x = (dx / length) * head
    const y = (dy / length) * head
    const left = { x: end.x - x - y * 0.5, y: end.y - y + x * 0.5 }
    const right = { x: end.x - x + y * 0.5, y: end.y - y - x * 0.5 }
    return `M ${pointString(start)} L ${pointString(end)} M ${pointString(left)} L ${pointString(end)} L ${pointString(right)}`
  }
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  const width = Math.abs(dx)
  const height = Math.abs(dy)
  if (!width || !height) return ''
  if (tool === 'rectangle') return `M ${x} ${y} h ${width} v ${height} h ${-width} Z`
  const rx = width / 2
  const ry = height / 2
  return `M ${x} ${y + ry} a ${rx} ${ry} 0 1 0 ${width} 0 a ${rx} ${ry} 0 1 0 ${-width} 0 Z`
}

export function undoMarkup(markup: readonly MarkupStroke[]): MarkupStroke[] {
  return markup.slice(0, -1)
}

/** SVG for compositing onto a screenshot crop. The box and strokes share page coordinates. */
export function renderMarkupSvg(
  markup: readonly MarkupStroke[],
  box: { x: number; y: number; width: number; height: number },
): string {
  const { x, y, width, height } = box
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return ''
  const paths = markup
    .map(markupPath)
    .filter(Boolean)
    .map((d) => `<path d="${d}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}" fill="none" stroke="${standaloneAccent}" stroke-width="${markupStrokeWidth}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
}
