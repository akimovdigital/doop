import { gzipSync } from 'node:zlib'
import type { ServerMessage } from '../shared/types.ts'

const MIN_GZIP_BYTES = 1024 * 1024
const CANVAS_JSON_CACHE_MAX = 16

type InitMessage = Extract<ServerMessage, { type: 'init' }>

const canvasJsonCache = new Map<string, string>()

export function resetRoomInitGzipCacheForTests() {
  canvasJsonCache.clear()
}

export function roomInitGzipCacheSize() {
  return canvasJsonCache.size
}

export function canvasSnapshotCacheKey(canvas: InitMessage['canvas']) {
  return `${canvas.id}:${canvas.updatedAt}`
}

function cachedCanvasJson(canvas: InitMessage['canvas']): string {
  const key = canvasSnapshotCacheKey(canvas)
  let json = canvasJsonCache.get(key)
  if (!json) {
    json = JSON.stringify(canvas)
    canvasJsonCache.set(key, json)
    if (canvasJsonCache.size > CANVAS_JSON_CACHE_MAX) {
      const oldest = canvasJsonCache.keys().next().value
      if (oldest) canvasJsonCache.delete(oldest)
    }
  }
  return json
}

/** Stitch init JSON without re-serializing the heavy canvas snapshot. */
export function stringifyRoomInit(init: InitMessage): string {
  const canvasJson = cachedCanvasJson(init.canvas)
  const tail = JSON.stringify({
    presences: init.presences,
    activity: init.activity,
    tasks: init.tasks,
    feedback: init.feedback,
    comments: init.comments,
    decisions: init.decisions,
    proposals: init.proposals,
    selfColor: init.selfColor,
    serverBuild: init.serverBuild,
  })
  return `{"type":"init","canvas":${canvasJson},${tail.slice(1)}`
}

export function wireRoomInitPayload(init: InitMessage, gzipEncoding: boolean): Buffer | string {
  const json = stringifyRoomInit(init)
  if (!gzipEncoding || json.length < MIN_GZIP_BYTES) return json

  const compressed = gzipSync(json, { level: 1 })
  return compressed.length < json.length ? compressed : json
}