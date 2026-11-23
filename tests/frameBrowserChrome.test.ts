import { join } from 'node:path'
import type { Frame as BrowserDocument, Page } from 'puppeteer-core'
import { beforeEach, describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import type { Frame } from '../shared/types'
import { pagePerTest } from './browser'
import { canvasFrame, showCanvasPage } from './canvasPageFixture'

const BAR = '[data-html-browser-chrome] .browser-canvas-bar'
const TOOLS = '[data-html-browser-chrome] .browser-under-bar'
const SHELL = '[data-doop-frame-shell="landing"]'
const SURFACE = `${SHELL} [data-frame-surface]`
const ACTIVE = '[data-html-frame-active]'
const SIDE = '[data-browser-surface="side"]:popover-open'
const VISUAL = process.env.DOOP_FRAME_CHROME_VISUAL
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aZl8AAAAASUVORK5CYII=',
  'base64',
)

const landing = {
  ...canvasFrame({ id: 'landing', name: 'Fieldwork Studio', x: 150, y: 120, width: 740, height: 520 }),
  html: `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <style>
    *{box-sizing:border-box}body{margin:0;background:#f5efe2;color:#262b21;font:16px system-ui}
    header{padding:22px 40px;border-bottom:1px solid #a0a794;display:flex;justify-content:space-between}
    main{padding:42px 40px;background:linear-gradient(125deg,#f5efe2 56%,#b4bf9d 56%,#7f9168)}
    h1{font:64px/.96 Georgia;margin:14px 0 24px;max-width:450px}
    button{font:inherit;border:0;border-radius:24px;padding:11px 17px;color:#fff;background:#23341e;cursor:pointer}
    section{padding:26px 40px;min-height:185px;background:#23341e;color:#fff}
  </style></head><body>
  <header><strong>FIELDWORK STUDIO</strong><a href="#approach">Our approach</a></header>
  <main><small>LANDSCAPE ARCHITECTURE</small><h1>Gardens that belong.</h1>
  <p>Outdoor spaces designed for the seasons and the people who live in them.</p>
  <button id="visit">Plan a visit</button><output id="result"></output></main>
  <section id="approach"><h2>Start with the soil.</h2><p>Design shaped by the place itself.</p></section>
  </body></html>`,
}

