import type { Frame } from '../../shared/types'
import { requestFrameCrop } from './frameBridge'
import type { CropViewport } from './frameCropRuntime'
import type { ClipRect } from './frameRaster'
import type { DesignNote } from './designNotes'
import { renderMarkupSvg } from './designMarkup'

export { planDesignCrop } from './frameCropRuntime'
export const MAX_PROMPT_ATTACHMENTS = 4

async function composeMarkup(crop: Blob, note: DesignNote, clip: ClipRect, viewport: CropViewport): Promise<Blob> {
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

async function renderCrop(win: Window, frame: Frame, note: DesignNote, sourceReady: () => void) {
  const selectors = note.elements.map((element) =>
    element.doopId ? `[data-doop-id="${CSS.escape(element.doopId)}"]` : element.selector,
  )
  const request = {
    selectors,
    region: note.region,
    regionInPage: note.regionInPage,
    textEdit: note.textEdit && selectors[0] ? { ...note.textEdit, selector: selectors[0] } : undefined,
  }
  const source = frame.browser ? { canvasId: frame.canvasId, url: note.pageUrl } : undefined
  const reply =
    (await requestFrameCrop(win, request, source)) ?? (await requestFrameCrop(win, { ...request, geometryOnly: true }))
  sourceReady()
  if (!reply?.plan) return
  const { clip, scale, viewport } = reply.plan
  if (reply.png) return composeMarkup(reply.png, note, clip, viewport)

  // Resource, decoding and taint errors keep the existing renderer available.
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
