import { promisify } from 'node:util'
import { constants, crc32, deflateRaw, deflateRawSync, gzip, inflateRawSync } from 'node:zlib'
import type { ServerMessage } from '../shared/types.ts'

const MIN_GZIP_BYTES = 1024 * 1024
const MAX_CACHE_BYTES = 8 * 1024 * 1024
const MAX_CANVASES = 4
const deflateBody = promisify(deflateRaw)
const gzipText = promisify(gzip)

type InitMessage = Extract<ServerMessage, { type: 'init' }>
type Body = { key: string; deflated: Buffer; crc: number; bytes: number }

const bodies = new Map<string, Body>()
const pendingBodies = new Map<string, { jobs: Map<string, Promise<Body>>; latest: string }>()
let cachedBytes = 0

function retainedBytes(body: Body) {
  return body.deflated.buffer.byteLength + 2 * body.key.length
}

export function dropRoomInitBody(canvasId: string) {
  pendingBodies.delete(canvasId)
  forgetBody(canvasId)
}

function forgetBody(canvasId: string) {
  const old = bodies.get(canvasId)
  if (old) {
    cachedBytes -= retainedBytes(old)
    bodies.delete(canvasId)
  }
}

function rememberBody(canvasId: string, body: Body) {
  const bytes = retainedBytes(body)
  if (bytes > MAX_CACHE_BYTES) return
  while (cachedBytes + bytes > MAX_CACHE_BYTES || bodies.size >= MAX_CANVASES)
    forgetBody(bodies.keys().next().value!)
  bodies.set(canvasId, body)
  cachedBytes += bytes
}

const gzipHeader = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255])

export async function wireRoomInitPayload(
  init: InitMessage,
  gzipEncoding: boolean,
  revision: number,
): Promise<Buffer | string> {
  const { canvas, type, ...header } = init
  // This is the rest of the same JSON object, including its closing brace.
  const suffix = ',' + JSON.stringify(header).slice(1)
  const { id, role, landingPageId, team } = canvas
  const key = JSON.stringify([revision, role, landingPageId, team, header.serverBuild])
  let body = bodies.get(id)
  let prefix: string | undefined
  if (body?.key === key) {
    bodies.delete(id)
    bodies.set(id, body)
  } else {
    forgetBody(id)
    const pending = pendingBodies.get(id) ?? { jobs: new Map<string, Promise<Body>>(), latest: key }
    pending.latest = key
    const existing = pending.jobs.get(key)
    if (existing) {
      body = await existing
    } else {
      prefix = '{"type":' + JSON.stringify(type) + ',"canvas":' + JSON.stringify(canvas)
      const bytes = Buffer.byteLength(prefix)
      if (bytes < MIN_GZIP_BYTES) {
        const text = prefix + suffix
        const totalBytes = bytes + Buffer.byteLength(suffix)
        if (!gzipEncoding || totalBytes < MIN_GZIP_BYTES) return text
        const zipped = await gzipText(text, { level: 1 })
        return zipped.length < totalBytes ? zipped : text
      }
      const source = Buffer.from(prefix)
      // Full flush ends on a byte boundary and resets the deflate dictionary.
      // A fresh deflater can finish this stream with the per-join JSON suffix.
      const job = deflateBody(source, { level: 1, finishFlush: constants.Z_FULL_FLUSH }).then(
        (deflated) => ({ key, deflated, crc: crc32(source), bytes }),
      )
      pending.jobs.set(key, job)
      pendingBodies.set(id, pending)
      try {
        body = await job
        if (pendingBodies.get(id) === pending && pending.latest === key) rememberBody(id, body)
      } finally {
        pending.jobs.delete(key)
        if (pending.jobs.size === 0 && pendingBodies.get(id) === pending) pendingBodies.delete(id)
      }
    }
  }

  // Keep only the compressed body in memory. Text clients can inflate it locally.
  const plain = () =>
    (prefix ?? inflateRawSync(body.deflated, { finishFlush: constants.Z_SYNC_FLUSH }).toString()) + suffix
  if (!gzipEncoding) return plain()

  const tail = Buffer.from(suffix)
  const deflatedTail = deflateRawSync(tail, { level: 1 })
  const trailer = Buffer.alloc(8)
  // Continue the checksum over the suffix, so no canvas bytes are read on a hit.
  trailer.writeUInt32LE(crc32(tail, body.crc), 0)
  trailer.writeUInt32LE((body.bytes + tail.length) >>> 0, 4)
  const size = gzipHeader.length + body.deflated.length + deflatedTail.length + trailer.length
  return size < body.bytes + tail.length
    ? Buffer.concat([gzipHeader, body.deflated, deflatedTail, trailer], size)
    : plain()
}
