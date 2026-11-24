import type { Frame } from '../../shared/types'
import { importedPageSource } from '../../shared/importSource'
import { colorAlpha } from './cssValues'
import { computedStyles, hasFrameDocument, readBrowseCropResource, snapshotFrame } from './frameBridge'

/**
 * Render a frame to an image in this browser: the document is inlined into
 * one self-contained SVG (every image, stylesheet and font as a data: URL,
 * since an SVG drawn as an image loads nothing from the network), drawn
 * onto a canvas and encoded. The engine that shows the frame paints the
 * export, so it is exactly what the person sees, with no server render.
 *
 * Anything that cannot be inlined (an image whose host sends no CORS
 * headers, a document the XML serializer cannot round-trip) rejects, and
 * the caller falls back to the server's renderer.
 */

export type RasterType = 'png' | 'jpeg'

/** A box inside the frame, in frame pixels. */
export interface ClipRect {
  x: number
  y: number
  width: number
  height: number
}

export interface RasterOptions {
  /** output pixel density; 2 for a retina export */
  scale: number
  type: RasterType
  /** JPEG only, 0-1 */
  quality?: number
  /** the whole render, fetches included, gives up when this fires */
  signal?: AbortSignal
  /** Preserve the live document's opaque canvas color beneath the SVG content. */
  documentBackground?: boolean
  /** Canvas snapshots can draw with missing resources. Exports use strict mode. */
  preview?: { onResourceFailure?: () => void; skipDeferredDocument?: boolean }
  /** the part of the frame to keep; the whole frame when unset. The
   *  document is still laid out and painted whole, so an element keeps
   *  every style its ancestors give it and whatever paints behind it. */
  clip?: ClipRect
}

const RESOURCE_FETCH_MS = 15_000
const LARGE_PREVIEW_SOURCE_PIXELS = 2 * 1024 * 1024

export async function rasterizeFrame(frame: Frame, opts: RasterOptions): Promise<Blob> {
  const signal = opts.signal ?? AbortSignal.timeout(RESOURCE_FETCH_MS)
  signal.throwIfAborted()
  const bridgeSignal = opts.preview ? signal : undefined
  const useLiveDocument = !opts.preview?.skipDeferredDocument || hasFrameDocument(frame.id)
  const [snapshot, background] = useLiveDocument
    ? await Promise.all([
        snapshotFrame(frame.id, bridgeSignal),
        opts.documentBackground ? documentBackground(frame.id, bridgeSignal) : undefined,
      ])
    : [null, undefined]
  signal.throwIfAborted()
  /* an unmounted frame renders from its saved HTML; a mounted one whose
     pixels cannot all be read is for the server */
  if (snapshot && snapshot.html === null) throw new Error('the frame cannot be drawn here')
  const html = snapshot?.html ?? frame.html
  const shrinkDecoder = opts.preview && !opts.clip && frame.width * frame.height > LARGE_PREVIEW_SOURCE_PIXELS
  const svg = await inlineDocument(html, {
    width: frame.width,
    height: frame.height,
    signal,
    preview: opts.preview,
    canvasId: frame.canvasId,
    previewScale: shrinkDecoder ? opts.scale : undefined,
  })
  signal.throwIfAborted()
  return drawSvg(svg, { width: frame.width, height: frame.height, ...opts, signal, background })
}

async function documentBackground(id: string, signal?: AbortSignal): Promise<string | undefined> {
  const properties = ['background-color', 'background-image', 'contain', 'display']
  const [root, body] = await Promise.all([
    computedStyles(id, 'html', properties, { signal }),
    computedStyles(id, 'body', properties, { signal }),
  ])
  if (!root || root.contain !== 'none' || root.display === 'none') return
  const rootColor = root['background-color']
  if (rootColor && colorAlpha(rootColor) === 1) return rootColor
  const bodyColor = body?.['background-color']
  // A body color propagated to the HTML canvas can extend below the body box.
  // Inside foreignObject it may paint only that box. Keep its opaque color
  // behind the SVG without changing the layout or double-blending alpha.
  if (
    rootColor &&
    colorAlpha(rootColor) === 0 &&
    root['background-image'] === 'none' &&
    body?.contain === 'none' &&
    body.display !== 'none' &&
    bodyColor &&
    colorAlpha(bodyColor) === 1
  )
    return bodyColor
}

