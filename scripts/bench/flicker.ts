import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { windowSize, type Capture, type CaptureRegion } from '../../tests/perf/protocol'

async function measure(file: string, region: CaptureRegion, width: number, height: number) {
  const x = width / windowSize.width
  const y = height / windowSize.height
  const left = Math.max(0, Math.round(region.x * x))
  const top = Math.max(0, Math.round(region.y * y))
  const { data, info } = await sharp(file)
    .extract({
      left,
      top,
      width: Math.min(width - left, Math.round(region.width * x)),
      height: Math.min(height - top, Math.round(region.height * y)),
    })
    .resize({ width: 220, height: 260, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#fff' })
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  const bins = new Uint32Array(256)
  let sum = 0
  for (let i = 0; i < data.length; i += info.channels) {
    const luma = Math.round(0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!)
    bins[luma]!++
    sum += luma
  }
  const mode = bins.indexOf(Math.max(...bins))
  const pixels = info.width * info.height
  const background = bins.slice(Math.max(0, mode - 4), mode + 5).reduce((a, b) => a + b, 0) / pixels
  return { meanLuma: sum / pixels, background }
}

type Measurements = Awaited<ReturnType<typeof measure>>
export function regionWentFlat(baseline: Measurements, current: Measurements) {
  return (
    (baseline.background < 0.99 && current.background > 0.997) ||
    (baseline.background < 0.97 &&
      1 - current.background < (1 - baseline.background) * 0.18 &&
      Math.abs(current.meanLuma - baseline.meanLuma) >= 4)
  )
}

export async function analyzeCapture(capture: Capture) {
  const { directory, points, regions } = capture
  if (!regions || !points.length) return
  const keys = ['left', 'right', 'stage'] as const
  const first = join(directory, points[0]!.file)
  const { width, height } = await sharp(first).metadata()
  const read = (file: string) => Promise.all(keys.map((key) => measure(file, regions[key], width, height)))
  const baseline = await read(first)
  if (baseline[0]!.background >= 0.99 || baseline[1]!.background >= 0.99) {
    throw new Error('Baseline image does not contain enough detail in both panels')
  }
  const frames = []
  const tiles: sharp.OverlayOptions[] = []
  const tileWidth = 256
  const tileHeight = 180
  const columns = 6
  for (const [index, point] of points.entries()) {
    const file = join(directory, point.file)
    const metrics = index ? await read(file) : baseline
    const flags = keys.filter((_, key) => regionWentFlat(baseline[key]!, metrics[key]!))
    const lumas = metrics.map(({ meanLuma }) => meanLuma)
    const uniformUi =
      metrics.every(({ background }) => background > 0.997) && Math.max(...lumas) - Math.min(...lumas) < 5
    const wholeUi = flags.includes('left') && flags.includes('right') && (flags.includes('stage') || uniformUi)
    frames.push({ ...point, metrics: Object.fromEntries(keys.map((key, i) => [key, metrics[i]])), flags, wholeUi })
    const left = (index % columns) * tileWidth
    const top = Math.floor(index / columns) * tileHeight
    const thumbnail = await sharp(file).resize(tileWidth, 160).png().toBuffer()
    const label = index ? `${point.file} ${flags.join(' ')}` : '0000.png baseline'
    const text = Buffer.from(
      `<svg width="${tileWidth}" height="20"><text x="6" y="14" font-family="monospace" font-size="12" fill="${flags.length ? '#ffa078' : '#eee'}">${label}</text></svg>`,
    )
    tiles.push({ input: thumbnail, left, top }, { input: text, left, top: top + 160 })
  }
  const sheet = join(directory, 'contact.png')
  const report = join(directory, 'frames.json')
  await sharp({
    create: {
      width: columns * tileWidth,
      height: Math.ceil(points.length / columns) * tileHeight,
      channels: 3,
      background: '#191919',
    },
  })
    .composite(tiles)
    .png()
    .toFile(sheet)
  const flagged = frames.filter(({ flags }) => flags.length > 0).length
  const panelsFlagged = frames.filter(({ flags }) => flags.includes('left') || flags.includes('right')).length
  const wholeUiFlagged = frames.filter(({ wholeUi }) => wholeUi).length
  const framesDuringGesture = points.length - 1
  await writeFile(
    report,
    JSON.stringify({ regions, flagged, panelsFlagged, wholeUiFlagged, framesDuringGesture, frames }, null, 2) + '\n',
  )
  return { flagged, panelsFlagged, wholeUiFlagged, framesDuringGesture, sheet, report }
}
