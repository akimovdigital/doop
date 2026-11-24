import { createHmac, randomBytes } from 'node:crypto'
import { defaultTreeAdapter as tree, html, parse, serialize, type DefaultTreeAdapterTypes as Node } from 'parse5'
import { frameRuntime } from '../src/lib/frameRuntime'
import { fetchPinnedPublicUrl, PublicNetworkUrlError } from './publicUrl'

const LIMIT = 10_000_000
const TIMEOUT = 15_000
const REDIRECTS = [301, 302, 303, 307, 308]
const sessionKey = randomBytes(32)

// The iframe URL carries a public session ID. Only the authenticated editor
// obtains the corresponding proof, which the bootstrap keeps in its closure.
export function browseSessionToken(userId: string, canvasId: string, url: string, session: string) {
  return createHmac('sha256', sessionKey)
    .update(JSON.stringify([userId, canvasId, url, session]))
    .digest('base64url')
}

export class BrowseProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function httpUrl(value: string, base?: URL): URL {
  const url = URL.parse(value, base)
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) {
    throw new BrowseProxyError(400, 'Invalid browsing URL')
  }
  return url
}

function originAllowList(raw: string) {
  const origins = new Set(['http://127.0.0.1:8747'])
  for (const entry of raw.split(/[\s,]+/)) {
    const url = URL.parse(entry)
    if (url && url.href === url.origin + '/' && ['http:', 'https:'].includes(url.protocol)) origins.add(url.origin)
  }
  return origins
}

async function boundedBody(response: Response, signal: AbortSignal, limit = LIMIT) {
  const limitError = () =>
    new BrowseProxyError(413, limit === LIMIT ? 'Remote page exceeds 10 MB' : 'Crop resource exceeds the byte limit')
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw limitError()
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw limitError()
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  return Buffer.concat(chunks, size)
}

function injectedHtml(source: string, url: URL, nonce: string, token: string) {
  const doc = parse(source)
  const root = doc.childNodes.find((node): node is Node.Element => tree.isElementNode(node) && node.tagName === 'html')!
  const [head, body] = root.childNodes.filter(tree.isElementNode) as [Node.Element, Node.Element]
  const stack: Node.ParentNode[] = [doc]
  for (let parent = stack.pop(); parent; parent = stack.pop()) {
    for (const node of [...parent.childNodes]) {
      if (!tree.isElementNode(node)) continue
      if (
        ['base', 'frame', 'iframe', 'object', 'embed', 'portal'].includes(node.tagName) ||
        (node.tagName === 'meta' &&
          node.attrs.some(
            ({ name, value }) =>
              name === 'http-equiv' || name === 'charset' || (name === 'name' && value.toLowerCase() === 'referrer'),
          )) ||
        (node.tagName === 'link' &&
          node.attrs.some(({ name, value }) => name === 'rel' && !/^stylesheet$/i.test(value)))
      ) {
        tree.detachNode(node)
        continue
      }
      node.attrs = node.attrs.filter(
        ({ name }) => !name.startsWith('on') && !['ping', 'referrerpolicy', 'data-v-boot', 'nonce'].includes(name),
      )
      if (node.tagName === 'script' && !node.attrs.some(({ name }) => name === 'src' || name === 'href')) {
        node.attrs.push({ name: 'nonce', value: nonce })
      }
      if (node.tagName === 'template' && node.namespaceURI === html.NS.HTML)
        stack.push(tree.getTemplateContent(node as Node.Template))
      else stack.push(node)
    }
  }
  // A frameset replaces <body>. Serve its fallback markup in a regular body.
  if (body.tagName === 'frameset') {
    body.tagName = 'body'
    body.nodeName = 'body'
  }
  const base = tree.createElement('base', html.NS.HTML, [{ name: 'href', value: url.href }])
  if (head.childNodes[0]) tree.insertBefore(head, base, head.childNodes[0])
  else tree.appendChild(head, base)
  const script = tree.createElement('script', html.NS.HTML, [
    { name: 'nonce', value: nonce },
    { name: 'data-v-boot', value: '' },
  ])
  tree.insertText(script, frameRuntime({ token, url: url.href }))
  if (head.childNodes[1]) tree.insertBefore(head, script, head.childNodes[1])
  else tree.appendChild(head, script)
  return Buffer.from(serialize(doc))
}