/** Draw a live HTML snapshot with the preview viewport's media rules. */
export async function rasterizeHtml(
  html: string,
  viewport: { width: number; height: number },
  opts: RasterOptions,
): Promise<Blob> {
  const signal = opts.signal ?? AbortSignal.timeout(RESOURCE_FETCH_MS)
  const svg = await inlineDocument(html, { ...viewport, signal, standalone: true })
  return drawSvg(svg, { ...viewport, ...opts, signal })
}

/** The frame as an SVG file: the same self-contained document the raster
 *  draws (an HTML page inside a `foreignObject`, every resource inlined), so
 *  it opens anywhere a browser renders SVG but is not editable vector art.
 *  `clip` crops it by its viewBox; the white ground matches the PNG. */
export async function frameSvg(frame: Frame, opts: { clip?: ClipRect; signal?: AbortSignal } = {}): Promise<Blob> {
  const signal = opts.signal ?? AbortSignal.timeout(RESOURCE_FETCH_MS)
  const snapshot = await snapshotFrame(frame.id)
  if (snapshot && snapshot.html === null) throw new Error('the frame cannot be drawn here')
  const svg = await inlineDocument(snapshot?.html ?? frame.html, {
    width: frame.width,
    height: frame.height,
    signal,
    clip: opts.clip,
    background: '#fff',
    standalone: true,
  })
  return new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
}

/** The part of the frame a rendered box covers, in whole frame pixels
 *  (rounded outward, so an edge at a fraction is kept), or null when the
 *  box lies outside the frame: what the frame clips away is not in any
 *  render of it. */
