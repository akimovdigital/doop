import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import type { ServerMessage } from '../shared/types.ts'

const gzipAsync = promisify(gzip)

const MIN_GZIP_BYTES = 1024 * 1024
const CACHE_MAX = 32

type InitMessage = Extract<ServerMessage, { type: 'init' }>

const cache = new Map<string, Buffer | string>()

export function resetRoomInitGzipCacheForTests() {
  cache.clear()
}

export function roomInitGzipCacheSize() {
  return cache.size
}

/** Fields that identify the room snapshot aside from the heavy canvas bodies. */
export function roomInitSnapshotKey(init: InitMessage): string {
  const { id, updatedAt, role, landingPageId, team } = init.canvas
  return JSON.stringify({
    id,
    updatedAt,
    role,
    landingPageId,
    team,
    serverBuild: init.serverBuild,
    selfColor: init.selfColor,
    presences: init.presences,
    activity: init.activity,
    tasks: init.tasks,
    feedback: init.feedback,
    comments: init.comments,
    decisions: init.decisions,
    proposals: init.proposals,
  })
}

export async function wireRoomInitPayload(
  init: InitMessage,
  gzipEncoding: boolean,
): Promise<Buffer | string> {
  const json = JSON.stringify(init)
  if (!gzipEncoding || json.length < MIN_GZIP_BYTES) return json

  const key = roomInitSnapshotKey(init)
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  const compressed = await gzipAsync(Buffer.from(json), { level: 1 })
  const payload: Buffer | string =
    compressed.length < json.length ? compressed : Buffer.from(json)
  cache.set(key, payload)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  return payload
}