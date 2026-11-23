import { z } from 'zod'

export const BROWSER_DEVICES = ['laptop', 'tablet', 'phone'] as const
export const BROWSER_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5] as const
export type BrowserDevice = (typeof BROWSER_DEVICES)[number]

export function normalizeBrowserUrl(input: string, base?: string): string | null {
  const value = input.trim()
  if (!value) return ''
  if (/[\s\\]/.test(value) || value.startsWith('//')) return null
  const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?=[:/?#]|$)/i.test(value)
  const bareHost = /^(?:[\w-]+\.)+[\w-]+(?::\d+)?(?=[/?#]|$)/.test(value)
  try {
    const url = new URL(local ? `http://${value}` : bareHost ? `https://${value}` : value, base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

export function browserAddress(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^(\S+?)\/$/, '$1')
}

export function isAbsoluteBrowserUrl(url: unknown): url is string {
  return typeof url === 'string' && url.length <= 8192 && hasAbsoluteBrowserUrl(url)
}

function hasAbsoluteBrowserUrl(url: string): boolean {
  return url === '' || (/^https?:\/\//i.test(url) && !!normalizeBrowserUrl(url))
}

export const browserFrameSchema = /* @__PURE__ */ (() =>
  z.object({
    url: z.string().max(8192).refine(hasAbsoluteBrowserUrl, 'Enter an HTTP or HTTPS URL'),
    deviceId: z.enum(BROWSER_DEVICES).optional(),
    zoom: z.number().min(0.5).max(1.5).optional(),
    scrollX: z.number().finite().optional(),
    scrollY: z.number().finite().optional(),
    cornerRadius: z.number().min(0).max(1000).optional(),
    opacity: z.number().min(0).max(1).optional(),
  }))()

export type BrowserFrameData = z.infer<typeof browserFrameSchema>

const sizes = {
  laptop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  phone: { width: 390, height: 844 },
}

export function browserDeviceSize(device: BrowserDevice | undefined, responsive: { width: number; height: number }) {
  return device ? sizes[device] : responsive
}

export function browserViewport(width: number, height: number, zoom = 1) {
  return { width: width / zoom, height: height / zoom }
}

/** Static exports describe the live reference without contacting its host. */
export function browserReferenceHtml(browser: BrowserFrameData): string {
  const { url } = browser
  const escape = (value: string) =>
    value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const link =
    url && isAbsoluteBrowserUrl(url)
      ? `<a href="${escape(url)}" rel="noreferrer">${escape(browserAddress(url))}</a>`
      : ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>Browser</title></head><body><p>Browser</p>${link}</body></html>`
}
