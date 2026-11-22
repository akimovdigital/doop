import { useSyncExternalStore } from 'react'

/** Like the theme, dashboard preferences belong to this browser. */
export const PROMPT_BOX_STORAGE_KEY = 'doop.home.prompt-box-hidden'

const PINNED_CANVASES_KEY = 'doop.home.pinned-canvases'
const REMOVED_RECENTS_KEY = 'doop.home.removed-recents'
const canvasIds = new Map<string, ReadonlySet<string>>()

let hidden: boolean | undefined
const listeners = new Set<() => void>()

function getHidden(): boolean {
  if (hidden === undefined) {
    try {
      hidden = localStorage.getItem(PROMPT_BOX_STORAGE_KEY) === 'true'
    } catch {
      hidden = false
    }
  }
  return hidden
}

function notify() {
  listeners.forEach((listener) => listener())
}

function onStorage(event: StorageEvent) {
  if (
    event.key !== null &&
    event.key !== PROMPT_BOX_STORAGE_KEY &&
    event.key !== PINNED_CANVASES_KEY &&
    event.key !== REMOVED_RECENTS_KEY
  )
    return
  if (event.key === null || event.key === PROMPT_BOX_STORAGE_KEY) hidden = undefined
  if (event.key === null) canvasIds.clear()
  else canvasIds.delete(event.key)
  notify()
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    window.addEventListener('storage', onStorage)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('storage', onStorage)
  }
}

export function setPromptBoxHidden(value: boolean) {
  hidden = value
  try {
    localStorage.setItem(PROMPT_BOX_STORAGE_KEY, String(value))
  } catch {
    // The preference still works for this session if storage is unavailable.
  }
  notify()
}

export function usePromptBoxHidden(): boolean {
  return useSyncExternalStore(subscribe, getHidden)
}

function getCanvasIds(key: string): ReadonlySet<string> {
  const cached = canvasIds.get(key)
  if (cached) return cached
  let saved: unknown
  try {
    saved = JSON.parse(localStorage.getItem(key) ?? '[]')
  } catch {
    // An unavailable or invalid preference starts empty.
  }
  const ids = new Set<string>(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [])
  canvasIds.set(key, ids)
  return ids
}

function setCanvasId(key: string, id: string, included: boolean) {
  const ids = new Set(getCanvasIds(key))
  if (included) ids.add(id)
  else ids.delete(id)
  canvasIds.set(key, ids)
  try {
    localStorage.setItem(key, JSON.stringify([...ids]))
  } catch {
    // Keep the preference for this session.
  }
  notify()
}

const getPinnedCanvases = () => getCanvasIds(PINNED_CANVASES_KEY)
const getRemovedRecents = () => getCanvasIds(REMOVED_RECENTS_KEY)

export function usePinnedCanvases(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getPinnedCanvases)
}

export function togglePinnedCanvas(id: string) {
  setCanvasId(PINNED_CANVASES_KEY, id, !getPinnedCanvases().has(id))
}

export function useRemovedRecents(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getRemovedRecents)
}

export function removeFromRecent(id: string) {
  setCanvasId(REMOVED_RECENTS_KEY, id, true)
}
