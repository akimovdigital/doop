import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import sharp from 'sharp'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

const photo = await readFile(new URL('./fixtures/images/photo.jpg', import.meta.url))
let server: Server
let client: Client
let canvasId: string

beforeAll(async () => {
  const seeded = await startServer()
  server = seeded
  seeded.stop({ keepData: true })
  await seeded.stopped
  const dir = path.join(seeded.dataDir, 'data')
  const db = new PGlite(path.join(dir, 'pg'))
  try {
    await mkdir(path.join(dir, 'assets'), { recursive: true })
    await writeFile(path.join(dir, 'assets', 'legacy-photo.jpg'), photo)
    await db.query(
      "INSERT INTO assets (id, mime, ext, size, uploaded_by, created_at) VALUES ('legacy-photo', 'image/jpeg', 'jpg', $1, 'legacy', 0)",
      [photo.length],
    )
  } finally {
    await db.close()
  }
  server = await startServer({}, seeded.dataDir)
  client = await new Client(server).signUp('new-asset@test.dev', 'New asset')
  canvasId = (await (await client.post('/api/canvases', { name: 'Images' })).json()).id
}, 60_000)

afterAll(() => server?.stop())

it('serves a legacy asset byte-for-byte and stores a fresh upload with the new type and key', async () => {
  const legacy = await client.get('/a/legacy-photo.jpg')
  expect(legacy.status).toBe(200)
  expect(legacy.headers.get('content-type')).toBe('image/jpeg')
  expect(Buffer.from(await legacy.arrayBuffer())).toEqual(photo)
  expect((await client.get('/a/legacy-photo.webp')).status).toBe(404)

  const upload = await client.req(`/api/canvases/${canvasId}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(photo),
  })
  expect(upload.status).toBe(200)
  const { url, mime, size } = await upload.json()
  expect(url).toMatch(/\.webp$/)
  expect(mime).toBe('image/webp')
  expect(size).toBeLessThan(photo.length)
  const served = await fetch(url)
  expect(served.status).toBe(200)
  expect(served.headers.get('content-type')).toBe(mime)
  const bytes = Buffer.from(await served.arrayBuffer())
  expect(bytes.length).toBe(size)
  expect(await sharp(bytes).metadata()).toMatchObject({ format: 'webp' })
})

it('optimizes embedded images only on a new import, preserving ordinary frame writes and old links', async () => {
  const source = `data:image/jpeg;base64,${photo.toString('base64')}`
  const html = `<!doctype html><html><body><img src="${source}"><img src="/a/legacy-photo.jpg"></body></html>`
  const create = (optimizeImages: boolean) =>
    client.post(`/api/canvases/${canvasId}/frames`, { name: 'Import', html, optimizeImages })
  expect((await (await create(false)).json()).html).toContain(source)
  const imported = await create(true)
  expect(imported.status).toBe(200)
  const result = (await imported.json()).html
  expect(result).toContain('/a/legacy-photo.jpg')
  expect(result).not.toContain(source)
  expect(result).toMatch(/src="data:image\/webp;base64,/)
})

it('passes a real MCP upload ticket through the same encoder and consumes it on success', async () => {
  const key = await client.post('/api/agent-keys', { name: 'Image test' })
  expect(key.status).toBe(200)
  const { secret } = await key.json()
  const agent = new McpClient({ name: 'image-ingest-test', version: '1.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
  try {
    const ticket = await agent.callTool({
      name: 'upload_asset',
      arguments: { canvas_id: canvasId, agent_name: 'Image test', local_file: true },
    })
    const [message] = ticket.content as { type: 'text'; text: string }[]
    expect(ticket.isError, message?.text).toBeFalsy()
    const { upload_url: url } = JSON.parse(message!.text)
    const put = () => fetch(url, { method: 'PUT', body: new Uint8Array(photo) })
    const reply = await put()
    expect(reply.status).toBe(200)
    const asset = await reply.json()
    expect(asset).toMatchObject({ url: expect.stringMatching(/\.webp$/), mime: 'image/webp' })
    expect((await put()).status).toBe(410)
  } finally {
    await agent.close()
  }
})
