import { gunzipSync } from 'node:zlib'
import { once } from 'node:events'
import WebSocket from 'ws'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import type { ServerMessage } from '../shared/types.ts'
import {
  canvasSnapshotCacheKey,
  resetRoomInitGzipCacheForTests,
  roomInitGzipCacheSize,
  stringifyRoomInit,
  wireRoomInitPayload,
} from '../server/roomInitGzip.ts'
import { Client, startServer, type Server } from './harness.ts'

type InitMessage = Extract<ServerMessage, { type: 'init' }>

const huge = '<p>x</p>'.repeat(200_000)

function testInit(selfColor: string, presences: unknown[] = []): InitMessage {
  return {
    type: 'init' as const,
    canvas: {
      id: 'abc',
      name: 'Bench',
      ownerId: 'u1',
      createdAt: 1,
      updatedAt: 1,
      role: 'edit' as const,
      landingPageId: undefined,
      team: undefined,
      frames: [
        {
          id: 'f1',
          canvasId: 'abc',
          name: 'Card',
          html: huge,
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          updatedAt: 1,
        },
      ],
    },
    presences,
    activity: [],
    tasks: [],
    feedback: [],
    comments: [],
    decisions: [],
    proposals: [],
    selfColor,
    serverBuild: 'test',
  } as unknown as InitMessage
}

afterEach(() => resetRoomInitGzipCacheForTests())

it('reuses serialized canvas for the same revision', () => {
  const init = testInit('#112233')
  stringifyRoomInit(init)
  expect(roomInitGzipCacheSize()).toBe(1)
  const again = stringifyRoomInit({ ...init, selfColor: '#445566', presences: [] })
  expect(roomInitGzipCacheSize()).toBe(1)
  expect(again).toContain(huge.slice(0, 20))
  expect(again).toContain('#445566')
})

it('gzips large stitched init payloads', () => {
  const init = testInit('#aabbcc', [
    { clientId: 'x', userId: 'u', name: 'Other', color: '#fff', kind: 'user', activeFrameId: null },
  ])
  const payload = wireRoomInitPayload(init, true)
  expect(Buffer.isBuffer(payload)).toBe(true)
  const text = gunzipSync(payload).toString()
  expect(JSON.parse(text).canvas.frames[0].html).toBe(huge)
  expect(canvasSnapshotCacheKey(init.canvas)).toBe('abc:1')
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
    const init = JSON.parse(buf[0] === 0x1f ? gunzipSync(buf).toString() : buf.toString())
    expect(init).toMatchObject({ type: 'init', canvas: { frames: [{ id: frame.id, html: frame.html }] } })
  } finally {
    ws.close()
  }
})
