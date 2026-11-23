import { BROWSER_DEVICES, browserDeviceSize, normalizeBrowserUrl, type BrowserDevice } from '../../shared/browserFrame'
import { importedPageSource } from '../../shared/importSource'
import { rotatedBounds } from '../../shared/frameRotation'
import { fullFrameRenderScale } from '../../shared/exportScale'
import type { Frame } from '../../shared/types'
import { api, errorMessage } from './api'
import { patchFrames } from './actions/edits'
import { requestFrame } from './frameBridge'
import { imageElementHtml } from './frameClipboard'
import { rasterizeFrame } from './frameRaster'
import { recordCreate } from './history'
import { t } from './i18n'
import { prototypePath } from './prototype'
import { canEditOpenCanvas, useStore } from './store'

export function framePreviewAddress(frame: Frame) {
  return new URL(prototypePath(frame.canvasId, frame.id), location.origin).href
}

/** The server renderer and importer use a public-network guard. Local
 * references still play in the viewer's browser, where loopback belongs. */
export function frameWebSource(frame: Frame): string | undefined {
  const source = frame.browser?.url ?? importedPageSource(frame.html)
  if (!source || !/^https?:\/\//i.test(source)) return
  return normalizeBrowserUrl(source) || undefined
}

export function canAcquireFrameSource(source: string) {
  const host = new URL(source).hostname.toLowerCase().replace(/\.$/, '')
  if (host.startsWith('[')) return /^\[[23][\da-f]*:/i.test(host)
  if (!host.includes('.') || /\.(localhost|local|internal)$/.test(host)) return false
  if (!/^\d+(?:\.\d+){3}$/.test(host)) return true
  return !/^(?:127\.|0\.|10\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)
}

export function nextHtmlDevice(frame: Frame): BrowserDevice {
  const index = BROWSER_DEVICES.findIndex((device) => {
    const size = browserDeviceSize(device, frame)
    return size.width === frame.width && size.height === frame.height
  })
  return BROWSER_DEVICES[(index + 1) % BROWSER_DEVICES.length]!
}

export function resizeHtmlFrame(frame: Frame, device: BrowserDevice) {
  patchFrames([{ frame, patch: browserDeviceSize(device, frame) }])
}

export async function copyFrameAddress(address: string) {
  try {
    await navigator.clipboard.writeText(address)
    useStore.getState().pushNotice(t('canvas.chromeLinkCopied'))
  } catch {
    useStore.getState().pushNotice(t('canvas.chromeCopyFailed'))
  }
}

function placementFor(frame: Frame) {
  const state = useStore.getState()
  if (state.canvas?.id !== frame.canvasId || !state.activePageId || !canEditOpenCanvas(state)) return
  const current = state.canvas.frames.find((entry) => entry.id === frame.id)
  if (!current || current.locked || current.hidden) return
  const bounds = rotatedBounds(current, current.rotation ?? 0)
  return { x: Math.round(bounds.x + bounds.width + 80), y: Math.round(bounds.y), pageId: state.activePageId }
}

function receiveFrame(frame: Frame, pageId: string) {
  const state = useStore.getState()
  if (state.canvas?.id !== frame.canvasId) return
  if (!state.canvas.frames.some((entry) => entry.id === frame.id)) state.upsertFrame(frame)
  recordCreate(frame)
  if (state.activePageId === pageId) state.select(frame.id)
}

export async function importChromeFrame(frame: Frame, url: string) {
  const placement = placementFor(frame)
  if (!placement) return
  try {
    receiveFrame(await api.importPage(frame.canvasId, url, placement), placement.pageId)
  } catch (error) {
    useStore.getState().pushNotice(errorMessage(error, t('canvas.chromeImportFailed')))
  }
}

async function captureImage(frame: Frame, area: 'visible' | 'full') {
  const metrics = frame.browser ? null : await requestFrame(frame.id, 'doop:capture-metrics', {})
  const x = metrics?.scrollX ?? frame.browser?.scrollX
  const y = metrics?.scrollY ?? frame.browser?.scrollY
  const scrollX = typeof x === 'number' && Number.isFinite(x) ? x : 0
  const scrollY = typeof y === 'number' && Number.isFinite(y) ? y : 0
  const overflow = typeof metrics?.height === 'number' && metrics.height > frame.height
  const scale = fullFrameRenderScale(frame, 1)
  if (!frame.browser && !scrollX && !scrollY && (area === 'visible' || (metrics && !overflow))) {
    try {
      return await rasterizeFrame(frame, { scale, type: 'png' })
    } catch {
      // Match raster exports: Chromium handles documents that cannot be inlined.
    }
  }
  const query = new URLSearchParams({ capture: area, x: String(scrollX), y: String(scrollY) })
  const response = await fetch(`/api/frames/${encodeURIComponent(frame.id)}/screenshot.png?${query}`, {
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(t('canvas.chromeCaptureFailed'))
  return response.blob()
}

export async function captureChromeFrame(frame: Frame, area: 'visible' | 'full') {
  const placement = placementFor(frame)
  if (!placement) return
  try {
    const image = await captureImage(frame, area)
    const bitmap = await createImageBitmap(image)
    const ratio = bitmap.height / bitmap.width
    bitmap.close()
    if (useStore.getState().canvas?.id !== frame.canvasId) return
    const { url } = await api.uploadAsset(frame.canvasId, image)
    const name = t('canvas.chromeCaptureName', { name: frame.name })
    const created = await api.createFrame(frame.canvasId, {
      ...placement,
      name,
      width: frame.width,
      height: Math.max(1, Math.round(frame.width * ratio)),
      html: imageElementHtml(url, name),
    })
    receiveFrame(created, placement.pageId)
  } catch {
    useStore.getState().pushNotice(t('canvas.chromeCaptureFailed'))
  }
}
