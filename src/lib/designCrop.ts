import type { Frame } from '../../shared/types'
import { askFrameWindow } from './frameBridge'
import { clipToFrame, rasterizeHtml, type ClipRect } from './frameRaster'
import type { DesignNote, NoteRect } from './designNotes'
import { desktopPlatform } from './shell'
import { renderMarkupSvg } from './designMarkup'

interface Viewport {
  width: number
  height: number
  scrollX: number
  scrollY: number
}

const PADDING = 8
const MAX_CROP_SIDE = 1200
export const MAX_PROMPT_ATTACHMENTS = 4

/** The annotation overlay already unscales the displayed iframe. Its boxes are
 * viewport CSS pixels; only the output density uses the device pixel ratio. */
export function planDesignCrop(rects: NoteRect[], viewport: Viewport, dpr: number) {
  const visible = rects.filter((rect) => clipToFrame(rect, viewport))
  if (!visible.length) return null
  const left = Math.min(...visible.map((r) => r.x)) - PADDING
  const top = Math.min(...visible.map((r) => r.y)) - PADDING
  const right = Math.max(...visible.map((r) => r.x + r.width)) + PADDING
  const bottom = Math.max(...visible.map((r) => r.y + r.height)) + PADDING
  const clip = clipToFrame({ x: left, y: top, width: right - left, height: bottom - top }, viewport)
  if (!clip) return null
  const scale = Math.min(Math.max(1, dpr), 2, MAX_CROP_SIDE / Math.max(clip.width, clip.height))
  return { clip, viewport, scale }
}

async function composeMarkup(crop: Blob, note: DesignNote, clip: ClipRect, viewport: Viewport): Promise<Blob> {
  if (!note.region || !note.markup?.length) return crop
  const svg = renderMarkupSvg(note.markup, {
    ...clip,
    x: clip.x + viewport.scrollX,
    y: clip.y + viewport.scrollY,
  })
  if (!svg) return crop
  const png = await createImageBitmap(crop)
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const overlay = new Image()
    overlay.src = url
    await overlay.decode()
    const canvas = document.createElement('canvas')
    canvas.width = png.width
    canvas.height = png.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Cannot composite design markup without a 2D canvas')
    context.drawImage(png, 0, 0)
    context.drawImage(overlay, 0, 0, png.width, png.height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Cannot encode marked-up crop'))), 'image/png')
    })
  } finally {
    png.close()
    URL.revokeObjectURL(url)
  }
}

interface CropMetrics extends Viewport {
  rects: NoteRect[]
  dpr: number
}

async function renderCrop(win: Window, frame: Frame, note: DesignNote, sourceReady: () => void) {
  const reply = await askFrameWindow(win, 'doop:annotation-crop', {
    selectors: note.elements.map((element) =>
      element.doopId ? `[data-doop-id="${CSS.escape(element.doopId)}"]` : element.selector,
    ),
  })
  if (!reply?.metrics) return
  const { rects, dpr, ...viewport } = reply.metrics as CropMetrics
  const region =
    note.regionInPage && note.region
      ? { ...note.region, x: note.region.x - viewport.scrollX, y: note.region.y - viewport.scrollY }
      : note.region
  const plan = planDesignCrop(region ? [region] : rects, viewport, dpr)
  if (!plan) return
  const { clip, scale } = plan
  // ForeignObject canvas export is unreliable in WKWebView. The screenshot
  // endpoint also replays document scroll for output containing fixed elements.
  if (!frame.browser && !viewport.scrollX && !viewport.scrollY && desktopPlatform() !== 'macos') {
    try {
      const first = note.elements[0]
      const textEdit = note.textEdit &&
        first && {
          ...note.textEdit,
          selector: first.doopId ? `[data-doop-id="${CSS.escape(first.doopId)}"]` : first.selector,
        }
      const snapshot = await askFrameWindow(win, 'doop:snapshot', { textEdit }, 15_000)
      sourceReady()
      if (typeof snapshot?.html === 'string') {
        const crop = await rasterizeHtml(snapshot.html, viewport, { type: 'png', clip, scale })
        return await composeMarkup(crop, note, clip, viewport)
      }
    } catch {
      // Non-inlineable CSS, images or nested documents use the server renderer.
    }
  }
  sourceReady()
  const cropParams = (r: ClipRect) => [r.x, r.y, r.width, r.height].join(',')
  const query = new URLSearchParams({
    capture: 'visible',
    x: String(viewport.scrollX),
    y: String(viewport.scrollY),
    crop: cropParams(clip),
    scale: String(scale),
  })
  const response = await fetch(`/api/frames/${encodeURIComponent(frame.id)}/screenshot.png?${query}`, {
    signal: AbortSignal.timeout(50_000),
  })
  if (response.ok) return composeMarkup(await response.blob(), note, clip, viewport)
}

const DB_NAME = 'doop.designCrops'
const STORE_NAME = 'png'
let database: Promise<IDBDatabase | undefined> | undefined
const inProgress = new Map<string, Promise<Blob | undefined>>()

function openDatabase() {
  database ??= new Promise<IDBDatabase | undefined>((resolve) => {
    if (!globalThis.indexedDB) return resolve(undefined)
    try {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(undefined)
      request.onblocked = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
  return database
}

async function cropTransaction(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest) {
  const db = await openDatabase()
  if (!db) return
  return new Promise<unknown>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, mode)
      const request = run(tx.objectStore(STORE_NAME))
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

/** Keep queued PNGs in IndexedDB rather than enlarging the annotation JSON
 * in localStorage. The promise also covers immediate sends and previews. */
export function captureDesignCrop(win: Window, frame: Frame, note: DesignNote) {
  return new Promise<void>((sourceReady) => {
    const pending = renderCrop(win, frame, note, sourceReady)
      .finally(sourceReady)
      .catch(() => undefined)
      .then(async (blob) => {
        if (blob && inProgress.get(note.id) === pending)
          await cropTransaction('readwrite', (store) => store.put(blob, note.id))
        return blob
      })
    inProgress.set(note.id, pending)
  })
}

export async function readDesignCrop(id: string): Promise<Blob | undefined> {
  const pending = inProgress.get(id)
  if (pending) return pending
  const saved = await cropTransaction('readonly', (store) => store.get(id))
  return saved instanceof Blob ? saved : undefined
}

export async function discardDesignCrop(id: string) {
  const pending = inProgress.get(id)
  await pending
  if (inProgress.get(id) !== pending) return
  inProgress.delete(id)
  await cropTransaction('readwrite', (store) => store.delete(id))
}
