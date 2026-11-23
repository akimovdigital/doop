import { MOBILE_QUERY } from '../hooks/use-mobile'
import { create } from 'zustand'
import type { Frame } from '../../shared/types'
import {
  browserDeviceSize,
  normalizeBrowserUrl,
  type BrowserDevice,
  type BrowserFrameData,
} from '../../shared/browserFrame'
import { api } from './api'
import { patchFrames } from './actions/edits'
import { frameCenterPosition, stageViewportSize } from './framePlacement'
import { recordCreate } from './history'
import { t } from './i18n'
import { canEditOpenCanvas, useStore } from './store'

type BrowserSurface = { frameId: string; mode: 'present' | 'side' }
type BrowserUi = {
  surface: BrowserSurface | null
  sideWidth?: number
  focusId: string | null
  reloads: Record<string, number>
}

export const useBrowserUi = create<BrowserUi>(() => ({ surface: null, focusId: null, reloads: {} }))

export function selectedBrowser() {
  const { canvas, selectedId, selectedIds } = useStore.getState()
  return selectedIds.length === 1
    ? canvas?.frames.find((frame) => frame.id === selectedId && frame.browser && !frame.hidden)
    : undefined
}

export function openBrowserSurface(frame: Frame, mode: BrowserSurface['mode']) {
  useStore.getState().select(frame.id)
  useBrowserUi.setState({ surface: { frameId: frame.id, mode } })
}

export function closeBrowserSurface(frameId: string) {
  if (useBrowserUi.getState().surface?.frameId === frameId) useBrowserUi.setState({ surface: null })
}

export function reloadBrowser(frameId: string) {
  useBrowserUi.setState(({ reloads }) => ({ reloads: { ...reloads, [frameId]: (reloads[frameId] ?? 0) + 1 } }))
}

export async function createBrowserFrame(position?: { x: number; y: number }) {
  const state = useStore.getState()
  if (!state.canvas || !canEditOpenCanvas(state)) return
  const size = browserDeviceSize('laptop', { width: 0, height: 0 })
  const pageId = state.activePageId
  try {
    const frame = await api.createFrame(state.canvas.id, {
      name: t('canvas.toolBrowser'),
      pageId: pageId ?? undefined,
      ...size,
      ...(position ?? frameCenterPosition(state.viewport, stageViewportSize(), size)),
      browser: { url: '' },
    })
    const current = useStore.getState()
    if (current.canvas?.id !== frame.canvasId || current.activePageId !== pageId) return
    if (!current.canvas.frames.some((item) => item.id === frame.id)) current.upsertFrame(frame)
    recordCreate(frame)
    current.setTool('select')
    current.select(frame.id)
    if (!window.matchMedia(MOBILE_QUERY).matches) current.setInspectorOpen(true)
    useBrowserUi.setState({ focusId: frame.id })
  } catch (error) {
    useStore.getState().pushNotice(error instanceof Error ? error.message : t('canvas.browserSaveFailed'))
  }
}

export function updateBrowser(
  frame: Frame,
  changes: Partial<BrowserFrameData>,
  size?: { width: number; height: number },
) {
  const state = useStore.getState()
  const current = state.canvas?.frames.find((f) => f.id === frame.id)
  if (!current?.browser || current.locked || !canEditOpenCanvas(state)) return
  patchFrames([{ frame: current, patch: { ...size, browser: { ...current.browser, ...changes } } }])
}

export function changeBrowserDevice(frame: Frame, deviceId: BrowserDevice | undefined) {
  updateBrowser(frame, { deviceId }, deviceId ? browserDeviceSize(deviceId, frame) : undefined)
}

export function navigateBrowser(frame: Frame, input: string) {
  // Use the canvas document URL for path-relative input. Persist the resolved URL.
  const url = normalizeBrowserUrl(input, location.href)
  if (url === null || url.length > 8192) return false
  if (frame.browser?.url !== url) updateBrowser(frame, { url, scrollX: undefined, scrollY: undefined })
  return true
}

/** Pan only as far as needed to expose the address field without changing zoom. */
export function revealBrowserControl(control: HTMLElement) {
  const stage = control.closest('.stage')
  if (!stage) return
  const area = stage.getBoundingClientRect()
  const rect = control.getBoundingClientRect()
  const state = useStore.getState()
  const { x, y, zoom } = state.viewport
  const axis = (lo: number, hi: number, start: number, end: number) =>
    start < lo ? lo - start : end > hi && end - start < hi - lo ? hi - end : 0
  const chrome = getComputedStyle(stage)
  const left = parseFloat(chrome.getPropertyValue('--chrome-left')) || 0
  const right = parseFloat(chrome.getPropertyValue('--chrome-right')) || 0
  const dx = axis(area.left + left + 16, area.right - right - 16, rect.left, rect.right)
  const dy = axis(area.top + 60, area.bottom - 16, rect.top, rect.bottom)
  if (dx || dy) state.setViewport({ x: x + dx, y: y + dy, zoom })
}
