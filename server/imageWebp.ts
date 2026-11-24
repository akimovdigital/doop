import { debuglog } from 'node:util'

export interface ImageEncoding {
  buffer: Buffer
  mime: string
  converted: boolean
  before: number
  after: number
}

const SOURCE_FORMATS = new Map([
  ['image/jpeg', 'jpeg'],
  ['image/png', 'png'],
  ['image/tiff', 'tiff'],
])

/** libpng can expose an APNG as an ordinary single-page PNG. Check PNG chunk
 *  boundaries, since the same four letters can also appear inside image data. */
function isAnimatedPng(buffer: Buffer): boolean {
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset)
    const chunk = buffer.toString('ascii', offset + 4, offset + 8)
    if (chunk === 'acTL') return true
    if (chunk === 'IDAT' || chunk === 'IEND') return false
    offset += length + 12
  }
  return false
}

/** A candidate for new storage only. Leave existing WebP alone to avoid
 * generation loss, and leave the input usable whenever encoding fails. */
export async function toWebpIfSmaller(buffer: Buffer, mime: string): Promise<ImageEncoding> {
  const before = buffer.length
  const original = { buffer, mime, converted: false, before, after: before }
  const format = SOURCE_FORMATS.get(mime)
  if (!format || (format === 'png' && isAnimatedPng(buffer))) return original
  try {
    // Callers can load asset and screenshot helpers without loading the native codec.
    const { default: sharp } = await import('sharp')
    const image = sharp(buffer)
    const meta = await image.metadata()
    if (meta.format !== format || (meta.pages ?? 1) > 1) return original
    const transparent = meta.hasAlpha && !(await image.stats()).isOpaque
    // WebP cannot represent higher-bit-depth samples losslessly.
    if (transparent && meta.depth !== 'uchar') return original
    const candidate = await image.autoOrient().webp({ quality: 82, lossless: transparent, effort: 4 }).toBuffer()
    return candidate.length < before
      ? { buffer: candidate, mime: 'image/webp', converted: true, before, after: candidate.length }
      : original
  } catch {
    return original
  }
}

const debug = debuglog('doop-images')

export async function encodeImageForStorage(buffer: Buffer, mime: string): Promise<ImageEncoding> {
  const image = await toWebpIfSmaller(buffer, mime)
  if (mime.startsWith('image/')) debug('%s → %s, %d → %d bytes', mime, image.mime, image.before, image.after)
  return image
}
