import type { Frame } from '../../shared/types'

export const framePresets = [20, 68, 200] as const
export type FramePreset = (typeof framePresets)[number]
export const sceneSeed = 20261123
export const canvasId = 'perf-canvas'

export function makeScene(count: FramePreset, seed = sceneSeed) {
  const live = count === 20 ? 15 : count === 68 ? 41 : 100
  const columns = count === 200 ? 10 : 7
  let state = seed >>> 0
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const frames: Frame[] = Array.from({ length: count }, (_, i) => {
    const long = i === live - 1
    const hue = 210 + Math.floor(random() * 70)
    const cards = Array.from(
      { length: long ? 64 : 16 },
      (_, j) => `<article><b>Card ${j + 1}</b><p>Sample · ${Math.floor(random() * 1000)}</p></article>`,
    ).join('')
    const html = `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;background:#eff1fa;color:#202348;font:16px system-ui}
      header{padding:12px 20px;background:linear-gradient(110deg,hsl(${hue} 62% 48%),#242957);color:white;display:flex;gap:12px;align-items:center}
      main{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;padding:12px}
      article{padding:6px;border-radius:5px;background:linear-gradient(130deg,#fff,#d9dcf6)}
      p{margin:4px 0 0;font-size:12px} footer{position:absolute;bottom:0;width:100%;padding:8px;background:#242957;color:#fff}
      ${i === 0 || long ? 'header svg{animation:glide 1.7s linear infinite alternate}@keyframes glide{to{transform:translateX(12px)}}' : ''}
      </style><header><svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="#fff"/></svg><b>Studio ${i + 1}</b></header>
      <main>${cards}</main><footer>Design review</footer>`
    return {
      id: `f${i}`,
      canvasId,
      name: `Frame ${i + 1}`,
      createdAt: i,
      updatedAt: 0,
      updatedBy: 'Bench',
      x: i < live ? (i % columns) * 500 : 50000 + i * 10000,
      y: Math.floor(i / columns) * 430,
      width: long ? 800 : 450,
      height: long ? 2200 : 360,
      html,
    }
  })
  return { frames, live, seed }
}

export function makeRealScene(value: unknown, sha256: string) {
  if (
    !value ||
    typeof value !== 'object' ||
    !('frames' in value) ||
    !Array.isArray(value.frames) ||
    !value.frames.length
  ) {
    throw new Error('Expected a nonempty frames array in the scene export')
  }
  if (!('source' in value) || typeof value.source !== 'string' || !value.source.trim()) {
    throw new Error('Expected a source name in the scene export')
  }
  const ids = new Set<string>()
  for (const [index, frame] of value.frames.entries()) {
    if (
      !frame ||
      typeof frame.id !== 'string' ||
      !frame.id ||
      ids.has(frame.id) ||
      typeof frame.html !== 'string' ||
      ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) ||
      frame.width <= 0 ||
      frame.height <= 0
    ) {
      throw new Error(`Invalid or duplicate frame at export index ${index}`)
    }
    ids.add(frame.id)
  }
  const frames = (value.frames as Frame[])
    .map((frame) => ({ ...frame, canvasId, pageId: undefined }))
    .sort((a, b) => a.x - b.x || a.y - b.y || (a.id < b.id ? -1 : Number(a.id > b.id)))
  return { frames, source: value.source, sha256 }
}
