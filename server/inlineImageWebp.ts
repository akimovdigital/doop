import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { encodeImageForStorage } from './imageWebp.ts'

const DATA_IMAGE = /data:(image\/(?:png|jpeg|tiff));base64,([a-z0-9+/=]+)/gi
const IMAGE_ATTRIBUTES = new Set(['src', 'srcset', 'poster', 'style', 'background', 'fill', 'stroke'])

interface Range {
  startOffset: number
  endOffset: number
}

/** Optimize newly imported image data without reserializing the markup or
 * changing existing URLs, scripts, font data, or SVG markup. */
export async function optimizeImportedImages(html: string, existing = ''): Promise<string> {
  if (!/data:image\/(?:png|jpeg|tiff);base64,/i.test(html)) return html
  const ranges: Range[] = []
  const nodes: Tree.Node[] = [parse(html, { sourceCodeLocationInfo: true })]
  while (nodes.length > 0) {
    const node = nodes.pop()!
    if ('childNodes' in node) for (const child of node.childNodes) nodes.push(child)
    if (!('tagName' in node)) continue
    const locations = node.sourceCodeLocation
    if (node.tagName === 'style' && locations?.startTag && locations.endTag)
      ranges.push({ startOffset: locations.startTag.endOffset, endOffset: locations.endTag.startOffset })
    for (const [name, location] of Object.entries(locations?.attrs ?? {})) {
      if (IMAGE_ATTRIBUTES.has(name) || (node.tagName === 'image' && (name === 'href' || name === 'xlink:href')))
        ranges.push(location)
    }
  }

  const encodings = new Map<string, string>()
  const parts: string[] = []
  let cursor = 0
  for (const { startOffset, endOffset } of ranges.sort((a, b) => a.startOffset - b.startOffset)) {
    for (const match of html.slice(startOffset, endOffset).matchAll(DATA_IMAGE)) {
      const [original, mime, data] = match
      if (existing.includes(original)) continue
      let replacement = encodings.get(original)
      if (replacement === undefined) {
        const result = await encodeImageForStorage(Buffer.from(data!, 'base64'), mime!.toLowerCase())
        replacement = result.converted ? `data:image/webp;base64,${result.buffer.toString('base64')}` : original
        if (replacement.length >= original.length) replacement = original
        encodings.set(original, replacement)
      }
      if (replacement === original) continue
      const start = startOffset + match.index
      parts.push(html.slice(cursor, start), replacement)
      cursor = start + original.length
    }
  }
  return parts.length ? parts.join('') + html.slice(cursor) : html
}
