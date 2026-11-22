import { gunzipSync } from 'node:zlib'
import { once } from 'node:events'
import WebSocket from 'ws'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import type { ServerMessage } from '../shared/types.ts'
import {
  resetRoomInitGzipCacheForTests,
  roomInitGzipCacheSize,
  roomInitSnapshotKey,
  wireRoomInitPayload,
} from '../server/roomInitGzip.ts'
import { Client, startServer, type Server } from './harness.ts'

afterEach(() => resetRoomInitGzipCacheForTests())

it('reuses a gzipped payload for the same room snapshot key', async () => {
  const huge = '<p>x</p>'.repeat(200_000)
  const init = {
    type: 'init',
    canvas: {
      id: 'abc',
      updatedAt: 1,
      role: 'edit',
      landingPageId: null,
      team: null,
      frames: [{ id: 'f1', name: 'Card', html: huge }],
    },
    presences: [],
    activity: [],
    tasks: [],
    feedback: [],
    comments: [],
    decisions: [],
    proposals: [],
    selfColor: '#112233',
    serverBuild: 'test',
  } as ServerMessage & { type: 'init' }

  const first = await wireRoomInitPayload(init, true)
  const second = await wireRoomInitPayload({ ...init, selfColor: '#112233' }, true)
  expect(roomInitGzipCacheSize()).toBe(1)
  expect(second).toBe(first)
  const text = gunzipSync(Buffer.isBuffer(first) ? first : Buffer.from(first as string)).toString()
  expect(JSON.parse(text).canvas.frames[0].html).toBe(huge)
})

it('misses when presences change', async () => {
  const base = {
    type: 'init',
    canvas: { id: 'c', updatedAt: 2, role: 'edit', landingPageId: null, team: null, frames: [] },
    presences: [] as unknown[],
    activity: [],
    tasks: [],
    feedback: [],
    comments: [],
    decisions: [],
    proposals: [],
    selfColor: '#aabbcc',
    serverBuild: 'test',
  } as ServerMessage & { type: 'init' }
  const huge = '<section>' + 'a'.repeat(1_100_000) + '</section>'
  base.canvas.frames = [{ id: 'f', name: 'N', html: huge }]

  await wireRoomInitPayload(base, true)
  base.presences = [{ clientId: 'x', userId: 'u', name: 'Other', color: '#fff', kind: 'user', activeFrameId: null }]
  await wireRoomInitPayload(base, true)
  expect(roomInitGzipCacheSize()).toBe(2)
  expect(roomInitSnapshotKey(base)).toContain('Other')
})

let server: Server
let owner: Client
let canvasId: string
let frame: { id: string; html: string }

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('room-init-gzip@test.dev', 'Room Init Owner')
  const canvas = await (await owner.post('/api/canvases', { name: 'Init gzip' })).json()
  canvasId = canvas.id
  const html = '<main>' + '<p>Paragraph on the canvas.</p>'.repeat(1200) + '</main>'
  frame = await (await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Article', html })).json()
}, 60_000)

afterAll(() => server?.stop())

it('delivers a gzipped init over the room socket', async () => {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
  try {
    await once(ws, 'open')
    const message = once(ws, 'message')
    ws.send(
      JSON.stringify({
        type: 'join',
        canvasId,
        clientId: 'reader',
        kind: 'user',
        name: 'Reader',
        initEncoding: 'gzip',
      }),
    )
    const [raw] = await message
    const buf = raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer)
    const init = JSON.parse(
      buf[0] === 0x1f ? gunzipSync(buf).toString() : buf.toString(),
    )
    expect(init).toMatchObject({ type: 'init', canvas: { frames: [{ id: frame.id, html: frame.html }] } })
  } finally {
    ws.close()
  }
})