export function clipToFrame(
  rect: { x: number; y: number; width: number; height: number },
  frame: { width: number; height: number },
): ClipRect | null {
  const left = Math.max(0, Math.floor(rect.x))
  const top = Math.max(0, Math.floor(rect.y))
  const right = Math.min(frame.width, Math.ceil(rect.x + rect.width))
  const bottom = Math.min(frame.height, Math.ceil(rect.y + rect.height))
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Cut `clip` out of a rendered frame image drawn at `scale` (the server's
 *  export, say) and encode the piece. */
export async function cropRaster(
  image: Blob,
  clip: ClipRect,
  opts: Pick<RasterOptions, 'scale' | 'type' | 'quality'>,
): Promise<Blob> {
  const bitmap = await createImageBitmap(image)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(clip.width * opts.scale))
  canvas.height = Math.max(1, Math.round(clip.height * opts.scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d canvas')
  ctx.drawImage(bitmap, -Math.round(clip.x * opts.scale), -Math.round(clip.y * opts.scale))
  return encode(canvas, opts)
}

interface InlineOptions {
  width: number
  height: number
  signal: AbortSignal
  preview?: RasterOptions['preview']
  canvasId?: string
  previewScale?: number
  /** the part of the document the SVG shows, by its viewBox; all of it when unset */
  clip?: ClipRect
  /** painted under the document; transparent when unset */
  background?: string
  /** the SVG is a file someone opens as a page (a browser tab, Quick
   *  Look), not an image drawn here: there the viewer's window is the
   *  viewport, so viewport units and media queries are settled against the
   *  frame first (`FrameViewport`) */
  standalone?: boolean
}

/* a number glued to a viewport unit, not inside a word or a base64 run */
const VIEWPORT_UNIT = /(?<![\w+/=.-])(-?\d*\.?\d+)(s|l|d)?(vh|vw|vmin|vmax)(?![\w+/=])/gi

/** `100vh` as the frame's px, `50vw` as half its width, and so on. */
export function pinViewportUnits(css: string, size: { width: number; height: number }): string {
  return css.replace(VIEWPORT_UNIT, (_whole, amount: string, _kind: string | undefined, unit: string) => {
    const lower = unit.toLowerCase()
    const side =
      lower === 'vh'
        ? size.height
        : lower === 'vw'
          ? size.width
          : lower === 'vmin'
            ? Math.min(size.width, size.height)
            : Math.max(size.width, size.height)
    return `${Math.round(Number(amount) * side * 100) / 10_000}px`
  })
}

/* CSSRule.MEDIA_RULE: the rules come from another window, so `instanceof`
   cannot tell them apart */
const MEDIA_RULE = 4
const PIXEL_MEDIA_SIZE = /^\(\s*(min-|max-)?(width|height)\s*:\s*(\d+(?:\.\d+)?|\.\d+)px\s*\)$/i
const VIEWPORT_MEDIA_FEATURE = /\b(?:width|height|orientation|aspect-ratio)\b/i

/** The frame's own viewport, for CSS that will be laid out somewhere else:
 *  viewport units become the frame's px, and `@media` rules are kept or
 *  dropped by what a window of the frame's size matches. A hidden iframe of
 *  that size answers the queries, so every feature (width, orientation,
 *  aspect ratio, the person's colour scheme) is judged as the canvas does. */
class FrameViewport {
  private frame: HTMLIFrameElement | null = null
  constructor(
    private readonly size: { width: number; height: number },
    private readonly scaledPreview = false,
  ) {}

  /** before url()s are inlined, so no data: URL is ever rewritten */
  units(css: string): string {
    return pinViewportUnits(css, this.size)
  }

  matches(query: string): boolean {
    const condition = query.trim()
    if (!condition) return true
    if (this.scaledPreview) {
      const pixelSize = PIXEL_MEDIA_SIZE.exec(condition)
      if (pixelSize) {
        const actual = pixelSize[2]?.toLowerCase() === 'width' ? this.size.width : this.size.height
        const threshold = Number(pixelSize[3])
        const range = pixelSize[1]?.toLowerCase()
        if (range === 'min-') return actual >= threshold
        if (range === 'max-') return actual <= threshold
        return actual === threshold
      }
      if (!VIEWPORT_MEDIA_FEATURE.test(condition) && !/prefers-color-scheme/i.test(condition))
        return window.matchMedia(condition).matches
    }
    return this.window().matchMedia(condition).matches
  }

  /** `css` with each top-level `@media` rule unwrapped when the frame
   *  matches it and dropped when not; the rest is the CSSOM's own text. */
  media(css: string): string {
    if (!/@media/i.test(css)) return css
    if (this.scaledPreview && typeof CSSStyleSheet.prototype.replaceSync === 'function' && !/@import\b/i.test(css)) {
      // Most preview sheets can be parsed without mounting a viewport and forcing layout.
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(css)
      return this.previewMedia(sheet.cssRules)
    }
    const doc = this.window().document
    const style = doc.createElement('style')
    style.textContent = css
    doc.head.append(style)
    try {
      const rules = style.sheet?.cssRules
      if (!rules) return css
      return this.scaledPreview ? this.previewMedia(rules) : this.serialize(rules)
    } finally {
      style.remove()
    }
  }

  dispose(): void {
    this.frame?.remove()
    this.frame = null
  }

  private serialize(rules: CSSRuleList): string {
    return Array.from(rules, (rule) => {
      if (rule.type !== MEDIA_RULE) return rule.cssText
      const media = rule as CSSMediaRule
      return this.matches(media.media.mediaText) ? this.serialize(media.cssRules) : ''
    }).join('\n')
  }

  /** Preserve grouping rules and nested declarations while fixing their media conditions. */
  private previewMedia(rules: CSSRuleList): string {
    this.pinMediaQueries(rules)
    return Array.from(rules, (rule) => rule.cssText).join('\n')
  }

  private pinMediaQueries(rules: CSSRuleList): void {
    for (const rule of rules) {
      if ('media' in rule) {
        const media = (rule as CSSMediaRule | CSSImportRule).media
        if (media.mediaText) media.mediaText = this.matches(media.mediaText) ? 'all' : 'not all'
      }
      if ('cssRules' in rule) this.pinMediaQueries((rule as CSSGroupingRule).cssRules)
    }
  }

  private window(): Window {
    if (!this.frame) {
      const frame = document.createElement('iframe')
      frame.setAttribute('aria-hidden', 'true')
      frame.tabIndex = -1
      frame.style.cssText = `position:fixed;left:-100000px;top:0;border:0;visibility:hidden;width:${this.size.width}px;height:${this.size.height}px`
      document.body.append(frame)
      /* laid out now, so its media queries see its size */
      void frame.offsetWidth
      this.frame = frame
    }
    const win = this.frame.contentWindow
    if (!win) throw new Error('no viewport to match media against')
    return win
  }
}

/* what would run once the SVG is opened as a page: inline handlers, and
   links or forms into script */
const SCRIPT_URL = /^\s*(javascript|vbscript):/i
const URL_ATTRS = ['href', 'xlink:href', 'src', 'action', 'formaction'] as const

function stripExecutable(doc: Document): void {
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) el.removeAttribute(attr.name)
    }
    for (const name of URL_ATTRS) {
      if (SCRIPT_URL.test(el.getAttribute(name) ?? '')) el.removeAttribute(name)
    }
  }
}

