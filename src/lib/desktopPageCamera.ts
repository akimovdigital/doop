import type { Viewport } from './store'

const key = 'doopPageCamera'
type PageCamera = { canvasId: string; pageId: string; viewport: Viewport }
type CameraHistory = Pick<History, 'state' | 'replaceState'>

function update(history: CameraHistory, camera: PageCamera | undefined) {
  try {
    history.replaceState({ ...(history.state as object | null), [key]: camera }, '')
  } catch {
    // A history write failing must never interrupt a gesture.
  }
}

export function saveDesktopPageCamera(history: CameraHistory, camera: PageCamera) {
  update(history, camera)
}

export function takeDesktopPageCamera(history: CameraHistory, canvasId: string, pageId: string): Viewport | undefined {
  const saved = (history.state as Record<string, PageCamera> | null)?.[key]
  if (!saved || saved.canvasId !== canvasId || saved.pageId !== pageId || !saved.viewport) return
  // If the same camera crashes the new renderer, give the next reload its
  // normal fitted view. Only a later camera change saves a new checkpoint.
  update(history, undefined)
  const { x, y, zoom } = saved.viewport
  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(zoom) && zoom >= 0.01 && zoom <= 16) {
    return { x, y, zoom }
  }
}
