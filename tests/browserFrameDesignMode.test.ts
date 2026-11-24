import { readContextPrompt } from '../shared/uiElementContext'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type Server as SiteServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest, replaceInputText, serveBuilt, type BuiltServer } from './browser'
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
      if (request.url === '/crop-bg.svg') {
        response.writeHead(200, { 'Content-Type': 'image/svg+xml' })
        response.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="#deddf2"/></svg>',
        )
        return
      }
      if (request.url === '/site.css') {
        response.writeHead(200, { 'Content-Type': 'text/css' })
        response.end(`
          h1 { color: rgb(31, 39, 106); margin: 40px 32px; background-image:url(crop-bg.svg); }
          a { background: #badfd3; }
          #summary { width: max-content; background: #deb5f7; }
        `)
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
        <h1 id="title"></h1><a id="next" href="/second">Next</a><ul><li id="summary">Sample summary</li></ul>`)
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

  it('returns a visible PNG crop from the server fallback endpoint', async () => {
    const user = await new Client(backend).signUp('crop-fallback@test.dev', 'Crop fallback tester')
    const canvasResponse = await user.post('/api/canvases', { name: 'Fallback capture' })
    expect(canvasResponse.ok).toBe(true)
    const { id: canvasId } = await canvasResponse.json()
    const frameResponse = await user.post(`/api/canvases/${canvasId}/frames`, {
      name: 'Fallback crop fixture',
      width: 320,
      height: 240,
      html: '<!doctype html><style>body{margin:0;min-height:600px}main{margin-top:300px;width:120px;height:100px;background:#24326b}</style><main></main>',
    })
    expect(frameResponse.ok).toBe(true)
    const { id: frameId } = await frameResponse.json()
    const response = await user.get(
      `/api/frames/${frameId}/screenshot.png?capture=visible&y=200&crop=10,105,60,40&scale=1`,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    const { data, info } = await sharp(Buffer.from(await response.arrayBuffer()))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(info).toMatchObject({ width: 60, height: 40, channels: 3 })
    expect([...data.subarray(0, 3)]).toEqual([36, 50, 107])
  })

  it('keeps links in Design Mode, restores a URL pin after reload and sends it with the real URL', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 2 })
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
    const cropRoute =
      '/api/browse-proxy?' +
      new URLSearchParams({
        canvasId,
        url: siteOrigin + '/',
        resource: siteOrigin + '/crop-bg.svg',
      })
    const cropHeaders = { 'X-Doop-Crop-Resource': '1' }
    expect((await fetch(web.origin + cropRoute, { headers: cropHeaders })).status).toBe(401)
    const foreignResourceStatus = await page.evaluate(
      async (path, headers) => {
        const url = new URL(path, location.href)
        url.searchParams.set('resource', 'https://example.com/crop-bg.svg')
        return (await fetch(url, { headers })).status
      },
      cropRoute,
      cropHeaders,
    )
    expect(foreignResourceStatus).toBe(400)
    expect(upstreamCookies).toHaveLength(0)

    await page.setRequestInterception(true)
    const posts: unknown[] = []
    const cropRequests: string[] = []
    const cropUploads: string[] = []
    const cropResources: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (request.method() === 'POST' && url.pathname === `/api/canvases/${canvasId}/cards`) {
        posts.push(JSON.parse(request.postData()!))
        void request.respond({ status: 200, contentType: 'application/json', body: '{"id":"browser-annotation"}' })
      } else if (request.headers()['x-doop-crop-resource'] === '1') {
        cropResources.push(url.searchParams.get('resource') ?? '')
        void request.continue()
      } else if (url.pathname === `/api/frames/${frameId}/screenshot.png`) {
        cropRequests.push(request.url())
        void request.respond({ status: 500 })
      } else if (request.method() === 'POST' && url.pathname === `/api/canvases/${canvasId}/assets`) {
        cropUploads.push(request.headers()['content-type'] ?? '')
        void request.respond({ status: 200, contentType: 'application/json', body: '{"url":"/a/live-crop.png"}' })
      } else void request.continue()
    })

    const mount = async () => {
      await page.goto(`${web.origin}/c/${canvasId}`)
      await page.evaluate(() =>
        Object.assign(window, { __DOOP_DESKTOP__: '0.14.0', __DOOP_DESKTOP_TRAFFIC_LIGHTS__: true }),
      )
      await page.locator('[data-browser-shield]').click({ count: 2 })
      await page.waitForSelector(present, { visible: true })
    }
    const iframe = () => page.waitForSelector(`${present} iframe[data-design-screen]`, { visible: true })
    const shots = process.env.DOOP_DESIGN_SHOTS === '1' ? join(homedir(), 'doop-element-comments') : null
    if (shots) await mkdir(shots, { recursive: true })
    await mount()
    const bar = `${present} .browser-overlay-bar`
    expect(
      await page.$eval(`${bar} button[aria-label="Back"]`, (el) => el.getBoundingClientRect().left),
    ).toBeGreaterThanOrEqual(76)
    const designToggle = `${bar} [data-design-toggle]`
    await page.click(designToggle)
    await page.waitForSelector(`${designToggle}[aria-pressed="true"]`)
    await page.waitForSelector(`${present} [data-browser-viewport][aria-busy="false"] [data-design-shield]`, {
      visible: true,
    })
    expect(
      await page.$eval(`${bar} [data-design-hint]`, (el) => el.getBoundingClientRect().left),
    ).toBeGreaterThanOrEqual(76)
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
    // Reload only after the live PNG is in the same store the queue will read.
    await page.waitForFunction(async () => {
      const name = 'doop.designCrops'
      if (!(await indexedDB.databases()).some((db) => db.name === name)) return false
      return new Promise<boolean>((resolve) => {
        const open = indexedDB.open(name)
        open.onerror = () => resolve(false)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction('png')
          const count = tx.objectStore('png').count()
          tx.oncomplete = () => {
            db.close()
            resolve(count.result === 1)
          }
          tx.onabort = () => {
            db.close()
            resolve(false)
          }
        }
      })
    })
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
    expect(cropRequests).toEqual([])
    expect(cropResources).toEqual([siteOrigin + '/crop-bg.svg'])
    expect(cropUploads).toEqual(['image/png'])
    expect(posts).toEqual([
      expect.objectContaining({
        title: expect.stringContaining(`On ${siteOrigin}/second:\n<h1> — “Second page”: Make the heading smaller`),
        scope: { frameId, selector: '#title' },
        attachments: [expect.any(String)],
      }),
    ])

    const title = (posts[0] as { title: string }).title
    expect(readContextPrompt(title).contexts[0]).toMatchObject({
      source: 'browser',
      url: siteOrigin + '/second',
      selector: '#title',
    })

    await annotate(page)
    const chipFrame = await (await iframe())!.contentFrame()
    await chipFrame!.waitForFunction(() => document.querySelector('#title')?.textContent === 'Second page')
    const chips = `${present} [data-preview-chat] [data-context-chip]`
    const surface = await (await iframe())!.evaluate((el) => {
      const { x, y, width, height } = el.getBoundingClientRect()
      return { x, y, scaleX: width / el.clientWidth, scaleY: height / el.clientHeight }
    })
    const mouse = await page.createCDPSession()
    const selectionCases = [
      { selector: '#title', hoverSelector: '#title' },
      { selector: 'a', hoverSelector: '#next' },
      { selector: '#summary', hoverSelector: '#summary' },
    ]
    for (const [index, { selector, hoverSelector }] of selectionCases.entries()) {
      const target = await chipFrame!.$eval(selector, (el) => {
        const box = el.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height, viewport: innerWidth }
      })
      const box = {
        x: surface.x + target.x * surface.scaleX,
        y: surface.y + target.y * surface.scaleY,
        width: target.width * surface.scaleX,
        height: target.height * surface.scaleY,
      }
      await page.mouse.move(5, 5)
      await page.waitForSelector('[data-design-hover]', { hidden: true })
      // Use the real viewport pixels as an independent reference. The eight
      // CSS pixels of context are part of the thumbnail, including at x=0.
      const left = Math.max(0, Math.floor(target.x) - 8)
      const top = Math.max(0, Math.floor(target.y) - 8)
      const right = Math.min(target.viewport, Math.ceil(target.x + target.width) + 8)
      const bottom = Math.ceil(target.y + target.height) + 8
      const reference = await page.screenshot({
        type: 'png',
        clip: {
          x: surface.x + left * surface.scaleX,
          y: surface.y + top * surface.scaleY,
          width: (right - left) * surface.scaleX,
          height: (bottom - top) * surface.scaleY,
        },
      })
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      const hover = await page.waitForSelector('[data-design-hover]', { visible: true })
      expect(await hover!.evaluate((el) => el.getAttribute('data-design-hover'))).toBe(hoverSelector)
      const ring = (await hover!.boundingBox())!
      for (const edge of ['x', 'y', 'width', 'height'] as const)
        expect(Math.abs(ring[edge] - box[edge])).toBeLessThan(1)
      // Drive trusted input with Option in the mouse event flags and no key events.
      const click = {
        x,
        y,
        button: 'left',
        clickCount: 1,
        modifiers: 1, // CDP's Alt bit
      } as const
      await mouse.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...click })
      await mouse.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...click })
      await page.waitForFunction(
        (chips, count) => document.querySelectorAll(chips).length === count,
        {},
        chips,
        index + 1,
      )
      expect(await page.$(`${bar} input[aria-label="URL"]`)).toBeNull()
      expect(await page.$(`${bar} [data-design-hint]`)).not.toBeNull()
      const thumb = `${chips}:nth-child(${index + 1}) img[data-context-thumbnail]`
      const image = await page.waitForSelector(thumb)
      const png = Buffer.from(
        await image!.evaluate(async (el) => {
          const response = await fetch((el as HTMLImageElement).src)
          return [...new Uint8Array(await response.arrayBuffer())]
        }),
      )
      // Compare on the CSS-pixel grid so Retina antialiasing differences
      // do not obscure movement of the element inside the crop.
      const pixels = (bytes: Uint8Array) =>
        sharp(bytes)
          .resize(right - left, bottom - top, { fit: 'fill' })
          .removeAlpha()
          .raw()
          .toBuffer()
      const [actual, expected] = await Promise.all([pixels(png), pixels(reference)])
      let different = 0
      for (let i = 0; i < expected.length; i += 3) {
        if ([0, 1, 2].some((channel) => Math.abs(actual[i + channel]! - expected[i + channel]!) > 32)) different++
      }
      if (shots) {
        await writeFile(join(shots, `dm-27-proxy-${index}-crop.png`), png)
        await writeFile(join(shots, `dm-27-proxy-${index}-reference.png`), reference)
      }
      expect(different / (expected.length / 3)).toBeLessThan(0.12)
    }
    await mouse.detach()
    await page.waitForFunction(
      (chips) => {
        const images = [...document.querySelectorAll<HTMLImageElement>(`${chips} [data-context-thumbnail]`)]
        return images.length === 3 && images.every((image) => image.complete && image.naturalWidth > 0)
      },
      {},
      chips,
    )
    const thumbnailSizes = await page.$$eval(`${chips} img[data-context-thumbnail]`, (images) =>
      images.map((image) => `${image.naturalWidth}x${image.naturalHeight}`),
    )
    expect(new Set(thumbnailSizes).size).toBe(3)
    expect(cropRequests).toEqual([])
    if (shots) await page.screenshot({ path: join(shots, 'dm-option-click-browser-three-chips.png') })
    await page.keyboard.press('Escape')
    await page.waitForSelector(`${bar} input[aria-label="URL"]`, { visible: true })
    expect(await page.$$eval(chips, (elements) => elements.map((element) => element.textContent))).toEqual([
      '<h1> Second page',
      '<a> Next',
      '<li> Sample summary',
    ])

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
    const selection = '[data-design-selection]'
    const beforeHeight = await page.$eval(selection, (el) => el.getBoundingClientRect().height)
    await replaceInputText(page, filter, 'font-size')
    await replaceInputText(page, `${inspector} input[aria-label="font-size"]`, '48px')
    await editFrame!.waitForFunction(() => getComputedStyle(document.querySelector('#title')!).fontSize === '48px')
    const elementHeight = await editFrame!.$eval('#title', (el) => el.getBoundingClientRect().height)
    const scale = await page.$eval(
      `${present} iframe[data-design-screen]`,
      (el) => el.getBoundingClientRect().height / el.clientHeight,
    )
    const expectedHeight = elementHeight * scale
    expect(expectedHeight).toBeGreaterThan(beforeHeight)
    await page.waitForFunction(
      (selection, height) =>
        Math.abs((document.querySelector(selection)?.getBoundingClientRect().height ?? 0) - height) < 1,
      {},
      selection,
      expectedHeight,
    )
    await replaceInputText(page, filter, 'color')
    await replaceInputText(page, color, '#da1376')
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
