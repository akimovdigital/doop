import { randomBytes } from 'node:crypto'
import { deflateRaw, gunzipSync } from 'node:zlib'
import { once } from 'node:events'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '../shared/types.ts'
import { dropRoomInitBody, wireRoomInitPayload } from '../server/roomInitGzip.ts'
import { openTransaction } from '../server/journal.ts'
import { store } from '../server/store.ts'
import { Client, startServer, type Server } from './harness.ts'

type Init = Extract<ServerMessage, { type: 'init' }>

vi.mock('node:zlib', async (importOriginal) => {
  const zlib = await importOriginal<typeof import('node:zlib')>()
  return { ...zlib, deflateRaw: vi.fn(zlib.deflateRaw) }
})

function largeInit(id: string, html = '<p>Привет 👋</p>'.repeat(140_000)) {
  let reads = 0
  const init: Init = {
    type: 'init',
    canvas: {
      id,
      name: 'Test',
      createdAt: 1,
      updatedAt: 1,
      role: 'edit',
      frames: [
        {
          id: 'f',
          canvasId: id,
          name: 'Frame',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          get html() {
            reads++
            return html
          },
          createdAt: 1,
          updatedAt: 1,
          updatedBy: 'test',
        },
      ],
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
  }
  return { init, html, reads: () => reads }
}

it('serializes large frame HTML once across changing room headers', async () => {
  const { init, html, reads } = largeInit('test-cache-hit')
  const first = await wireRoomInitPayload(init, true, 1)
  const second = await wireRoomInitPayload(
    {
      ...init,
      selfColor: '#445566',
      presences: [{ clientId: 'peer', name: 'Peer', color: '#fff', kind: 'user', activeFrameId: null }],
    },
    true,
    1,
  )
  const plain = await wireRoomInitPayload(init, false, 1)
  expect(reads()).toBe(1)
  const decoded = async (payload: string | Buffer): Promise<Init> => {
    expect(Buffer.isBuffer(payload)).toBe(true)
    const stream = new Blob([Uint8Array.from(Buffer.from(payload))]).stream()
    return JSON.parse(await new Response(stream.pipeThrough(new DecompressionStream('gzip'))).text())
  }
  expect(await decoded(first)).toMatchObject({ selfColor: '#112233', presences: [], canvas: { frames: [{ html }] } })
  expect(await decoded(second)).toMatchObject({
    selfColor: '#445566',
    presences: [{ clientId: 'peer' }],
    canvas: { frames: [{ html }] },
  })
  expect(JSON.parse(String(plain))).toMatchObject({ canvas: { frames: [{ html }] } })
})

it('shares one asynchronous body compression across concurrent misses', async () => {
  const { init, reads } = largeInit('test-in-flight')
  vi.mocked(deflateRaw).mockClear()

  const first = wireRoomInitPayload(init, true, 1)
  const second = wireRoomInitPayload({ ...init, selfColor: '#abcdef' }, true, 1)
  const payloads = await Promise.all([first, second])

  expect(deflateRaw).toHaveBeenCalledTimes(1)
  expect(reads()).toBe(1)
  expect(
    payloads.map((payload) => (JSON.parse(gunzipSync(Buffer.from(payload)).toString()) as Init).selfColor),
  ).toEqual(['#112233', '#abcdef'])
})

it('rebuilds the body on revision, role, landing page, team, build and explicit eviction', async () => {
  const { init, reads } = largeInit('test-cache-key')
  const decode = async (message: Init, revision = 1) =>
    JSON.parse(gunzipSync(Buffer.from(await wireRoomInitPayload(message, true, revision))).toString()) as Init

  await decode(init)
  await decode(init, 2)
  expect(reads()).toBe(2)
  init.canvas.role = 'view'
  expect((await decode(init, 2)).canvas.role).toBe('view')
  init.canvas.landingPageId = 'library'
  expect((await decode(init, 2)).canvas.landingPageId).toBe('library')
  init.canvas.team = []
  expect((await decode(init, 2)).canvas.team).toEqual([])
  init.serverBuild = 'new'
  expect((await decode(init, 2)).serverBuild).toBe('new')
  expect(reads()).toBe(6)
  dropRoomInitBody(init.canvas.id)
  await decode(init, 2)
  expect(reads()).toBe(7)
})

it('evicts the least recently used body after four canvases', async () => {
  const entries = Array.from({ length: 5 }, (_, i) => largeInit(`cache-limit-${i}`))
  for (const { init } of entries.slice(0, 4)) await wireRoomInitPayload(init, true, 1)
  const [kept, evicted, , , extra] = entries
  await wireRoomInitPayload(kept!.init, true, 1)
  await wireRoomInitPayload(extra!.init, true, 1)
  await wireRoomInitPayload(kept!.init, true, 1)
  await wireRoomInitPayload(evicted!.init, true, 1)
  expect(kept!.reads()).toBe(1)
  expect(evicted!.reads()).toBe(2)
})

it('evicts large bodies at the byte limit before reaching four canvases', async () => {
  const large = randomBytes(5 * 1024 * 1024).toString('base64')
  const first = largeInit('budget-first', large)
  const second = largeInit('budget-second', large)
  await wireRoomInitPayload(first.init, true, 1)
  await wireRoomInitPayload(first.init, true, 1)
  expect(first.reads()).toBe(1)
  await wireRoomInitPayload(second.init, true, 1)
  await wireRoomInitPayload(first.init, true, 1)
  expect(first.reads()).toBe(2)
  dropRoomInitBody(first.init.canvas.id)
  dropRoomInitBody(second.init.canvas.id)
}, 15_000)

it('invalidates even when an open write was cached and then rolled back', async () => {
  const { init } = largeInit('rollback-cache')
  const canvas = init.canvas
  canvas.pages = [{ id: 'home', name: 'Home' }]
  canvas.frames[0]!.pageId = 'home'
  store.init([canvas])
  const nameOnWire = async () => {
    const payload = await wireRoomInitPayload(init, true, store.canvasRevision(canvas))
    return (JSON.parse(gunzipSync(Buffer.from(payload)).toString()) as Init).canvas.name
  }
  const write = openTransaction()
  try {
    expect(await nameOnWire()).toBe('Test')
    write.run(() => store.renameCanvas(canvas.id, 'During write'))
    expect(await nameOnWire()).toBe('During write')
    write.rollback()
    expect(await nameOnWire()).toBe('Test')
  } finally {
    write.rollback()
    dropRoomInitBody(canvas.id)
  }
})

describe('member and guest WebSocket joins', () => {
  let server: Server
  let owner: Client
  let visitor: Client

  beforeAll(async () => {
    server = await startServer()
    owner = await new Client(server).signUp('room-init-gzip@test.dev', 'Room Init Owner')
    visitor = await new Client(server).signUp('room-init-visitor@test.dev', 'Room Init Visitor')
  }, 60_000)
  afterAll(() => server?.stop())

  async function join(canvasId: string, client: Client | undefined, gzip: boolean, binary: boolean): Promise<Init> {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, {
      headers: client && { Cookie: client.header() },
    })
    try {
      await once(ws, 'open')
      const message = once(ws, 'message')
      ws.send(
        JSON.stringify({
          type: 'join',
          canvasId,
          clientId: client === owner ? 'owner' : 'visitor',
          ...(gzip ? { initEncoding: 'gzip' } : {}),
        }),
      )
      const [raw, isBinary] = await message
      expect(isBinary).toBe(binary)
      return JSON.parse((isBinary ? gunzipSync(raw) : Buffer.from(raw)).toString())
    } finally {
      ws.close()
    }
  }

  it('delivers fresh frame HTML, pages and access roles on repeated real joins', async () => {
    const created = await owner.post('/api/canvases', { name: 'Init gzip' })
    expect(created.ok).toBe(true)
    const canvas = (await created.json()) as Init['canvas']
    const route = `/api/canvases/${canvas.id}`
    const largeText = 'abc Привет 👋 '.repeat(100_000)
    const createdFrame = await owner.post(`${route}/frames`, { name: 'Article', html: `<main>${largeText}</main>` })
    expect(createdFrame.ok).toBe(true)
    const frame = (await createdFrame.json()) as Init['canvas']['frames'][number]
    expect((await owner.patch(route, { linkAccess: 'view' })).ok).toBe(true)
    const initial = await join(canvas.id, owner, true, true)
    expect(initial).toMatchObject({ type: 'init', canvas: { role: 'edit', frames: [frame] } })
    expect((await join(canvas.id, owner, false, false)).canvas).toEqual(initial.canvas)

    const edit = await owner.patch(`/api/frames/${frame.id}`, { html: `<article>${largeText}</article>` })
    expect(edit.ok).toBe(true)
    const editedFrame = await edit.json()
    expect((await join(canvas.id, owner, true, true)).canvas.frames[0]).toEqual(editedFrame)

    const pages = [...(initial.canvas.pages ?? []), { id: 'new-page', name: 'New page' }]
    expect((await owner.put(`${route}/pages`, { pages, expectedPages: initial.canvas.pages })).ok).toBe(true)
    expect((await join(canvas.id, owner, true, true)).canvas.pages).toEqual(pages)

    expect((await join(canvas.id, visitor, true, true)).canvas.role).toBe('view')
    expect((await owner.patch(route, { linkAccess: 'comment' })).ok).toBe(true)
    expect((await join(canvas.id, visitor, true, true)).canvas.role).toBe('comment')
    const guest = await join(canvas.id, undefined, true, false)
    expect(guest.canvas).toMatchObject({ pages, frames: [editedFrame] })
    expect(guest.activity).toEqual([])
  }, 30_000)
})
