import type { ClipRect } from './frameRaster'

export interface CropViewport {
  width: number
  height: number
  scrollX: number
  scrollY: number
}

/** Also serialized into the sandbox bootstrap. Keep its dependencies local. */
export function planDesignCrop(rects: ClipRect[], viewport: CropViewport, dpr: number) {
  function clipToViewport(rect: ClipRect): ClipRect | null {
    const left = Math.max(0, Math.floor(rect.x))
    const top = Math.max(0, Math.floor(rect.y))
    const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width))
    const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height))
    return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null
  }

  const visible = rects.filter(clipToViewport)
  if (!visible.length) return null
  const padding = 8
  const left = Math.min(...visible.map((rect) => rect.x)) - padding
  const top = Math.min(...visible.map((rect) => rect.y)) - padding
  const right = Math.max(...visible.map((rect) => rect.x + rect.width)) + padding
  const bottom = Math.max(...visible.map((rect) => rect.y + rect.height)) + padding
  const clip = clipToViewport({ x: left, y: top, width: right - left, height: bottom - top })
  if (!clip) return null
  const scale = Math.min(Math.max(1, dpr), 2, 1200 / Math.max(clip.width, clip.height))
  return { clip, viewport, scale }
}

export interface FrameCropRequest {
  selectors: (string | undefined)[]
  region?: ClipRect
  regionInPage?: boolean
  textEdit?: { selector: string; before: string; after: string }
  geometryOnly?: boolean
}

export type CropPlan = NonNullable<ReturnType<typeof planDesignCrop>>
export interface FrameCropReply {
  plan: CropPlan | null
  png: Blob | null
}

/** Serialized into the sandbox bootstrap so the opaque iframe reads its own DOM.
 * Capture computed styles synchronously, then resolve raster resources without
 * touching the live document or running its scripts in the SVG. */