/* an XML name without a colon (XML 1.0 NCName) */
const NAME_START =
  'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D' +
  '\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}'
const NAME_REST = `${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`
const XML_ATTR_NAME = new RegExp(`^(xml:)?[${NAME_START}][${NAME_REST}]*$`, 'u')

/* HTML the XML serializer writes out verbatim but no XML parser reads back,
   which would make the SVG unreadable (and its raster fail): a comment
   holding `--` or ending in `-`, and an attribute named the way only HTML
   allows (`@click`, `:class`, `x-on:click`). Neither paints anything, the
   bindings least of all once the scripts are gone, so both go. A template's
   content is serialized too, though no walk of the document reaches it. */
function dropNonXml(root: Document | DocumentFragment): void {
  const comments = (root.ownerDocument ?? (root as Document)).createTreeWalker(root, NodeFilter.SHOW_COMMENT)
  const found: Node[] = []
  while (comments.nextNode()) found.push(comments.currentNode)
  for (const comment of found) comment.parentNode?.removeChild(comment)
  for (const el of root.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.namespaceURI === null && !XML_ATTR_NAME.test(attr.name)) el.removeAttributeNode(attr)
    }
    if (el instanceof HTMLTemplateElement) dropNonXml(el.content)
  }
}

/** One SVG, sized to the frame, holding the document with every external
 *  resource inlined. Exported for tests. */
export async function inlineDocument(html: string, opts: InlineOptions): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const base = new URL(doc.querySelector('base[href]')?.getAttribute('href') ?? '', document.baseURI).href
  // SVG media queries and viewport units see the decoder's pixel size,
  // even when the foreignObject is laid out in the viewBox's coordinates.
  const viewport = opts.standalone || opts.preview ? new FrameViewport(opts, !!opts.preview) : null
  const sourceUrl = importedPageSource(html) ?? doc.querySelector('link[rel="canonical"]')?.getAttribute('href')
  const source = opts.preview && opts.canvasId && sourceUrl ? { canvasId: opts.canvasId, url: sourceUrl } : undefined
  try {
    return await inlineInto(doc, base, new ResourceCache(opts.signal, viewport, opts.preview, source), viewport, opts)
  } finally {
    viewport?.dispose()
  }
}