describe.skipIf(!findBrowserPath())('HTML frame browser chrome', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page
  let frames: Frame[]
  let importBody: unknown
  let uploads = 0

  beforeEach(async () => {
    page = await pages.open()
    await page.setViewport({ width: 1440, height: 950 })
    page.setDefaultTimeout(6000)
    frames = []
    importBody = null
    uploads = 0
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(window, 'WebSocket', {
        value: class {
          static OPEN = 1
          readyState = 0
          close() {}
        },
      })
    })
    if (VISUAL) {
      await page.evaluateOnNewDocument(() => {
        const fetchResource = window.fetch
        window.fetch = async (resource, options) => {
          const response = await fetchResource(resource, options)
          if (resource !== '/api/canvases/c/assets' || !(options?.body instanceof Blob)) return response
          const image = options.body
          const url = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(reader.error)
            reader.readAsDataURL(image)
          })
          return Response.json({ ...(await response.json()), url })
        }
      })
    }
    await page.setRequestInterception(true)
    page.on('request', (request) => {
      const { pathname } = new URL(request.url())
      if (new URL(request.url()).hostname === 'example.test') {
        return void request.respond({ status: 200, contentType: 'text/html', body: '<h1>Browser reference</h1>' })
      }
      if (pathname === '/c/c/proto') {
        return void request.respond({ status: 200, contentType: 'text/html', body: '<h1>Prototype route</h1>' })
      }
      if (pathname === '/a/snapshot.png') {
        return void request.respond({ status: 200, contentType: 'image/png', body: PNG })
      }
      if (!pathname.startsWith('/api/')) return void request.continue()
      let body: unknown = {}
      if (pathname === '/api/auth/get-session') body = { user: { id: 'u', name: 'Tester' }, session: { userId: 'u' } }
      if (pathname === '/api/agent-runners') body = { runners: [] }
      if (pathname.endsWith('/fonts') || pathname.endsWith('/versions')) body = []
      if (pathname === '/api/canvases/c/assets' && request.method() === 'POST') {
        uploads++
        body = { url: '/a/snapshot.png', mime: 'image/png', size: PNG.length }
      }
      if (pathname === '/api/canvases/c/frames' && request.method() === 'POST') {
        const input = JSON.parse(request.postData()!) as Partial<Frame>
        body = { ...canvasFrame({ id: 'capture', name: 'Capture', x: 0, y: 0, width: 1, height: 1 }), ...input }
        frames.push(body as Frame)
      }
      if (pathname === '/api/canvases/c/import' && request.method() === 'POST') {
        const input = JSON.parse(request.postData()!) as {
          url: string
          placement: { x: number; y: number; pageId: string }
        }
        importBody = input
        body = {
          ...canvasFrame({ id: 'imported', name: 'Imported', x: 0, y: 0, width: 500, height: 300 }),
          ...input.placement,
          html: '<!doctype html><h1>Editable import</h1>',
        }
        frames.push(body as Frame)
      }
      const frame = frames.find((entry) => pathname === `/api/frames/${entry.id}`)
      if (frame && request.method() === 'PATCH') {
        Object.assign(frame, JSON.parse(request.postData()!))
        body = frame
      }
      if (frame && request.method() === 'DELETE') frames = frames.filter((entry) => entry !== frame)
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
  })

  async function seed(seedFrames: Frame[] = [landing]) {
    frames = structuredClone(seedFrames)
    await showCanvasPage(page, seedFrames)
    const close = await page.$('button[aria-label="Close panel"]')
    if (close) await close.click()
  }

  async function clickButton(scope: string, label: string) {
    await page.click(`${scope} button[aria-label="${label}"]`)
  }

  async function screenshot(name: string) {
    if (VISUAL) await page.screenshot({ path: join(VISUAL, `${name}.png`) })
  }

  async function child() {
    const iframe = await page.waitForSelector(`${SHELL} iframe`)
    const document = await iframe!.contentFrame()
    if (!document) throw new Error('HTML document did not mount')
    await document.waitForSelector('h1')
    return document
  }

  async function centerOf(selector: string) {
    return page.$eval(selector, (element) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
  }

  async function pointInDocument(doc: BrowserDocument, selector: string) {
    // The canvas applies CSS zoom to the iframe. Puppeteer's child click adds
    // the unscaled child coordinates to the scaled iframe's screen position.
    const { x, y, viewportWidth, viewportHeight } = await doc.$eval(selector, (element) => {
      const rect = element.getBoundingClientRect()
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
      }
    })
    const iframe = await doc.frameElement()
    const box = await iframe?.boundingBox()
    if (!box) throw new Error('HTML document has no viewport on the canvas')
    return { x: box.x + (x * box.width) / viewportWidth, y: box.y + (y * box.height) / viewportHeight }
  }

  async function emptyPoint() {
    return page.$eval('.stage', (stage) => {
      const rect = stage.getBoundingClientRect()
      for (let y = rect.bottom - 56; y > rect.top + 60; y -= 24) {
        for (let x = rect.left + 260; x < rect.right - 260; x += 24) {
          if (document.elementFromPoint(x, y)?.matches('.stage, .world')) return { x, y }
        }
      }
      throw new Error('Canvas has no empty point')
    })
  }

  async function undo() {
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform))
    const key = mac ? 'Meta' : 'Control'
    await page.keyboard.down(key)
    await page.keyboard.press('KeyZ')
    await page.keyboard.up(key)
  }

  it('mounts one hover bar for 20 HTML frames, bridges the gap, and unmounts it on leave', async () => {
    await seed([
      landing,
      ...Array.from({ length: 19 }, (_, i) =>
        canvasFrame({
          id: `idle-${i}`,
          name: `Frame ${i}`,
          x: 930 + (i % 5) * 90,
          y: 120 + Math.floor(i / 5) * 95,
          width: 75,
          height: 70,
        }),
      ),
    ])
    expect(await page.$$('[data-canvas-browser-chrome]')).toHaveLength(0)
    await page.hover(SURFACE)
    await page.waitForSelector(BAR, { visible: true })
    expect(await page.$eval(BAR, (bar) => bar.textContent)).toContain('/c/c/proto?frame=landing')
    expect(await page.$(TOOLS)).toBeNull()
    expect(await page.$$('[data-canvas-browser-chrome]')).toHaveLength(1)
    await page.hover(`${BAR} button[aria-label="Copy preview link"]`)
    await new Promise((resolve) => setTimeout(resolve, 220))
    expect(await page.$$(BAR)).toHaveLength(1)
    await page.hover('[aria-label="Canvas tools"]')
    await page.waitForSelector(BAR, { hidden: true })
  })

  it('keeps text and layer editing gestures and enters and exits explicit interaction', async () => {
    await seed()
    const doc = await child()
    await page.hover(SURFACE)
    await page.waitForSelector(BAR)
    await screenshot('01-hover')
    await page.click(SURFACE)
    await page.waitForSelector(TOOLS, { visible: true })
    const empty = await emptyPoint()
    await page.mouse.move(empty.x, empty.y)
    await screenshot('02-selected')
    expect(await page.$(TOOLS)).not.toBeNull()
    const heading = await pointInDocument(doc, 'h1')
    await page.mouse.click(heading.x, heading.y)
    await page.waitForSelector(`${SHELL} [data-element-outline]`)
    await page.mouse.click(heading.x, heading.y, { count: 2 })
    await doc.waitForSelector('h1[contenteditable]')
    expect(await page.$('[data-prototype-player]')).toBeNull()
    await page.keyboard.type('Gardens for everyday life.')
    await clickButton(BAR, 'Reload browser')
    await expect.poll(() => frames[0]?.html).toContain('Gardens for everyday life.')
    await doc.waitForFunction(() => document.querySelector('h1')?.textContent === 'Gardens for everyday life.')

    // Scripted documents are playable but are excluded from Doop's inline text editor.
    await seed([
      {
        ...landing,
        html: frames[0]!.html.replace(
          '</body>',
          "<script>let visits=0;document.querySelector('#visit').onclick=()=>{document.querySelector('#result').textContent=' Visit requested '+ ++visits;};</script></body>",
        ),
      },
    ])
    const playable = await child()
    await page.click(SURFACE)
    await page.waitForSelector(TOOLS, { visible: true })
    const outside = await emptyPoint()
    for (const [index, exit] of ['escape', 'outside', 'cap'].entries()) {
      await clickButton(BAR, 'Interact with page')
      await page.waitForSelector(ACTIVE)
      const visit = await pointInDocument(playable, '#visit')
      await page.mouse.click(visit.x, visit.y)
      await playable.waitForFunction(
        (count) => document.querySelector('#result')?.textContent === ` Visit requested ${count}`,
        {},
        index + 1,
      )
      expect(
        await page.$eval(`${BAR} button[aria-label="Leave browser interaction"]`, (button) => button.textContent),
      ).toBe('Esc')
      if (exit === 'escape') {
        await screenshot('03-active')
        await page.keyboard.press('Escape')
      } else if (exit === 'cap') await clickButton(BAR, 'Leave browser interaction')
      else await page.mouse.click(outside.x, outside.y)
      await page.waitForSelector(ACTIVE, { hidden: true })
      expect(await page.$(TOOLS)).not.toBeNull()
    }
  }, 30_000)

  it('picks an element through Doop, resizes with undo, opens the side preview and Presents', async () => {
    await seed()
    const doc = await child()
    await page.click(SURFACE)
    await page.waitForSelector(TOOLS)
    await clickButton(TOOLS, 'Pick element')
    const heading = await pointInDocument(doc, 'h1')
    await page.mouse.move(heading.x, heading.y)
    await page.waitForSelector(`${SHELL} [data-hover-outline]`)
    await screenshot('04-pick')
    await page.mouse.click(heading.x, heading.y)
    await page.waitForSelector(`${SHELL} [data-element-outline]`)
    expect(await page.$('[data-html-frame-picking]')).toBeNull()

    await clickButton(BAR, 'Switch to Laptop · 1440 × 900')
    await expect.poll(() => frames[0]?.width).toBe(1440)
    expect(frames[0]?.height).toBe(900)
    await undo()
    await expect.poll(() => frames[0]?.width).toBe(740)
    expect(frames[0]?.height).toBe(520)
    await clickButton(BAR, 'Open browser in side panel')
    await page.waitForSelector(SIDE)
    expect(
      await page.$eval(`${SIDE} iframe`, (iframe) => new URL(iframe.src).pathname + new URL(iframe.src).search),
    ).toBe('/c/c/proto?frame=landing')
    await clickButton(SIDE, 'Close browser')
    await page.waitForSelector(SIDE, { hidden: true })
    await clickButton(BAR, 'Present browser')
    await page.waitForSelector('[data-proto-screen="landing"]')
  }, 25_000)

  it('drags from the pill grip and commits a normal canvas move', async () => {
    await seed()
    await page.hover(SURFACE)
    const gripSelector = `${BAR} [aria-label="Drag browser frame"]`
    // The initial camera fit can leave the pill mounted but hidden.
    await page.waitForSelector(gripSelector, { visible: true })
    const grip = await centerOf(gripSelector)
    await page.mouse.move(grip.x, grip.y)
    await page.mouse.down()
    await page.mouse.move(grip.x + 65, grip.y + 22, { steps: 6 })
    await page.mouse.up()
    await expect.poll(() => frames[0]?.x).toBeGreaterThan(150)
    await page.waitForSelector(TOOLS)
    await undo()
    await expect.poll(() => frames[0]?.x).toBe(150)
  })

  it('adds a captured image beside the source and removes it in one undo', async () => {
    await seed()
    await child()
    await page.click(SURFACE)
    await page.locator(`${TOOLS} button[aria-label="Capture"]`).setVisibility('visible').click()
    await page
      .locator('[role="menuitem"]')
      .filter((item) => item.textContent === 'Visible area')
      .click()
    await page.waitForSelector('[data-doop-frame-shell="capture"] [data-frame-resize-handles]')
    expect(uploads).toBe(1)
    const frame = frames.find((entry) => entry.id === 'capture')
    expect(frame).toMatchObject({ x: 970, y: 120, width: 740, height: 520 })
    expect(frame?.html).toContain(VISUAL ? 'data:image/png;base64,' : '/a/snapshot.png')
    if (VISUAL) {
      // Shift+1 fits both frames. Wait for the chrome to return after the camera move.
      await page.keyboard.down('Shift')
      await page.keyboard.press('Digit1')
      await page.keyboard.up('Shift')
      await page.waitForFunction(() => {
        const capture = document.querySelector('[data-doop-frame-shell="capture"]')
        return (
          capture &&
          capture.getBoundingClientRect().right < innerWidth &&
          !document.querySelector('[data-frame-camera-moving]')
        )
      })
      await screenshot('05-capture')
    }
    await undo()
    await page.waitForSelector('[data-doop-frame-shell="capture"]', { hidden: true })
  }, 25_000)

  it('reuses the toolbar for Browser import and creates an editable frame beside it', async () => {
    await seed([
      {
        ...canvasFrame({ id: 'browser', name: 'Browser', x: 150, y: 120, width: 620, height: 500 }),
        html: '',
        browser: { url: 'https://example.test/' },
      },
    ])
    await page.click('[data-browser-shield]')
    const controls = '[data-canvas-browser-chrome="browser"] .browser-under-bar'
    await page.waitForSelector(controls)
    expect(await page.$(`${controls} button[aria-label="Pick element"]`)).toBeNull()
    await page.locator(`${controls} button::-p-text(Import)`).click()
    await page.waitForSelector('[data-doop-frame-shell="imported"] iframe[data-doop-frame]')
    expect(importBody).toMatchObject({ url: 'https://example.test/', placement: { x: 850, y: 120 } })
  })

  it.runIf(!!VISUAL)('keeps the real Browser reference on port 8747 live', async () => {
    await seed([
      {
        ...canvasFrame({ id: 'browser', name: 'Browser', x: 150, y: 120, width: 740, height: 520 }),
        html: '',
        browser: { url: 'http://127.0.0.1:8747/' },
      },
    ])
    const iframe = await page.waitForSelector('iframe[title="Browser"]')
    const live = await iframe!.contentFrame()
    if (!live) throw new Error('Browser document did not mount')
    await live.waitForFunction(() => /Akimov|Акимов/i.test(document.title))
    await page.waitForSelector('.browser-progress', { hidden: true })
    await screenshot('06-browser')
  })
})