export async function paintFrameCrop(
  { clip, viewport, scale }: CropPlan,
  bleed: number,
  textEdit: FrameCropRequest['textEdit'],
  proxyResource?: (url: string, signal: AbortSignal) => Promise<Blob>,
): Promise<Blob> {
  const signal = AbortSignal.timeout(2200)
  const html = 'http://www.w3.org/1999/xhtml'
  const target = document.implementation.createHTMLDocument()
  const source = document.documentElement
  const left = clip.x + bleed
  const top = clip.y + bleed
  const width = Math.max(1, Math.round(clip.width * scale))
  const height = Math.max(1, Math.round(clip.height * scale))
  // Selection uses the iframe's viewport CSS pixels. Paint the SVG at the
  // document origin, at one pixel per CSS pixel. WebKit can shift positioned
  // or transformed HTML layers when the SVG scales or translates its
  // foreignObject. Apply scroll in the canvas and DPR only to the output.
  const dx = left + viewport.scrollX
  const dy = top + viewport.scrollY
  const rasterWidth = Math.max(viewport.width + 2 * bleed, dx + clip.width)
  const rasterHeight = Math.max(viewport.height + 2 * bleed, dy + clip.height)
  // A deep document scroll can make the origin-aligned raster too large
  // even when the exported crop is small. Use the ordinary error fallback.
  const probePixels = 8
  if (rasterWidth > 16_384 || rasterHeight > 16_384 || (rasterWidth + probePixels) * rasterHeight > 16_000_000)
    throw new Error('Crop raster exceeds the pixel budget')
  const work: Promise<void>[] = []
  const resources = new Map<string, Promise<string>>()
  const usedFonts = new Set<string>()
  const loadedFonts = Array.from(document.fonts).filter((face) => face.status === 'loaded')
  let css = ''
  let nextPseudo = 0
  let elements = 0
  let bytes = 0
  const edited = textEdit && document.querySelector(textEdit.selector)
  const scrolls = viewport.scrollX !== 0 || viewport.scrollY !== 0

  function inCrop(rect: DOMRect) {
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > left &&
      rect.bottom > top &&
      rect.left < left + clip.width &&
      rect.top < top + clip.height
    )
  }

  async function readResource(url: string): Promise<Blob> {
    try {
      const response = await fetch(url, { credentials: 'omit', signal })
      if (!response.ok) throw new Error('Crop resource is unavailable')
      return await response.blob()
    } catch (error) {
      signal.throwIfAborted()
      if (!proxyResource || !/^https?:/i.test(url)) throw error
      return proxyResource(url, signal)
    }
  }

  async function readImageForSvg(blob: Blob) {
    // An AVIF decoded independently can be drawn in WKWebView even when its
    // SVG image renderer leaves a nested AVIF resource blank.
    if (blob.type !== 'image/avif') return blob
    const bitmap = await createImageBitmap(blob)
    try {
      const scale = Math.min(1, Math.max(width, height) / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('No 2D crop image context')
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('Cannot encode crop image'))), 'image/png')
      })
    } finally {
      bitmap.close()
    }
  }

  function dataUrl(raw: string, base: string): Promise<string> {
    if (!raw || /^(?:data:|#)/i.test(raw)) return Promise.resolve(raw)
    const url = new URL(raw, base)
    if (!/^(https?:|blob:)$/.test(url.protocol)) throw new Error('Unsupported crop resource URL')
    const fragment = url.hash
    url.hash = ''
    let pending = resources.get(url.href)
    if (!pending) {
      pending = readResource(url.href)
        .then(readImageForSvg)
        .then((blob) => {
          bytes += blob.size
          if (bytes > 8_000_000) throw new Error('Crop resources exceed the byte budget')
          return new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onerror = () => reject(reader.error)
            reader.onload = () => {
              const url = String(reader.result)
              if (!blob.type.startsWith('image/')) return resolve(url)
              const decoded = new Image()
              decoded.src = url
              void decoded.decode().then(() => resolve(url), reject)
            }
            reader.readAsDataURL(blob)
          })
        })
      resources.set(url.href, pending)
    }
    return pending.then((url) => url + fragment)
  }

  async function inlineUrls(value: string, base: string) {
    // Resolve URL-only image sets at the live device density before loading
    // resources. An SVG image may pick a different image-set candidate.
    const imageSet =
      /(?:-webkit-)?image-set\(((?:url\("[^"]*"\)\s+[\d.]+(?:dppx|x)(?:\s+type\("[^"]+"\))?(?:,\s*|(?=\))))+)\)/gi
    const candidate = /(url\("[^"]*"\))\s+([\d.]+)(?:dppx|x)/gi
    value = value.replace(imageSet, (_whole, list: string) => {
      const options = [...list.matchAll(candidate)].sort((a, b) => Number(a[2]) - Number(b[2]))
      return (options.find((entry) => Number(entry[2]) >= devicePixelRatio) ?? options.at(-1))?.[1] ?? _whole
    })
    const parts = [...value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi)]
    const urls = await Promise.all(parts.map((part) => dataUrl((part[1] ?? part[2] ?? part[3] ?? '').trim(), base)))
    let index = 0
    return value.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)'"]*)\s*\)/gi, () => 'url("' + urls[index++] + '")')
  }

  function normalizedFamily(family: string) {
    return family
      .trim()
      .replace(/^(["'])|(["'])$/g, '')
      .toLowerCase()
  }

  function declarations(style: CSSStyleDeclaration, visible: boolean, definition?: SVGElement) {
    const inherited = definition?.parentElement && getComputedStyle(definition.parentElement)
    let result = ''
    for (let i = 0; i < style.length; i++) {
      const name = style.item(i)
      // The computed value already contains the current animation/transition sample.
      if (/^(?:animation|transition|view-transition|scrollbar|--)/.test(name)) continue
      if (name.startsWith('-') && !/^-(?:webkit-(?:box-|line-clamp|text-|mask-|background-))/.test(name)) continue
      let value = style.getPropertyValue(name)
      // A referenced SVG definition inherits paint from the <use> instance.
      if (definition && /^(?:color|fill(?:-|$)|stroke(?:-|$))/.test(name)) {
        const specified = definition.style.getPropertyValue(name)
        if (specified) value = specified
        else if (definition.hasAttribute(name) || value === inherited?.getPropertyValue(name)) continue
      }
      if (value && (visible || !/url\(/i.test(value))) result += name + ':' + value + ';'
    }
    if (visible) for (const family of style.fontFamily.split(',')) usedFonts.add(normalizedFamily(family))
    return result
  }

  function setCss(clone: Element, style: string, base: string, pseudo?: string) {
    function applyStyle(inlined: string) {
      if (pseudo) css += pseudo + '{' + inlined + '}\n'
      else clone.setAttribute('style', inlined)
    }
    if (/url\(/i.test(style)) work.push(inlineUrls(style, base).then(applyStyle))
    else applyStyle(style)
  }

  function copy(el: Element, parentPaints = true, inDefinition = false): Element | null {
    const tag = el.localName
    if (['script', 'head', 'style', 'link', 'base', 'meta', 'template'].includes(tag)) return null
    if (tag === 'picture' && getComputedStyle(el).display === 'contents') {
      const image = el.querySelector('img')
      if (image) return copy(image, parentPaints)
    }
    if (++elements > 4000) throw new Error('Crop document exceeds the element budget')
    const style = getComputedStyle(el)
    if (style.display === 'none') return null
    const paints = parentPaints && Number(style.opacity) !== 0
    const rect = el.getBoundingClientRect()
    const visible = paints && style.visibility === 'visible' && inCrop(rect)
    // Retain the layout box of offscreen blocks. Descendants with transformed
    // or out-of-flow boxes may still paint inside the crop, so check those
    // bounds before dropping a subtree.
    const offscreen =
      rect.right < left - 32 ||
      rect.bottom < top - 32 ||
      rect.left > left + clip.width + 32 ||
      rect.top > top + clip.height + 32
    const prune =
      el.namespaceURI === html &&
      /^(block|flex|grid|flow-root)$/.test(style.display) &&
      style.width.endsWith('px') &&
      style.height.endsWith('px') &&
      offscreen &&
      !Array.from(el.querySelectorAll('*')).some((child) => inCrop(child.getBoundingClientRect()))
    if (visible && (el.shadowRoot || ['iframe', 'object', 'embed'].includes(tag)))
      throw new Error('Crop contains an unsupported element: ' + tag)
    if (visible && (el.scrollLeft || el.scrollTop) && el !== document.scrollingElement)
      throw new Error('Crop contains a scrolled container')
    if (scrolls && visible && (style.position === 'fixed' || style.position === 'sticky'))
      throw new Error('Crop contains an anchored element on a scrolled page')

    // Use an inert document. Constructing custom elements or copying attributes
    // in the live document can run the site's callbacks during capture.
    const clone = target.createElementNS(el.namespaceURI, tag === 'canvas' || tag === 'video' ? 'img' : tag)
    for (const attr of el.attributes) {
      if (
        !/^(?:[a-z_][\w.-]*|xlink:href|xml:space)$/i.test(attr.name) ||
        /^(?:on|style$|src$|srcset$|sizes$|loading$|poster$|autoplay$|background$|data-doop-crop-)/i.test(attr.name)
      )
        continue
      if (attr.localName === 'href' && !attr.value.startsWith('#')) continue
      clone.setAttributeNS(attr.namespaceURI, attr.name, attr.value)
    }

    const definition = el instanceof SVGElement && (inDefinition || tag === 'symbol' || tag === 'defs') ? el : undefined
    let computed = declarations(style, visible, definition)
    if (el === source) computed += 'overflow:visible;'
    setCss(clone, computed, el.baseURI)
    if (visible && el instanceof HTMLCanvasElement) clone.setAttribute('src', el.toDataURL())
    if (visible && el instanceof HTMLVideoElement) {
      let painted = false
      const paintsPoster = el.poster && el.crossOrigin === null && /^https?:/i.test(el.currentSrc)
      if (!paintsPoster && el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && el.videoWidth && el.videoHeight) {
        const video = document.createElement('canvas')
        video.width = Math.min(el.videoWidth, width)
        video.height = Math.max(1, Math.round((video.width * el.videoHeight) / el.videoWidth))
        const context = video.getContext('2d')
        if (!context) throw new Error('No 2D context for the video frame')
        context.drawImage(el, 0, 0, video.width, video.height)
        try {
          clone.setAttribute('src', video.toDataURL())
          painted = true
        } catch (error) {
          // A site's own poster can still represent a video whose pixels are
          // cross-origin, without rerendering all the other live DOM.
          if (!(error instanceof DOMException) || error.name !== 'SecurityError' || !el.poster) throw error
        }
      }
      if (!painted && el.poster) work.push(dataUrl(el.poster, el.baseURI).then((url) => clone.setAttribute('src', url)))
    }
    if (el instanceof HTMLImageElement && el.currentSrc) {
      if (visible && (!el.complete || !el.naturalWidth)) throw new Error('Crop image has not loaded')
      if (visible) work.push(dataUrl(el.currentSrc, el.baseURI).then((url) => clone.setAttribute('src', url)))
    }
    if (el instanceof HTMLInputElement) {
      clone.setAttribute('value', el.value)
      clone.toggleAttribute('checked', el.checked)
    }
    if (el instanceof HTMLOptionElement) clone.toggleAttribute('selected', el.selected)
    if (tag === 'image' || tag === 'use') {
      const href = el.getAttribute('href') ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
      if (visible && href && !href.startsWith('#'))
        work.push(dataUrl(href, el.baseURI).then((url) => clone.setAttribute('href', url)))
    }

    // Generated content is part of the live picture, including pseudo-elements
    // styled by an external stylesheet whose CSSOM the sandbox cannot read.
    if (visible) {
      for (const pseudo of ['::before', '::after', '::marker']) {
        if (pseudo === '::marker' && style.display !== 'list-item') continue
        const generated = getComputedStyle(el, pseudo)
        if (generated.content === 'none' || (generated.content === 'normal' && pseudo !== '::marker')) continue
        const id = String(++nextPseudo)
        clone.setAttribute('data-doop-crop-' + pseudo.slice(2), id)
        const selector = '[data-doop-crop-' + pseudo.slice(2) + '="' + id + '"]' + pseudo
        setCss(clone, declarations(generated, true), el.baseURI, selector)
      }
    }

    if (prune) return clone
    if (el instanceof HTMLTextAreaElement) clone.textContent = el.value
    else if (el === edited && textEdit && el.textContent === textEdit.before) clone.textContent = textEdit.after
    else {
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) clone.append(child.textContent ?? '')
        if (child instanceof Element) {
          const node = copy(child, paints, !!definition)
          if (node) clone.append(node)
        }
      }
    }
    return clone
  }

  function fontRange(range: string) {
    return (range || 'U+0-10FFFF').replace(/\s/g, '').toUpperCase()
  }

  function fontFaces(rules: CSSRuleList, base: string) {
    for (const rule of rules) {
      if (rule instanceof CSSFontFaceRule) {
        const fontBase = rule.parentStyleSheet?.href ?? base
        const family = normalizedFamily(rule.style.getPropertyValue('font-family'))
        const range = fontRange(rule.style.getPropertyValue('unicode-range'))
        if (
          usedFonts.has(family) &&
          loadedFonts.some((face) => normalizedFamily(face.family) === family && fontRange(face.unicodeRange) === range)
        )
          work.push(
            inlineUrls(rule.cssText, fontBase).then((face) => {
              css += face + '\n'
            }),
          )
      } else if (rule instanceof CSSImportRule && rule.styleSheet && matchMedia(rule.media.mediaText).matches) {
        fontFaces(rule.styleSheet.cssRules, rule.href)
      } else if (rule instanceof CSSGroupingRule) {
        if (!(rule instanceof CSSMediaRule) || matchMedia(rule.conditionText).matches) fontFaces(rule.cssRules, base)
      }
    }
  }

  let root: Element | null
  try {
    root = copy(source)
    if (!root) throw new Error('No visible crop document')
    if (loadedFonts.some((font) => usedFonts.has(normalizedFamily(font.family)))) {
      for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
        if (sheet.disabled || (sheet.media.mediaText && !matchMedia(sheet.media.mediaText).matches)) continue
        try {
          fontFaces(sheet.cssRules, sheet.href ?? document.baseURI)
        } catch (error) {
          // An opaque document can display an external sheet without being
          // able to inspect it. Only fetch the bytes if its server allows CORS.
          if (!sheet.href || !(error instanceof DOMException) || error.name !== 'SecurityError') throw error
          const base = sheet.href
          work.push(
            readResource(base).then(async (blob) => {
              const readable = new CSSStyleSheet()
              readable.replaceSync(await blob.text())
              // This runs asynchronously, so wait for the font reads it adds, too.
              const first = work.length
              fontFaces(readable.cssRules, base)
              await Promise.all(work.slice(first))
            }),
          )
        }
      }
    }
    await Promise.all(work)
  } catch (error) {
    // Reads that started before a synchronous error still need rejection handlers.
    void Promise.allSettled(work)
    throw error
  }
  signal.throwIfAborted()

  const style = target.createElementNS(html, 'style')
  style.textContent = css
  root.prepend(style)
  const contents = new XMLSerializer().serializeToString(root)
  if (contents.length > 12_000_000) throw new Error('Crop SVG exceeds the byte budget')
  const image = new Image()
  const rootStyle = getComputedStyle(source)
  const bodyStyle = getComputedStyle(document.body)
  const background =
    rootStyle.backgroundColor === 'rgba(0, 0, 0, 0)' ? bodyStyle.backgroundColor : rootStyle.backgroundColor
  // The probe detects a blank foreignObject without entering the exported crop.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${rasterWidth + probePixels}" height="${rasterHeight}">
    <rect width="${rasterWidth}" height="${rasterHeight}" fill="${background}"/>
    <foreignObject width="${rasterWidth}" height="${rasterHeight}">${contents}</foreignObject>
    <foreignObject x="${rasterWidth}" width="${probePixels}" height="${rasterHeight}">
      <div xmlns="${html}" style="width:100%;height:100%;background:#f0f"></div>
    </foreignObject></svg>`
  // A data URL is allowed by the proxy CSP and keeps foreignObject readable
  // on engines that taint it when loaded through an object URL.
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await image.decode()
  signal.throwIfAborted()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('No 2D crop context')
  context.drawImage(image, 0, 0)
  // WebKit can paint the SVG before its larger embedded images finish decoding.
  if (bytes > 128_000) {
    await new Promise((resolve) => setTimeout(resolve, 80))
    signal.throwIfAborted()
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0)
  }
  const probe = context.getImageData(canvas.width - probePixels / 2, Math.floor(canvas.height / 2), 1, 1).data
  if (probe[0] !== 255 || probe[1] !== 0 || probe[2] !== 255 || probe[3] !== 255)
    throw new Error('The browser did not paint the foreignObject')
  const png = document.createElement('canvas')
  png.width = width
  png.height = height
  const output = png.getContext('2d')
  if (!output) throw new Error('No 2D crop output context')
  output.fillStyle = '#fff'
  output.fillRect(0, 0, width, height)
  output.drawImage(canvas, dx, dy, clip.width, clip.height, 0, 0, width, height)
  return new Promise((resolve, reject) => {
    png.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Cannot encode live crop'))), 'image/png')
  })
}