async function inlineInto(
  doc: Document,
  base: string,
  resources: ResourceCache,
  viewport: FrameViewport | null,
  opts: InlineOptions,
): Promise<string> {
  const units = (css: string) => viewport?.units(css) ?? css
  const settleMedia = (css: string) => viewport?.media(css) ?? css

  /* nothing embeds inside an SVG image: a nested document would be a hole
     in the picture, so a frame holding one is for the server's browser */
  if (doc.querySelector('iframe, object, embed')) throw new Error('the frame embeds a document')
  /* nothing runs inside one either: scripts, and the <base> that has done its job */
  for (const el of doc.querySelectorAll('script, base, link:not([rel~="stylesheet"])')) el.remove()
  stripExecutable(doc)
  dropNonXml(doc)

  const work: Promise<void>[] = []
  for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
    work.push(
      (async () => {
        const href = new URL(link.getAttribute('href') ?? '', base).href
        const css = await resources.text(href)
        const style = doc.createElement('style')
        const media = link.getAttribute('media')
        if (media) style.setAttribute('media', media)
        style.textContent = settleMedia(await inlineCssUrls(units(css), href, resources))
        link.replaceWith(style)
      })(),
    )
  }
  for (const style of doc.querySelectorAll('style')) {
    work.push(
      (async () => {
        style.textContent = settleMedia(await inlineCssUrls(units(style.textContent ?? ''), base, resources))
      })(),
    )
  }
  for (const el of doc.querySelectorAll('[style]')) {
    const inline = units(el.getAttribute('style') ?? '')
    el.setAttribute('style', inline)
    if (!/url\(/i.test(inline)) continue
    work.push(
      (async () => {
        el.setAttribute('style', await inlineCssUrls(inline, base, resources))
      })(),
    )
  }
  for (const img of doc.querySelectorAll('img, input[type="image"], video[poster]')) {
    /* one source per image: the browser picked from srcset by the frame's
       own viewport, which is the width the SVG gets too, so src is right */
    img.removeAttribute('srcset')
    img.removeAttribute('sizes')
    img.removeAttribute('loading')
    const attr = img.tagName === 'VIDEO' ? 'poster' : 'src'
    work.push(inlineAttr(img, attr, base, resources))
  }
  for (const source of doc.querySelectorAll('picture > source')) source.remove()
  for (const image of doc.querySelectorAll('image')) {
    work.push(inlineAttr(image, image.hasAttribute('href') ? 'href' : 'xlink:href', base, resources))
  }
  await Promise.all(work)
  opts.signal.throwIfAborted()
  /* a sheet for one media applies or not, judged by the frame's viewport */
  if (viewport) {
    for (const style of doc.querySelectorAll('style[media]')) {
      if (viewport.matches(style.getAttribute('media') ?? '')) style.removeAttribute('media')
      else style.remove()
    }
  }

  /* the XML serializer gives an HTML document's root its xhtml namespace */
  const body = new XMLSerializer().serializeToString(doc.documentElement)
  const { width, height, clip } = opts
  const fit = opts.previewScale !== undefined && opts.previewScale < 1 ? opts.previewScale : undefined
  const outputWidth = fit ? Math.max(1, Math.round(width * fit)) : (clip?.width ?? width)
  const outputHeight = fit ? Math.max(1, Math.round(height * fit)) : (clip?.height ?? height)
  // Give the image decoder thumbnail dimensions while keeping the foreignObject in frame coordinates.
  const box = fit
    ? ` viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"`
    : clip
      ? ` viewBox="${clip.x} ${clip.y} ${clip.width} ${clip.height}"`
      : ''
  const ground = opts.background ? `<rect width="${width}" height="${height}" fill="${opts.background}"/>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}"${box}>` +
    `${ground}<foreignObject width="${width}" height="${height}">${body}</foreignObject></svg>`
  )
}

async function inlineAttr(el: Element, attr: string, base: string, resources: ResourceCache): Promise<void> {
  const raw = el.getAttribute(attr)
  if (!raw || isInlineUrl(raw)) return
  el.setAttribute(attr, await inlineUrl(raw, base, resources))
}

/** The data: URL for `ref`, keeping its fragment: `sprite.svg#icon` and
 *  `#svgView(...)` pick what an SVG shows. */