async function load(
  rawUrl: string,
  allowList: string,
  signal: AbortSignal,
  request: typeof fetchPinnedPublicUrl,
  token: string,
) {
  const origins = originAllowList(allowList)
  let url = httpUrl(rawUrl)
  for (let count = 0; ; count++) {
    const response = await request(url, { redirect: 'manual', signal }, origins)
    const location = response.headers.get('location')
    if (location && REDIRECTS.includes(response.status)) {
      await response.body?.cancel()
      if (count === 5) throw new BrowseProxyError(502, 'Too many redirects')
      const next = httpUrl(location, url)
      if (next.origin !== url.origin && origins.has(next.origin)) {
        throw new BrowseProxyError(400, 'Redirect to a local development origin is blocked')
      }
      if (!location.includes('#')) next.hash = url.hash
      url = next
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new BrowseProxyError(502, 'Remote page could not be loaded')
    }
    const bytes = await boundedBody(response, signal)
    const contentType = response.headers.get('content-type') ?? ''
    const headers: Record<string, string> = {
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    }
    if (!/^text\/html(?:\s*;|$)/i.test(contentType)) {
      // The iframe endpoint handles documents. Download other bytes as inert data.
      headers['content-type'] = 'application/octet-stream'
      headers['content-disposition'] = 'attachment'
      return { headers, body: bytes }
    }

    const nonce = randomBytes(18).toString('base64')
    const origin = url.origin
    const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1] ?? 'utf-8'
    let decoder: TextDecoder
    try {
      decoder = new TextDecoder(charset)
    } catch {
      decoder = new TextDecoder()
    }
    const body = injectedHtml(decoder.decode(bytes), url, nonce, token)
    if (body.length > LIMIT) throw new BrowseProxyError(413, 'Remote page exceeds 10 MB')
    headers['content-type'] = 'text/html; charset=utf-8'
    headers['content-security-policy'] = [
      'sandbox allow-scripts allow-forms allow-popups',
      "frame-ancestors 'self'",
      "default-src 'none'",
      `script-src 'nonce-${nonce}' ${origin}`,
      `base-uri ${origin}`,
      `form-action ${origin}`,
      `connect-src ${origin}`,
      `style-src 'unsafe-inline' ${origin}`,
      `img-src data: ${origin}`,
      `font-src data: ${origin}`,
      `media-src ${origin}`,
    ].join('; ')
    return { headers, body }
  }
}

export async function loadBrowsePage(
  rawUrl: string,
  allowList: string,
  request = fetchPinnedPublicUrl,
  token = randomBytes(32).toString('base64url'),
) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      load(rawUrl, allowList, controller.signal, request, token),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new BrowseProxyError(504, 'Remote page timed out'))
          controller.abort()
        }, TIMEOUT)
      }),
    ])
  } catch (error) {
    if (error instanceof PublicNetworkUrlError) throw new BrowseProxyError(400, error.message)
    if (error instanceof BrowseProxyError) throw error
    throw new BrowseProxyError(502, 'Remote page could not be loaded')
  } finally {
    clearTimeout(timer)
  }
}

/** Static bytes for a live crop when the opaque frame cannot use CORS.
 * Keep them on the page's origin, pin the address, and never forward cookies
 * or follow redirects. The editor reconstructs a typed Blob from inert bytes. */
export async function loadBrowseCropResource(rawPage: string, rawAsset: string, allowList: string) {
  const page = httpUrl(rawPage)
  const asset = httpUrl(rawAsset)
  if (asset.origin !== page.origin) throw new BrowseProxyError(400, 'Crop resource must be on the page origin')
  const signal = AbortSignal.timeout(2000)
  try {
    const response = await fetchPinnedPublicUrl(asset, { redirect: 'manual', signal }, originAllowList(allowList))
    let mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    const genericFont = /\.woff2?$/i.test(asset.pathname) && !mime.startsWith('font/')
    const supported =
      /^(?:image\/(?:png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon)|font\/[a-z0-9-]+|application\/(?:font-woff|x-font-ttf|vnd.ms-fontobject)|text\/css)$/
    if (!response.ok || (!supported.test(mime) && !genericFont)) {
      await response.body?.cancel()
      throw new BrowseProxyError(502, 'Unsupported crop resource')
    }
    const bytes = await boundedBody(response, signal, 3_000_000)
    if (genericFont) {
      const signature = bytes.toString('ascii', 0, 4)
      if (signature !== 'wOFF' && signature !== 'wOF2') throw new BrowseProxyError(502, 'Invalid crop font')
      mime = signature === 'wOF2' ? 'font/woff2' : 'font/woff'
    }
    return { mime, bytes }
  } catch (error) {
    if (error instanceof BrowseProxyError) throw error
    if (error instanceof PublicNetworkUrlError) throw new BrowseProxyError(400, error.message)
    throw new BrowseProxyError(signal.aborted ? 504 : 502, 'Crop resource could not be loaded')
  }
}
