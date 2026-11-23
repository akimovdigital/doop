import { expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer } from './harness'
import type { Frame, ServerMessage } from '../shared/types'

it('preserves a Browser frame over the update broadcast, database restart and canvas duplication', async () => {
  let server = await startServer()
  let ws: WebSocket | undefined
  try {
    const user = new Client(server)
    await user.signUp('browser@test.dev', 'Browser Owner')
    const canvas = await (await user.post('/api/canvases', { name: 'Browser test' })).json()
    const created = await user.post(`/api/canvases/${canvas.id}/frames`, {
      name: 'Browser',
      width: 1440,
      height: 900,
      browser: { url: '' },
    })
    expect(created.status).toBe(200)
    const frame = (await created.json()) as Frame
    expect(frame.html).toBe('')
    expect(frame.browser).toEqual({ url: '' })

    const wsUrl = server.base.replace(/^http/, 'ws') + '/ws'
    const socket = new WebSocket(wsUrl, { headers: { Cookie: user.header() } })
    ws = socket
    socket.once('open', () => {
      socket.send(
        JSON.stringify({ type: 'join', canvasId: canvas.id, clientId: 'browser-test', name: 'Test', kind: 'user' }),
      )
    })
    function read<T extends ServerMessage['type']>(type: T) {
      return new Promise<Extract<ServerMessage, { type: T }>>((resolve) =>
        socket.on('message', function listener(raw) {
          const message = JSON.parse(String(raw)) as Extract<ServerMessage, { type: T }>
          if (message.type !== type) return
          socket.off('message', listener)
          resolve(message)
        }),
      )
    }
    const init = await read('init')
    expect(init.canvas.frames.find((f) => f.id === frame.id)?.browser).toEqual({ url: '' })
    const browser = { url: 'http://127.0.0.1:8747/', deviceId: 'tablet', zoom: 1.25, scrollX: 2, scrollY: 15 }
    const update = read('frame:updated')
    expect((await user.patch(`/api/frames/${frame.id}`, { browser, width: 768, height: 1024 })).status).toBe(200)
    expect((await update).frame).toMatchObject({ browser, width: 768, height: 1024, html: '' })
    expect((await user.patch(`/api/frames/${frame.id}`, { browser: { url: 'javascript:alert(1)' } })).status).toBe(400)
    ws.close()

    const duplicate = await (await user.post(`/api/canvases/${canvas.id}/duplicate`)).json()
    const directory = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer({}, directory)
    const reopened = new Client(server)
    expect(
      (await reopened.post('/api/auth/sign-in/email', { email: 'browser@test.dev', password: 'password12345' })).status,
    ).toBe(200)

    for (const id of [canvas.id, duplicate.id]) {
      const data = await (await reopened.get(`/api/canvases/${id}`)).json()
      expect(data.frames).toMatchObject([{ html: '', browser, width: 768, height: 1024 }])
    }
  } finally {
    ws?.close()
    server.stop()
  }
}, 70_000)

it('keeps local Browser URLs live-only when a canvas editor requests a server capture', async () => {
  const server = await startServer()
  try {
    const user = new Client(server)
    await user.signUp('browser-capture@test.dev', 'Browser Editor')
    const canvas = await (await user.post('/api/canvases', { name: 'Browser capture' })).json()
    const reference = await (
      await user.post(`/api/canvases/${canvas.id}/frames`, {
        name: 'Local reference',
        width: 620,
        height: 500,
        browser: { url: 'http://127.0.0.1:8747/' },
      })
    ).json()
    const capture = await user.get(`/api/frames/${reference.id}/screenshot.png?capture=full`)
    expect(capture.status).toBe(500)
    expect(await capture.json()).toMatchObject({ error: 'that host is not reachable from here' })
    const after = await (await user.get(`/api/canvases/${canvas.id}`)).json()
    expect(after.frames).toMatchObject([{ id: reference.id, browser: { url: 'http://127.0.0.1:8747/' } }])
  } finally {
    server.stop()
  }
}, 60_000)