async function inlineUrl(
  ref: string,
  base: string,
  resources: ResourceCache,
  chain?: ReadonlySet<string>,
  stylesheet = false,
): Promise<string> {
  const url = new URL(ref, base)
  const fragment = url.hash
  url.hash = ''
  return (await resources.dataUrl(url.href, chain, stylesheet)) + fragment
}

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
const PREVIEW_CSS_URL = /(@import\s+)?url\(\s*(['"]?)([^'")]+)\2\s*\)/gi
/* `@import "x.css"` is `@import url("x.css")` without the function */
const CSS_IMPORT_STRING = /@import\s+(['"])([^'"]+)\1/gi
/* In a foreignObject the SVG, rather than the embedded HTML, is :root.
   Keep the selector's specificity and leave quoted values, comments and
   URLs intact. Imported styles use the same pass as inline styles. */
const CSS_DOCUMENT_ROOT =
  /(\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|url\([^)]*\)|\\[\s\S])|:root(?![\w-])/gi

function pinDocumentRoot(css: string): string {
  if (!/:root/i.test(css)) return css
  return css.replace(
    CSS_DOCUMENT_ROOT,
    (_, literal: string | undefined) => literal ?? ':where(svg:root > foreignObject > html):first-child',
  )
}

/** Every `url(...)` in `css` that points off the document becomes a data:
 *  URL; a stylesheet it imports is inlined the same way, recursively.
 *  `chain` is the stylesheets being inlined on the way here: one that
 *  imports itself again, however indirectly, is left empty at that point. */
async function inlineCssUrls(
  css: string,
  base: string,
  resources: ResourceCache,
  chain: ReadonlySet<string> = new Set(),
): Promise<string> {
  resources.signal.throwIfAborted()
  css = pinDocumentRoot(css).replace(CSS_IMPORT_STRING, '@import url("$2")')
  if (resources.preview) {
    const matches = new Map([...css.matchAll(PREVIEW_CSS_URL)].map((match) => [match[0], match]))
    const entries = await Promise.all(
      [...matches].map(async ([whole, match]) => {
        const ref = match[3]!.trim()
        if (!ref || isInlineUrl(ref)) return [whole, whole] as const
        const url = await inlineUrl(ref, base, resources, chain, !!match[1])
        return [whole, `${match[1] ?? ''}url("${url}")`] as const
      }),
    )
    const replacements = new Map(entries)
    return css.replace(PREVIEW_CSS_URL, (whole) => replacements.get(whole) ?? whole)
  }
  const refs = [...css.matchAll(CSS_URL)].map((m) => m[2]?.trim() ?? '').filter((ref) => ref && !isInlineUrl(ref))
  if (refs.length === 0) return css
  const replacements = new Map<string, string>()
  await Promise.all(
    [...new Set(refs)].map(async (ref) => {
      replacements.set(ref, await inlineUrl(ref, base, resources, chain))
    }),
  )
  return css.replace(CSS_URL, (whole, _quote: string, ref: string) => {
    const replacement = replacements.get(ref.trim())
    return replacement ? `url("${replacement}")` : whole
  })
}

/** data: carries its own bytes, `#id` points inside the document. A blob:
 *  URL is left to the fetch, which fails for another document's object
 *  URL and so hands the export to the server. */
function isInlineUrl(ref: string): boolean {
  return /^(data:|#|about:)/i.test(ref)
}

const PREVIEW_FETCH_MS = 1_500
const PREVIEW_PROXY_MS = 2_500
const PREVIEW_FAILURE_TTL_MS = 3_000
const PREVIEW_RESOURCE_TTL_MS = 60_000
const PREVIEW_RESOURCE_BYTES = 16 * 1024 * 1024
const PREVIEW_RESOURCE_ENTRIES = 256
const EMPTY_CSS = 'data:text/css,'
// Keep authored layout and aspect-ratio rules on the original element.
const TRANSPARENT_IMAGE = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E'

type PreviewResource = { blob: Blob | null; expires: number }
const previewResources = new Map<string, PreviewResource>()
let previewResourceBytes = 0

function forgetPreviewResource(url: string) {
  previewResourceBytes -= previewResources.get(url)?.blob?.size ?? 0
  previewResources.delete(url)
}

function fetchBlob(url: string, signal: AbortSignal): Promise<Blob> {
  return fetch(url, { signal, credentials: 'same-origin' }).then((res) => {
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`)
    return res.blob()
  })
}

async function previewBlob(
  url: string,
  signal: AbortSignal,
  source?: Parameters<typeof readBrowseCropResource>[0],
): Promise<Blob | null> {
  signal.throwIfAborted()
  const hit = previewResources.get(url)
  if (hit) {
    if (hit.expires > performance.now()) {
      previewResources.delete(url)
      previewResources.set(url, hit)
      return hit.blob
    }
    forgetPreviewResource(url)
  }
  const resource = new AbortController()
  const cancel = () => resource.abort(signal.reason)
  const timer = window.setTimeout(() => resource.abort(), PREVIEW_FETCH_MS)
  signal.addEventListener('abort', cancel, { once: true })
  const direct = await fetchBlob(url, resource.signal)
    .catch(() => null)
    .finally(() => {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
    })
  signal.throwIfAborted()
  const blob =
    direct ??
    (source
      ? await readBrowseCropResource(
          source,
          url,
          AbortSignal.any([signal, AbortSignal.timeout(PREVIEW_PROXY_MS)]),
        ).catch(() => null)
      : null)
  signal.throwIfAborted()
  if ((blob?.size ?? 0) <= PREVIEW_RESOURCE_BYTES) {
    forgetPreviewResource(url)
    const ttl = blob ? PREVIEW_RESOURCE_TTL_MS : PREVIEW_FAILURE_TTL_MS
    previewResources.set(url, { blob, expires: performance.now() + ttl })
    previewResourceBytes += blob?.size ?? 0
    for (const cachedUrl of previewResources.keys()) {
      if (previewResourceBytes <= PREVIEW_RESOURCE_BYTES && previewResources.size <= PREVIEW_RESOURCE_ENTRIES) break
      forgetPreviewResource(cachedUrl)
    }
  }
  return blob
}

/** Fetches, one per URL, as the bytes of everything inlined. A failed
 *  fetch rejects the whole render: a blank where an image belongs is not an
 *  export, and the server's renderer can still load it. */
class ResourceCache {
  private readonly pending = new Map<string, Promise<Blob | null>>()
  constructor(
    readonly signal: AbortSignal,
    /** settles each imported stylesheet as `inlineDocument` does the page's */
    private readonly viewport: FrameViewport | null = null,
    readonly preview?: RasterOptions['preview'],
    private readonly source?: Parameters<typeof readBrowseCropResource>[0],
  ) {}

  private async blob(url: string): Promise<Blob | null> {
    let pending = this.pending.get(url)
    if (!pending) {
      pending = this.preview ? previewBlob(url, this.signal, this.source) : fetchBlob(url, this.signal)
      this.pending.set(url, pending)
    }
    const blob = await pending
    if (!blob) this.preview?.onResourceFailure?.()
    return blob
  }

  async text(url: string): Promise<string> {
    return (await this.blob(url))?.text() ?? ''
  }

  async dataUrl(url: string, chain: ReadonlySet<string> = new Set(), stylesheet = false): Promise<string> {
    const blob = await this.blob(url)
    if (!blob) return stylesheet ? EMPTY_CSS : TRANSPARENT_IMAGE
    if (stylesheet || blob.type.startsWith('text/css')) {
      /* a stylesheet imported by another: its own url()s resolve against
         it, and an import cycle ends where it started */
      if (chain.has(url)) return EMPTY_CSS
      const own = this.viewport ? this.viewport.units(await blob.text()) : await blob.text()
      const inlined = await inlineCssUrls(own, url, this, new Set(chain).add(url))
      const css = this.viewport ? this.viewport.media(inlined) : inlined
      return toDataUrl(new Blob([css], { type: 'text/css' }))
    }
    return toDataUrl(blob)
  }
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('could not read resource'))
    reader.readAsDataURL(blob)
  })
}

interface DrawOptions extends RasterOptions {
  background?: string
  width: number
  height: number
}

/** Draw the SVG onto a canvas at `scale` and encode it, the whole frame
 *  or the `clip` of it. The canvas starts with the opaque document color
 *  when requested, and uses the same white paper as the server otherwise. */
async function drawSvg(svg: string, opts: DrawOptions): Promise<Blob> {
  /* a data: URL, not a blob: one — Chromium taints the canvas for a
     foreignObject SVG drawn from a blob URL, and the export needs toBlob */
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, opts.signal)
  const clip = opts.clip ?? { x: 0, y: 0, width: opts.width, height: opts.height }
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(clip.width * opts.scale))
  canvas.height = Math.max(1, Math.round(clip.height * opts.scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d canvas')
  ctx.fillStyle = '#fff'
  if (opts.background) ctx.fillStyle = opts.background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  /* the whole frame is drawn at scale, shifted so the clip lands at the origin */
  ctx.drawImage(
    image,
    -Math.round(clip.x * opts.scale),
    -Math.round(clip.y * opts.scale),
    Math.round(opts.width * opts.scale),
    Math.round(opts.height * opts.scale),
  )
  try {
    return await encode(canvas, opts, opts.preview ? opts.signal : undefined)
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const image = new Image()
    const cleanup = () => {
      signal?.removeEventListener('abort', abort)
      image.onload = image.onerror = null
    }
    const abort = () => {
      cleanup()
      image.removeAttribute('src')
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
    image.onload = () => {
      cleanup()
      resolve(image)
    }
    image.onerror = () => {
      cleanup()
      reject(new Error('the document could not be drawn'))
    }
    image.src = url
  })
}

function encode(
  canvas: HTMLCanvasElement,
  opts: Pick<RasterOptions, 'type' | 'quality'>,
  signal?: AbortSignal,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const abort = () => reject(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      canvas.toBlob(
        (blob) => {
          signal?.removeEventListener('abort', abort)
          if (blob) resolve(blob)
          else reject(new Error('could not encode the image'))
        },
        opts.type === 'jpeg' ? 'image/jpeg' : 'image/png',
        opts.type === 'jpeg' ? (opts.quality ?? 0.9) : undefined,
      )
    } catch (error) {
      signal?.removeEventListener('abort', abort)
      /* a tainted canvas throws a SecurityError here */
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
