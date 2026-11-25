import type { FarOverviewBlock } from '../lib/farOverview'

const MAX_NODES = 96
const MAX_BLOCKS = 28
const MAX_DEPTH = 5
const MEDIA = /^(img|video|svg|canvas|picture|iframe)$/
const LINE = /^(h[1-6]|p|button|input|label|a|li)$/
const NON_VISUAL = /^(style|script|link|noscript|template)$/

/** Sample coarse layout from the live viewport, not a second copy of its HTML. */
export function readFarOverviewBlocks(): FarOverviewBlock[] {
  const body = document.body
  const width = window.innerWidth
  const height = window.innerHeight
  if (!body || !width || !height) return []

  const queue: { node: Element; depth: number }[] = []
  const blocks: FarOverviewBlock[] = []
  function addChildren(node: Element, depth: number) {
    for (let child = node.firstElementChild; child && queue.length < MAX_NODES; child = child.nextElementSibling) {
      queue.push({ node: child, depth })
    }
  }
  addChildren(body, 1)
  for (const { node, depth } of queue) {
    const tag = node.localName
    if (NON_VISUAL.test(tag)) continue
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.opacity === '0') continue
    const media = MEDIA.test(tag) || style.backgroundImage !== 'none'
    const line = !media && LINE.test(tag)
    if (!media && !line && depth < MAX_DEPTH) addChildren(node, depth + 1)
    const rect = node.getBoundingClientRect()
    const x = Math.max(0, rect.left)
    const y = Math.max(0, rect.top)
    const w = Math.min(width, rect.right) - x
    const h = Math.min(height, rect.bottom) - y
    if (style.visibility !== 'visible' || w < Math.max(4, width * 0.035) || h < Math.max(3, height * 0.007)) continue
    // Leave near-full-page wrappers out so they do not swallow the other blocks.
    if (!media && !line && w > width * 0.9 && h > height * 0.85 && node.childElementCount) continue
    if (!media && !line && depth > 2 && w * h < width * height * 0.035) continue
    blocks.push({
      x: x / width,
      y: y / height,
      width: w / width,
      height: h / height,
      kind: media ? 'media' : line ? 'line' : 'group',
    })
    if (blocks.length === MAX_BLOCKS) break
  }
  return blocks
}
