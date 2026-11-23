import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import type { Frame } from '../shared/types'
import { fixtureUrl, pagePerTest } from './browser'
import { canvasFrame } from './canvasPageFixture'

const HOST = '127.0.0.1'
const SHIELD = '[data-browser-shield]'
const BAR = '.browser-canvas-bar'
const PRESENT = '.browser-surface:modal'
const SIDE = '.browser-surface:popover-open'
const LIVE = '[data-browser-active="true"]'

describe.skipIf(!findBrowserPath())('live browser on the canvas', () => {
  const pages = pagePerTest()
  let site: Server
  let url: string
  let blocked: boolean
  let page: Page
  let frames: Frame[]
  let writes: Partial<Frame>[]

  beforeAll(async () => {
    site = createServer((request, response) => {
      if (request.url === '/recover' && blocked) return response.destroy()
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
      response.end(
        '<!doctype html><body style="min-height:6000px"><input aria-label="Example"><h1>Live page</h1></body>',
      )
    })
    await new Promise<void>((resolve) => site.listen(0, HOST, resolve))
    const address = site.address()
    if (!address || typeof address === 'string') throw new Error('No browser fixture port')
    url = `http://${HOST}:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => site.close(() => resolve()))
  })

  beforeEach(async () => {
    page = await pages.open()
    page.setDefaultTimeout(6000)

    await page.setViewport({ width: 1440, height: 950 })
    frames = []
    writes = []
    blocked = false
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(window, 'WebSocket', {
        value: class {
          static OPEN = 1
          readyState = 0
          close() {}
        },
      })
    })
    await page.setRequestInterception(true)
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      if (!pathname.startsWith('/api/')) return void request.continue()
      let body: unknown = {}
      if (pathname === '/api/auth/get-session') body = { user: { id: 'u', name: 'Tester' }, session: { userId: 'u' } }
      if (pathname === '/api/canvases/c/frames' && request.method() === 'POST') {
        const data = JSON.parse(request.postData()!) as Partial<Frame>
        body = {
          ...canvasFrame({ id: 'browser', name: 'Browser', x: 150, y: 100, width: 1440, height: 900 }),
          html: '',
          ...data,
        }
        frames.push(body as Frame)
        writes.push(data)
      }
      if (pathname === '/api/frames/browser' && request.method() === 'PATCH') {
        const patch = JSON.parse(request.postData()!) as Partial<Frame>
        body = frames[0] = { ...frames[0]!, ...patch }
        writes.push(patch)
      }
      if (pathname.endsWith('/fonts') || pathname.endsWith('/versions')) body = []
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
  })

  async function seed(address?: string) {
    if (address !== undefined) {
      frames.push({
        ...canvasFrame({ id: 'browser', name: 'Browser', x: 150, y: 120, width: 620, height: 500 }),
        html: '',
        browser: { url: address },
      })
    }
    await page.goto(fixtureUrl('canvasPage.html'))
    await page.waitForFunction(() => !!window.canvasPageHarness && !!document.querySelector('.stage'))
    await page.evaluate((seedFrames) => window.canvasPageHarness.seed(seedFrames), frames)
    if (frames.length) await page.waitForSelector(SHIELD, { visible: true })
    // The floating Agents rail and Inspector can otherwise overlap the grips.
    const agentsClose = await page.$('button[aria-label="Close panel"]')
    if (agentsClose) await agentsClose.click()
  }

  async function clickButton(scope: string, name: string) {
    const selector = `${scope} button[aria-label="${name}"]`
    const hit = await page.$eval(selector, (button) => {
      const rect = button.getBoundingClientRect()
      const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return { hit: target?.closest('button') === button, rect: rect.toJSON(), target: target?.outerHTML.slice(0, 150) }
    })
    expect(hit.hit, JSON.stringify(hit)).toBe(true)
    await page.click(selector)
  }

  it('places an empty browser with B, focuses its prompt and commits a normalized URL', async () => {
    await seed()
    await page.keyboard.press('KeyB')
    await page.mouse.click(360, 180)
    await page.waitForFunction(() => document.activeElement?.matches('.browser-message input'))
    expect(writes[0]).toMatchObject({ width: 1440, height: 900, browser: { url: '' } })
    await page.keyboard.type(url.replace('http://', ''))
    await page.keyboard.press('Enter')
    await expect.poll(() => writes.at(-1)?.browser?.url).toBe(url + '/')
    await page.waitForFunction(() =>
      document.querySelector('.browser-canvas-bar button[aria-label="URL"]')?.textContent?.startsWith('127.0.0.1:'),
    )
  })

  it('selects an existing empty browser without focusing its prompt', async () => {
    await seed('')
    await page.click(SHIELD)
    await page.waitForSelector('.browser-message input', { visible: true })
    expect(await page.evaluate(() => document.activeElement?.matches('.browser-message input'))).toBe(false)
    await page.click('.browser-message input')
    expect(await page.evaluate(() => document.activeElement?.matches('.browser-message input'))).toBe(true)
  })

  it('activates on the next click, escapes without clearing selection, and presents on double click', async () => {
    await seed(url)
    await page.waitForSelector('iframe[title="Browser"]', { visible: true })
    const labels = await page.$$eval(`${BAR} button[aria-label]`, (buttons) =>
      buttons.map((button) => ({ label: button.getAttribute('aria-label'), title: button.getAttribute('title') })),
    )
    expect(labels).toEqual(
      expect.arrayContaining(
        ['Reload browser', 'Switch device size', 'Open browser in side panel', 'Present browser'].map((label) => ({
          label,
          title: label,
        })),
      ),
    )
    await page.click(SHIELD)
    expect(await page.$(LIVE)).toBeNull()
    await page.click(SHIELD)
    await page.waitForSelector(LIVE)
    expect(
      await page.$eval(`${BAR} button[aria-label="Leave browser interaction"]`, (button) => button.textContent?.trim()),
    ).toBe('Esc')
    await page.keyboard.press('Escape')
    await page.waitForSelector(LIVE, { hidden: true })
    expect(await page.$('[data-frame-resize-handles]')).not.toBeNull()

    const element = await page.$('iframe[title="Browser"]')
    const child = await element?.contentFrame()
    expect(child).toBeTruthy()
    await child!.waitForSelector('h1')
    await child!.evaluate(() => window.scrollTo(0, 400))
    await page.click(SHIELD, { count: 2 })
    await page.waitForSelector(PRESENT, { visible: true })
    await page.keyboard.press('Escape')
    await page.waitForSelector(PRESENT, { hidden: true })
    expect(await element!.evaluate((iframe) => iframe.isConnected)).toBe(true)
    expect(await child!.evaluate(() => window.scrollY)).toBe(400)
    expect(await page.$('[data-frame-resize-handles]')).not.toBeNull()

    await clickButton(BAR, 'Open browser in side panel')
    await page.waitForSelector(SIDE, { visible: true })
    expect(await page.$eval(SIDE, (surface) => surface.getBoundingClientRect().right)).toBe(1440)
    await clickButton(SIDE, 'Close browser')
    await page.waitForSelector(SIDE, { hidden: true })
    expect(await child!.evaluate(() => window.scrollY)).toBe(400)
  }, 15_000)

  it('keeps browser controls clickable with the Hand or a drawing tool selected', async () => {
    await seed(url)
    for (const tool of ['Hand', 'Rectangle']) {
      await page.click(`[aria-label="Canvas tools"] button[aria-label="${tool}"]`)
      await clickButton(BAR, 'Present browser')
      await page.waitForSelector(PRESENT, { visible: true })
      await page.keyboard.press('Escape')
      await page.waitForSelector(PRESENT, { hidden: true })
    }
    expect(writes).toEqual([])
  })

  it('offers Retry when the browser cannot reach the page and loads it when it returns', async () => {
    blocked = true
    await seed(`${url}/recover`)
    await page.waitForSelector('.browser-message [type="button"]', { visible: true })
    expect(await page.$eval('.browser-message', (node) => node.textContent)).toContain(
      `Can't reach ${new URL(url).host}`,
    )
    blocked = false
    await page.click('.browser-message button')
    await page.waitForSelector('iframe[title="Browser"]', { visible: true })
    await page.waitForSelector('.browser-message', { hidden: true })
  })

  it('reuses the frame handles for Shift-resizing and reflows the page at the device and page zoom', async () => {
    await seed(url)
    await page.click(SHIELD)
    const handle = await page.$eval('[data-frame-resize-handle="se"]', (node) => {
      const rect = node.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
    await page.keyboard.down('Shift')
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.outerHTML.slice(0, 250), handle)
    expect(hit, JSON.stringify(handle)).toContain('data-frame-resize-handle="se"')
    await page.mouse.move(handle.x, handle.y)
    await page.mouse.down()
    await page.mouse.move(handle.x + 62, handle.y + 15, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await expect.poll(() => writes.length).toBeGreaterThan(0)
    expect(writes[0]!.width! / writes[0]!.height!).toBeCloseTo(620 / 500, 2)
    await page.select('select:has(option[value=phone])', 'phone')
    await expect.poll(() => writes.at(-1)?.width).toBe(390)
    const zoom = await page.$('select:has(option[value="1.5"])')
    await zoom!.select('1.5')
    await page.waitForFunction(
      () => document.querySelector<HTMLIFrameElement>('iframe[title="Browser"]')?.style.width === '260px',
    )
  })

  it.runIf(!!process.env.DOOP_BROWSER_VISUAL)(
    'shows the real port 8747 page at desktop and mobile widths',
    async () => {
      await seed('http://127.0.0.1:8747/')
      await page.waitForFunction(
        () => !!document.querySelector('iframe[title="Browser"]') && !document.querySelector('.browser-progress'),
      )
      const frame = await (await page.$('iframe[title="Browser"]'))?.contentFrame()
      expect(await frame?.title()).toMatch(/Akimov|Акимов/i)
      await page.screenshot({ path: join(process.env.DOOP_BROWSER_VISUAL!, 'browser-canvas.png') })
      await clickButton(BAR, 'Present browser')
      await page.waitForSelector(PRESENT, { visible: true })
      for (const width of [1440, 768, 375]) {
        await page.setViewport({ width, height: 900 })
        await page.waitForFunction(() =>
          document
            .querySelector('.browser-surface:modal')
            ?.getAnimations()
            .every((animation) => animation.playState === 'finished'),
        )
        await page.screenshot({ path: join(process.env.DOOP_BROWSER_VISUAL!, `browser-${width}.png`) })
      }
      await page.keyboard.press('Escape')
      await page.waitForSelector(PRESENT, { hidden: true })
    },
    30_000,
  )
})
