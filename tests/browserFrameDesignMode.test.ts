import { readContextPrompt } from '../shared/uiElementContext'
import { mkdir } from 'node:fs/promises'
import { createServer, type Server as SiteServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest, serveBuilt, type BuiltServer } from './browser'
import { Client, freePort, startServer, type Server } from './harness'

const present = '[data-browser-surface="present"]:modal'
const field = '[data-design-note-field]'

async function annotate(page: Page) {
  await page.keyboard.down('Meta')
  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyD')
  await page.keyboard.up('Shift')
  await page.keyboard.up('Meta')
  await page.waitForSelector(`${present} [data-browser-viewport][aria-busy="false"] [data-design-shield]`, {
    visible: true,
  })
}

describe.skipIf(!findBrowserPath())('Design Mode on a browser frame', { timeout: 60_000 }, () => {
  const pages = pagePerTest()
  let site: SiteServer
  let web: BuiltServer
  let backend: Server
  let siteOrigin: string
  const upstreamCookies: Array<string | undefined> = []

  beforeAll(async () => {
    site = createServer((request, response) => {
      if (['node', 'undici'].includes(request.headers['user-agent'] ?? '')) upstreamCookies.push(request.headers.cookie)
      if (request.url === '/site.css') {
        response.writeHead(200, { 'Content-Type': 'text/css' })
        response.end('h1 { color: rgb(31, 39, 106); margin: 40px 32px; }')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end(`<!doctype html><link rel="stylesheet" href="site.css">
        <script>
          parent.postMessage({ type: 'doop:browse-ready', url: 'https://spoof.example/' }, '*')
          addEventListener('message', (event) => {
            if (event.data?.type === 'doop:runtime-port') document.documentElement.dataset.portExposed = 'true'
          }, true)
          document.addEventListener('DOMContentLoaded', () => {
            document.querySelector('#title').textContent = ${JSON.stringify(request.url === '/second' ? 'Second page' : 'Browser fixture')}
            parent.postMessage({ type: 'doop:browse-navigate', url: 'https://spoof.example/' }, '*')
          })
        </script>
        <h1 id="title"></h1><a href="/second">Next</a>`)
    })
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
    const address = site.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port')
    siteOrigin = `http://127.0.0.1:${address.port}`

    const port = await freePort()
    web = await serveBuilt({
      '/api': { target: `http://localhost:${port}` },
      '/ws': { target: `ws://localhost:${port}`, ws: true },
    })
    backend = await startServer({
      PORT: String(port),
      BETTER_AUTH_URL: web.origin,
      BROWSE_PROXY_ALLOW_ORIGINS: siteOrigin,
      RESIDENT_TASK_LIMIT: '10',
    })
  }, 180_000)

  afterAll(async () => {
    await web?.close()
    backend?.stop()
    await backend?.stopped
    if (site) await new Promise<void>((resolve) => site.close(() => resolve()))
  })

  it('keeps links in Design Mode, restores a URL pin after reload and sends it with the real URL', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1440, height: 960 })
    await page.goto(web.origin)
    const { canvasId, frameId } = await page.evaluate(async (url) => {
      async function post(path: string, data: object) {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        if (!response.ok) throw new Error(await response.text())
        return (await response.json()) as { id: string }
      }
      await post('/api/auth/sign-up/email', {
        name: 'Browser tester',
        email: 'browse-design@test.dev',
        password: 'password12345',
      })
      const { id: canvasId } = await post('/api/canvases', { name: 'Browser Design Mode' })
      const { id: frameId } = await post(`/api/canvases/${canvasId}/frames`, {
        name: 'External website',
        x: 150,
        y: 120,
        width: 620,
        height: 500,
        browser: { url },
      })
      return { canvasId, frameId }
    }, siteOrigin + '/')

    const route =
      '/api/browse-proxy?' + new URLSearchParams({ canvasId, url: siteOrigin + '/', session: crypto.randomUUID() })
    const outsider = await new Client(backend).signUp('browse-outsider@test.dev', 'Outsider')
    expect((await fetch(web.origin + route)).status).toBe(401)
    expect((await outsider.get(route)).status).toBe(403)
    expect(upstreamCookies).toHaveLength(0)

    await page.setRequestInterception(true)
    const posts: unknown[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/canvases/${canvasId}/cards`) {
        posts.push(JSON.parse(request.postData()!))
        void request.respond({ status: 200, contentType: 'application/json', body: '{"id":"browser-annotation"}' })
      } else void request.continue()
    })

    const mount = async () => {
      await page.goto(`${web.origin}/c/${canvasId}`)
      const frame = await page.waitForSelector('[data-browser-shield]', { visible: true })
      await frame!.click({ count: 2 })
      await page.waitForSelector(present, { visible: true })
    }
    const iframe = () => page.waitForSelector(`${present} iframe[data-design-screen]`, { visible: true })
    const shots = process.env.DOOP_DESIGN_SHOTS === '1' ? join(homedir(), 'doop-element-comments') : null
    if (shots) await mkdir(shots, { recursive: true })
    await mount()
    await annotate(page)
    let siteFrame = await (await iframe())!.contentFrame()
    await siteFrame!.waitForFunction(() => {
      const heading = document.querySelector('h1')
      return heading?.textContent === 'Browser fixture' && getComputedStyle(heading).color === 'rgb(31, 39, 106)'
    })

    expect(
      await siteFrame!.evaluate(() => {
        const canRead = (probe: () => unknown) => {
          try {
            probe()
            return true
          } catch {
            return false
          }
        }
        return {
          bootstrapVisible: !!document.querySelector('[data-v-boot]'),
          portExposed: document.documentElement.dataset.portExposed,
          parentReadable: canRead(() => parent.document),
          storageReadable: canRead(() => localStorage.length),
          cookiesReadable: canRead(() => document.cookie),
        }
      }),
    ).toEqual({
      bootstrapVisible: false,
      portExposed: undefined,
      parentReadable: false,
      storageReadable: false,
      cookiesReadable: false,
    })

    // The site's link should load a second URL through the authenticated proxy.
    await page.keyboard.down('Space')
    await page.waitForSelector('[data-design-shield]', { hidden: true })
    const navigationSaved = page.waitForResponse(
      (response) =>
        response.ok() &&
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === '/api/frames/' + frameId,
    )
    await siteFrame!.click('a')
    await page.keyboard.up('Space')
    await navigationSaved
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[data-design-screen]')
      return !!frame && new URL(frame.src).searchParams.get('url')?.endsWith('/second')
    })
    await page.waitForSelector('[data-design-shield]', { visible: true })
    const proxied = await iframe()
    siteFrame = await proxied!.contentFrame()
    expect(await siteFrame!.$eval('h1', (el) => el.textContent)).toBe('Second page')
    const heading = await siteFrame!.$('#title')
    const rect = await heading!.boundingBox()
    const x = rect!.x + rect!.width / 2
    const y = rect!.y + rect!.height / 2
    await page.mouse.move(x, y)
    await page.waitForSelector('[data-design-hover="#title"]', { visible: true })
    if (shots) await page.screenshot({ path: join(shots, 'dm-20-browser-frame-design-mode.png') })
    await page.mouse.click(x, y)
    await page.waitForSelector(field, { visible: true })
    await page.keyboard.type('Make the heading smaller')
    if (shots) await page.screenshot({ path: join(shots, 'dm-21-browser-frame-note.png') })

    await page.click('[data-design-card] [role="switch"]')
    await page.focus(field)
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-design-pin="1"][data-status="pending"]')
    expect(posts).toHaveLength(0)
    await mount()
    await annotate(page)
    await page.waitForSelector('[data-design-pin="1"][data-status="pending"]')
    await page.click('button[aria-label="Send 1 to agent"]')
    await page.waitForSelector(`${present} input[aria-label="URL"]`, { visible: true })
    expect(await page.$eval(`${present} input[aria-label="URL"]`, (input) => (input as HTMLInputElement).value)).toBe(
      siteOrigin + '/second',
    )
    await page.waitForFunction(
      (url) => document.querySelector<HTMLIFrameElement>('[data-browser-surface="present"] iframe')?.src === url,
      {},
      siteOrigin + '/second',
    )
    expect(upstreamCookies.length).toBeGreaterThan(0)
    expect(upstreamCookies.every((cookie) => cookie === undefined)).toBe(true)
    expect(posts).toEqual([
      expect.objectContaining({
        title: expect.stringContaining(`On ${siteOrigin}/second:\n<h1> — “Second page”: Make the heading smaller`),
        scope: { frameId, selector: '#title' },
        attachments: [],
      }),
    ])

    const title = (posts[0] as { title: string }).title
    expect(readContextPrompt(title).contexts[0]).toMatchObject({
      source: 'browser',
      url: siteOrigin + '/second',
      selector: '#title',
    })

    await annotate(page)
    const editFrame = await (await iframe())!.contentFrame()
    await editFrame!.waitForFunction(() => document.querySelector('#title')?.textContent === 'Second page')
    const editBox = await (await editFrame!.$('#title'))!.boundingBox()
    const editX = editBox!.x + 30
    const editY = editBox!.y + editBox!.height / 2
    await page.mouse.move(editX, editY)
    await page.waitForSelector('[data-design-hover="#title"]', { visible: true })
    await page.mouse.click(editX, editY, { count: 2 })
    await editFrame!.waitForSelector('#title[contenteditable="plaintext-only"]:focus')
    await page.waitForSelector('[data-design-shield]', { hidden: true })
    await page.keyboard.type('Edited second page')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-design-pin="2"][data-status="pending"]')
    await editFrame!.waitForFunction(() => document.querySelector('#title')?.textContent === 'Edited second page')

    const editedBox = await (await editFrame!.$('#title'))!.boundingBox()
    const cssX = editedBox!.x + 30
    const cssY = editedBox!.y + editedBox!.height / 2
    await page.mouse.move(cssX, cssY)
    await page.waitForSelector('[data-design-hover="#title"]', { visible: true })
    await page.mouse.click(cssX, cssY)
    await page.waitForSelector(field, { visible: true })
    expect(await page.$('[data-design-region]')).toBeNull()
    await page.locator('[data-design-card] button[aria-label="Edit CSS properties"]').click()
    const inspector = '[data-design-css-inspector]'
    const filter = `${inspector} input[aria-label="Filter properties"]`
    const color = `${inspector} input[aria-label="color"]`
    await page.waitForSelector(`${filter}:focus`)
    await page.keyboard.type('color')
    await page.waitForSelector(color, { visible: true })
    await page.$eval(color, (input) => (input as HTMLInputElement).select())
    await page.keyboard.type('#da1376')
    await editFrame!.waitForFunction(
      () => getComputedStyle(document.querySelector('#title')!).color === 'rgb(218, 19, 118)',
    )
    await page.keyboard.press('Escape')
    await page.waitForSelector(inspector, { hidden: true })
    await page.keyboard.press('Escape')
    await page.waitForSelector(field, { hidden: true })
    await editFrame!.waitForFunction(
      () => getComputedStyle(document.querySelector('#title')!).color === 'rgb(31, 39, 106)',
    )

    await page.mouse.move(cssX, cssY)
    await page.mouse.down()
    await page.mouse.move(cssX + 130, cssY + 80, { steps: 4 })
    await page.mouse.up()
    const draw = '[data-design-markup-tool="draw"]'
    await page.waitForSelector(`${draw}[aria-pressed="false"]`)
    await page.locator(draw).click()
    await page.waitForSelector(`${draw}[aria-pressed="true"]`)
    await page.mouse.move(cssX + 10, cssY + 10)
    await page.mouse.down()
    await page.mouse.move(cssX + 80, cssY + 45, { steps: 4 })
    await page.mouse.up()
    await page.waitForSelector('[data-markup-status="draft"] [data-markup-tool="draw"]')
  })
})
