import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import sharp from 'sharp'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest, serveBuilt, type BuiltServer } from './browser'
import { freePort, startServer, type Server } from './harness'

describe.skipIf(!findBrowserPath())('page list controls and keyboard history', () => {
  let web: BuiltServer
  let server: Server
  const pages = pagePerTest()
  let page: Page
  let origin: string
  /* every test signs up as someone new, so each works on a canvas of its own */
  let accounts = 0
  beforeAll(async () => {
    /* the web server needs the backend's port for its proxy and the backend needs its
       origin as BETTER_AUTH_URL, so the port is picked before either starts */
    const port = await freePort()
    web = await serveBuilt({
      '/api': { target: `http://localhost:${port}` },
      '/i': { target: `http://localhost:${port}` },
      '/ws': { target: `ws://localhost:${port}`, ws: true },
    })
    origin = web.origin
    server = await startServer({ PORT: String(port), BETTER_AUTH_URL: origin })
  }, 180_000)
  beforeEach(async () => {
    page = await pages.open()
    page.setDefaultTimeout(10_000)
    await page.setViewport({ width: 1400, height: 900 })
    await page.goto(origin)
    const canvasId = await page.evaluate(async (email) => {
      const signup = await fetch('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Pages Tester', email, password: 'password12345' }),
      })
      if (!signup.ok) throw new Error(await signup.text())
      const canvas = await (
        await fetch('/api/canvases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Page interactions' }),
        })
      ).json()
      return canvas.id
    }, `page-controls-${++accounts}@test.dev`)
    await page.goto(`${origin}/c/${canvasId}`)
    /* the Layers heading paints before the canvas's pages arrive; the first
       assertion counts page rows, so wait for the list itself */
    await page.waitForSelector('[data-slot="frame-section-heading"]')
    await page.waitForSelector('[data-page-id]')
  }, 60_000)
  afterAll(async () => {
    await web?.close()
    server?.stop()
  })

  async function shortcut(redo = false) {
    // The WebSocket can paint the result before the HTTP response releases
    // history's busy guard. Wait for this shortcut's own request to finish
    // before sending the next one, including when an earlier save is in flight.
    const completed = page
      .waitForRequest(
        (request) =>
          ['PUT', 'PATCH', 'POST', 'DELETE'].includes(request.method()) &&
          /^\/api\/(canvases|frames)\//.test(new URL(request.url()).pathname),
      )
      .then(async (request) => {
        const response =
          request.response() ?? (await page.waitForResponse((response) => response.request() === request))
        await response.text()
        expect(response.ok()).toBe(true)
      })
    await page.keyboard.down('Meta')
    if (redo) await page.keyboard.down('Shift')
    await page.keyboard.press('z')
    if (redo) await page.keyboard.up('Shift')
    await page.keyboard.up('Meta')
    await completed
    await page.evaluate(() => new Promise(requestAnimationFrame))
  }

  it('keeps the dark canvas colour at low zoom and restores the chrome with Escape', async () => {
    await page.evaluate(() => localStorage.setItem('doop-theme', 'dark'))
    await page.reload()
    await page.waitForSelector('[data-page-id]')
    await page.evaluate(async () => {
      const stage = document.querySelector('.stage')!
      for (let i = 0; i < 15; i++) {
        stage.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: 40,
            ctrlKey: true,
            clientX: 700,
            clientY: 190,
            bubbles: true,
            cancelable: true,
          }),
        )
        await new Promise(requestAnimationFrame)
      }
    })
    await page.waitForFunction(() => {
      const world = document.querySelector<HTMLElement>('.stage .world')
      return Number(world?.style.getPropertyValue('--zoom')) === 0.01
    })
    const paper = await page.screenshot({ clip: { x: 650, y: 150, width: 80, height: 80 } })
    const colours = (await sharp(paper).stats()).channels.slice(0, 3)
    for (const { mean } of colours) {
      expect(mean).toBeGreaterThanOrEqual(19)
      expect(mean).toBeLessThan(23)
    }
    expect(await page.$('[data-dot-grid][hidden]')).not.toBeNull()
    await page.keyboard.down('Meta')
    await page.keyboard.press('.')
    await page.keyboard.up('Meta')
    await page.waitForSelector('button[aria-label="Show interface"]', { visible: true })
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-page-id]', { visible: true })
    expect(await page.$('button[aria-label="Show interface"]')).toBeNull()
  })

  it('restores pan and zoom after switching to another canvas and back', async () => {
    const first = new URL(page.url()).pathname
    const firstPage = await page.$eval('[data-page-id]', (row) => row.getAttribute('data-page-id'))
    const second = await page.evaluate(async () => {
      const response = await fetch('/api/canvases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Another canvas' }),
      })
      if (!response.ok) throw new Error(await response.text())
      const canvas = await response.json()
      return { path: '/c/' + canvas.id, pageId: canvas.pages?.[0]?.id ?? canvas.id + ':page1' }
    })
    const stage = '.stage'
    const camera = () => page.$eval(stage, (element) => element.querySelector<HTMLElement>('.world')!.style.transform)
    const initial = await camera()
    await page.$eval(stage, (element) => {
      element.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 70, ctrlKey: true, clientX: 700, clientY: 300, cancelable: true }),
      )
    })
    await page.waitForFunction(
      (previous) => document.querySelector<HTMLElement>('.stage .world')?.style.transform !== previous,
      {},
      initial,
    )
    const moved = await camera()
    const switchCanvas = (path: string) =>
      page.evaluate((target) => {
        history.pushState(null, '', target)
        window.dispatchEvent(new PopStateEvent('popstate'))
      }, path)
    const waitForPage = (id: string | null) =>
      page.waitForFunction(
        (expected) => document.querySelector('[data-page-id]')?.getAttribute('data-page-id') === expected,
        {},
        id,
      )
    await switchCanvas(second.path)
    await waitForPage(second.pageId)
    expect(await camera()).toBe(initial)
    await switchCanvas(first)
    await waitForPage(firstPage)
    expect(await camera()).toBe(moved)
  }, 20_000)

  it('keeps Present dark until its first live frame is ready', async () => {
    await page.evaluate(async () => {
      const response = await fetch('/api/canvases/' + location.pathname.split('/').at(-1) + '/frames', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Present loading fixture',
          x: 100,
          y: 100,
          width: 800,
          height: 500,
          html: '<style>body{background:#175c42}</style><p>Live presentation</p>',
        }),
      })
      if (!response.ok) throw new Error(await response.text())
    })
    await page.evaluate(() => localStorage.setItem('doop:proto-scaling', 'actual'))
    await page.reload()
    await page.waitForSelector('button[aria-label="Present prototype"]:enabled')
    await page.evaluate(() => {
      function hold(event: MessageEvent) {
        const target = document.querySelector<HTMLIFrameElement>('[data-prototype-player] iframe')
        if (!target || event.source !== target.contentWindow || event.data?.type !== 'doop:frame-ready') return
        event.stopImmediatePropagation()
        window.removeEventListener('message', hold, true)
        document.documentElement.dataset.presentReplyHeld = 'true'
        window.addEventListener(
          'release-present-reply',
          () => window.dispatchEvent(new MessageEvent('message', { source: event.source, data: event.data })),
          {
            once: true,
          },
        )
      }
      window.addEventListener('message', hold, true)
    })
    await page.click('button[aria-label="Present prototype"]')
    const iframe = await page.waitForSelector('[data-prototype-player] iframe')
    await page.waitForSelector('html[data-present-reply-held="true"]')
    const rect = (await iframe!.boundingBox())!
    const capture = (x: number, y: number) => page.screenshot({ clip: { x, y, width: 4, height: 4 } })
    const left = await capture(4, rect.y + rect.height / 2)
    const center = () => capture(rect.x + rect.width / 2, rect.y + rect.height / 2)
    expect(
      await sharp(await center())
        .raw()
        .toBuffer(),
    ).toEqual(await sharp(left).raw().toBuffer())
    await page.evaluate(() => window.dispatchEvent(new Event('release-present-reply')))
    await page.waitForSelector('[data-prototype-player] iframe', { visible: true })
    const live = await iframe!.contentFrame()
    await live!.waitForFunction(() => document.body.textContent?.includes('Live presentation'))
    expect([
      ...(
        await sharp(await center())
          .removeAlpha()
          .raw()
          .toBuffer()
      ).subarray(0, 3),
    ]).toEqual([23, 92, 66])
  }, 20_000)

  it('draws, styles and moves a section with its frame and opens its link', async () => {
    await page.evaluate(async () => {
      const response = await fetch('/api/canvases/' + location.pathname.split('/').at(-1) + '/frames', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Inside', x: 480, y: 240, width: 140, height: 110, html: '<p>Content</p>' }),
      })
      if (!response.ok) throw new Error(await response.text())
    })
    const frame = await page.waitForSelector('[data-doop-frame-shell]')
    const box = (await frame!.boundingBox())!
    const initialX = await frame!.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left))
    await page.keyboard.down('Shift')
    await page.keyboard.press('s')
    await page.keyboard.up('Shift')
    await page.waitForSelector('button[aria-label="Section"][aria-pressed="true"]')
    await page.mouse.move(box.x - 12, box.y - 12)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width + 12, box.y + box.height + 12, { steps: 4 })
    await page.mouse.up()
    const sectionToggle = 'button[data-slot="collapsible-trigger"][aria-expanded="false"]'
    await page.locator('::-p-aria(Sections)').click()
    const sectionUI = await page.$eval('button[data-slot="collapsible-trigger"][aria-expanded="true"]', (button) => {
      const layerHeading = document.querySelector('[data-slot="frame-section-heading"]')!
      return !!(button.compareDocumentPosition(layerHeading) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(sectionUI).toBe(true)
    await page.locator('::-p-aria(Sections)').click()
    await page.waitForSelector(sectionToggle)
    const title = await page.waitForSelector('[data-canvas-section] button')
    expect(await title?.evaluate((element) => element.textContent?.trim())).toBe('Section 1')
    const sectionSelector = '[data-canvas-section]'
    const inspector = '[data-section-inspector]'
    expect(await page.$eval(sectionSelector, (node) => getComputedStyle(node).backgroundColor)).toMatch(/^rgb\(/)
    await page.waitForSelector(inspector)
    await page.locator(inspector + ' input[aria-label="Fill color"]').fill('#406080')
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('[data-canvas-section]')!).backgroundColor === 'rgb(64, 96, 128)',
    )
    await page.locator(inspector + ' input[aria-label="Fill opacity"]').fill('80')
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('[data-canvas-section]')!).backgroundColor === 'rgba(64, 96, 128, 0.8)',
    )
    expect(
      await page.$$eval('[data-canvas-section] button[aria-label^="Resize section"]', (items) => items.length),
    ).toBe(4)
    await page.click(inspector + ' button[role="switch"]')
    await page.waitForSelector(inspector + ' button[role="switch"][aria-checked="true"]')
    const width = await page.$eval(
      inspector + ' input[aria-label="Width"]',
      (el) => (el as HTMLInputElement).valueAsNumber,
    )
    const height = await page.$eval(
      inspector + ' input[aria-label="Height"]',
      (el) => (el as HTMLInputElement).valueAsNumber,
    )
    await page.locator(inspector + ' input[aria-label="Width"]').fill(String(width + 30))
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      (height) => {
        const next = document.querySelector<HTMLInputElement>('[data-section-inspector] input[aria-label="Height"]')
        return !!next && next.valueAsNumber > height
      },
      {},
      height,
    )
    const resizedHeight = await page.$eval(
      inspector + ' input[aria-label="Height"]',
      (el) => (el as HTMLInputElement).valueAsNumber,
    )
    expect(resizedHeight).toBeCloseTo(((width + 30) * height) / width)
    const beforeFit = await page.$eval('.world', (el) => (el as HTMLElement).style.transform)
    await page.locator('::-p-aria(Zoom to section)').click()
    await page.waitForFunction(
      (before) => document.querySelector<HTMLElement>('.world')?.style.transform !== before,
      {},
      beforeFit,
    )
    const handle = (await title!.boundingBox())!
    await page.mouse.move(handle.x + 10, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + 90, handle.y + handle.height / 2, { steps: 4 })
    await page.mouse.up()
    await page.waitForFunction(
      (before) => {
        const shell = document.querySelector<HTMLElement>('[data-doop-frame-shell]')
        return shell && Number.parseFloat(shell.style.left) > before
      },
      {},
      initialX,
    )
    const movedX = await page.$eval('[data-doop-frame-shell]', (node) => (node as HTMLElement).style.left)
    await page.reload()
    await page.waitForSelector('[data-canvas-section]')
    expect(await page.$eval('[data-doop-frame-shell]', (node) => (node as HTMLElement).style.left)).toBe(movedX)
    expect(await page.$eval(sectionSelector, (node) => getComputedStyle(node).backgroundColor)).toBe(
      'rgba(64, 96, 128, 0.8)',
    )
    const sectionId = await page.$eval(sectionSelector, (node) => node.getAttribute('data-canvas-section'))
    const pageId = await page.$eval('[data-page-id]', (node) => node.getAttribute('data-page-id'))
    await page.goto(`${page.url()}?page=${encodeURIComponent(pageId!)}&section=${sectionId}`)
    await page.waitForSelector('[data-section-inspector]')
    const name = await page.$eval(
      '[data-section-inspector] input[aria-label="Section name"]',
      (el) => (el as HTMLInputElement).value,
    )
    expect(name).toBe('Section 1')
  }, 20_000)

  it('renders tall live HTML and plays visible animations on a large page before selection', async () => {
    const tallId = await page.evaluate(async () => {
      const id = location.pathname.split('/').at(-1)
      let tallId = ''
      for (let i = 0; i < 17; i++) {
        const response = await fetch('/api/canvases/' + id + '/frames', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Overview ' + i,
            x: (i % 4) * 1000,
            y: Math.floor(i / 4) * 600,
            width: 800,
            height: i === 0 ? 2200 : 350,
            html:
              i === 0
                ? `<!doctype html><html><style>body{margin:0;background:#112233}
                  #footer{position:absolute;left:0;right:0;bottom:0;height:200px;background:#228844}
                  #interactive{position:absolute;width:240px;height:100px;left:280px;top:300px}
                  @keyframes move{to{transform:translateX(50px)}} #motion{animation:move 1s infinite alternate}
                  </style><body><button id="interactive" onclick="this.textContent='Clicked'">Interactive</button>
                  <div id="motion">Animated</div><div id="footer">Bottom content</div>
                  <script>document.body.dataset.started = 'yes'</script></body></html>`
                : '<style>@keyframes fade{to{opacity:.25}}p{animation:fade 1s infinite alternate}</style><p>Frame</p>',
          }),
        })
        if (!response.ok) throw new Error(await response.text())
        if (i === 0) tallId = (await response.json()).id as string
      }
      return tallId
    })
    await page.reload()
    const shell = `[data-doop-frame-shell="${tallId}"]`
    const iframe = await page.waitForSelector(shell + ' iframe[data-doop-frame]')
    const content = (await iframe!.contentFrame())!
    await content.waitForSelector('body[data-started="yes"] #footer')
    expect(await content.$eval('#footer', (element) => element.getBoundingClientRect().bottom)).toBe(2200)
    const animationTime = () => content.$eval('#motion', (element) => Number(element.getAnimations()[0]?.currentTime))
    const first = await animationTime()
    await content.waitForFunction(
      (time) => Number(document.getElementById('motion')?.getAnimations()[0]?.currentTime) > time,
      {},
      first,
    )
    const sibling = await page.waitForSelector('iframe[title^="Overview "]:not([title="Overview 0"])')
    const neighbor = (await sibling!.contentFrame())!
    await neighbor.waitForFunction(() => (document.querySelector('p')?.getAnimations().length ?? 0) > 0)
    await page.setViewport({ width: 1400, height: 560 })
    const tree = '[role="tree"]'
    await page.waitForFunction(
      (selector) => {
        const rail = document.querySelector(selector)!
        return rail.scrollHeight > rail.clientHeight
      },
      {},
      tree,
    )
    await page.keyboard.down('Meta')
    await page.keyboard.press('a')
    await page.keyboard.up('Meta')
    await page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length === 17,
      {},
      `${tree} [aria-selected="true"]`,
    )
    expect(await page.$eval(tree, (rail) => rail.scrollTop)).toBe(0)
    await page.keyboard.press('Escape')
    await page.setViewport({ width: 1400, height: 900 })
    await page.click(shell + ' [data-frame-title]')
    await page.click('button[aria-label="Present prototype"]')
    await page.waitForSelector('[data-prototype-player] iframe')
  }, 60_000)

  it('copies another page’s link without leaving the current page', async () => {
    await page.browserContext().overridePermissions(origin, ['clipboard-read', 'clipboard-sanitized-write'])
    const canvasPath = new URL(page.url()).pathname
    await page.click('button[aria-label="Add page"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-page-id]').length === 2)
    await page.waitForSelector('button[aria-label="Add page"]:enabled')
    const source = '[data-page-id]:first-child button'
    const target = '[data-page-id]:last-child button'
    await page.click(source)
    const currentUrl = page.url()
    await page.click(target, { button: 'right' })
    expect(await page.$eval(source, (el) => el.getAttribute('aria-current'))).toBe('page')
    expect(page.url()).toBe(currentUrl)
    await page.locator('::-p-aria(Copy link to page)').setTimeout(3000).click()
    await page.waitForSelector('::-p-text(Page link copied)')
    expect(await page.$eval(source, (el) => el.getAttribute('aria-current'))).toBe('page')
    expect(page.url()).toBe(currentUrl)

    const id = await page.$eval(target, (el) => el.closest('[data-page-id]')!.getAttribute('data-page-id'))
    const link = new URL(await page.evaluate(() => navigator.clipboard.readText()))
    expect(link.origin).toBe(origin)
    expect(link.pathname).toBe(canvasPath)
    expect([...link.searchParams]).toEqual([['page', id]])
    await page.goto(link.href)
    await page.waitForSelector('[data-page-id]:last-child [aria-current="page"]')
  }, 20_000)

  it('drags pages, double-clicks to rename, and restores a deleted page and frame with Cmd+Z', async () => {
    // Exercise the ordering that made this test race on CI: broadcasts land first.
    await page.emulateNetworkConditions({ offline: false, download: -1, upload: -1, latency: 150 })
    const framePlus = await page.$eval('button[aria-label="New frame"] svg', (el) => el.outerHTML)
    const typography = (element: Element) => {
      const style = getComputedStyle(element)
      return [style.fontFamily, style.fontSize, style.fontWeight, style.letterSpacing, style.textTransform]
    }
    const frameTypography = await page.$eval('[data-slot="frame-section-heading"]', typography)
    /* pages sit above the frames, Figma-style, with the search underneath both */
    expect(await page.$$('[data-page-id]')).toHaveLength(1)
    await page.waitForSelector('button[aria-label="Add page"]')
    expect(await page.$('input[placeholder="Search layers"]')).not.toBeNull()
    expect(await page.$('[data-slot="frame-section-heading"]')).not.toBeNull()
    expect(await page.$eval('button[aria-label="Add page"] svg', (el) => el.outerHTML)).toBe(framePlus)
    expect(await page.$eval('[data-slot="page-section-heading"]', typography)).toEqual(frameTypography)
    await page.click('button[aria-label="Add page"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-page-id]').length === 2)
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>('button[aria-label="Add page"]')!.disabled,
    )
    expect(await page.$$('[aria-label^="Rename "]')).toHaveLength(0)
    expect(await page.$$('[aria-label^="Move Page"]')).toHaveLength(0)
    expect(await page.$$('button[aria-label^="Delete "]')).toHaveLength(0)
    const rows = await page.$$('[data-page-id]')
    const first = await rows[0]!.boundingBox()
    const second = await rows[1]!.boundingBox()
    await page.mouse.move(second!.x + 50, second!.y + second!.height / 2)
    await page.mouse.down()
    await page.mouse.move(first!.x + 50, first!.y + 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(() => document.querySelector('[data-page-id]')?.textContent?.includes('Page 2'))
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>('button[aria-label="Add page"]')!.disabled,
    )
    await page.click('[data-page-id] > button:first-of-type', { count: 2 })
    await page.waitForSelector('input[aria-label="Page name"]')
    /* the row being renamed is the active one (a grey fill); the input reads
       as ink on its own white surface, not as text on the row's fill */
    expect(
      await page.$eval('input[aria-label="Page name"]', (input) => [
        getComputedStyle(input).color === getComputedStyle(document.body).color,
        getComputedStyle(input).backgroundColor !== getComputedStyle(input.closest('[data-page-id]')!).backgroundColor,
      ]),
    ).toEqual([true, true])
    await page.type('input[aria-label="Page name"]', 'Ideas')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('[data-page-id]')?.textContent?.includes('Ideas'))
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>('button[aria-label="Add page"]')!.disabled,
    )
    const selectedColor = await page.$eval(
      '[data-page-id] button[aria-current="page"]',
      (button) => getComputedStyle(button.parentElement!).backgroundColor,
    )
    await page.click('button[aria-label="New frame"]')
    await page.waitForSelector('iframe[data-doop-frame]')
    await page.waitForSelector('[role="treeitem"][aria-selected="true"]')
    expect(selectedColor).toBe(
      await page.$eval('[role="treeitem"][aria-selected="true"]', (row) => getComputedStyle(row).backgroundColor),
    )
    await page.keyboard.press('Delete')
    await page.waitForFunction(() => document.querySelectorAll('iframe[data-doop-frame]').length === 0)
    await page.screenshot({ path: '/tmp/doop-pages-controls.png' })
    await page.click('[data-page-id] button[aria-current="page"]', { button: 'right' })
    await page.waitForSelector('[role="menuitem"]')
    await page.click('[role="menuitem"]:last-child')
    await page.waitForFunction(() => document.querySelectorAll('[data-page-id]').length === 1)
    await shortcut()
    await page.waitForFunction(() => document.querySelector('[data-page-id]')?.textContent?.includes('Ideas'))
    expect(await page.$eval('[data-page-id]', (row) => row.textContent)).toContain('Ideas')
    expect(await page.$('iframe[data-doop-frame]')).toBeNull()
    await shortcut()
    await page.waitForSelector('iframe[data-doop-frame]')
    expect(await page.$eval('[aria-current="page"]', (button) => button.textContent)).toBe('Ideas')
    await shortcut(true)
    await page.waitForFunction(() => document.querySelectorAll('iframe[data-doop-frame]').length === 0)
    await shortcut(true)
    await page.waitForFunction(() => document.querySelectorAll('[data-page-id]').length === 1)
    await page.click('[data-page-id] button[aria-current="page"]', { button: 'right' })
    await page.waitForSelector('[role="menuitem"]')
    expect(await page.$eval('[role="menuitem"]:last-child', (item) => item.getAttribute('aria-disabled'))).toBe('true')
    await page.click('[role="menuitem"]:first-child')
    await page.waitForSelector('input[aria-label="Page name"]')
    await page.type('input[aria-label="Page name"]', 'Main')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('[data-page-id]')?.textContent?.includes('Main'))
  }, 20_000)

  it('moves a selected frame through the page picker and undoes the move', async () => {
    /* the page names are the server's to choose, so the destination's is read
       rather than assumed */
    const pageCount = (await page.$$('[data-page-id]')).length
    await page.click('button[aria-label="Add page"]')
    await page.waitForFunction((n) => document.querySelectorAll('[data-page-id]').length === n + 1, {}, pageCount)
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>('button[aria-label="Add page"]')!.disabled,
    )
    const source = await page.$eval(
      '[aria-current="page"]',
      (button) => button.closest<HTMLElement>('[data-page-id]')!.dataset.pageId!,
    )
    const destination = await page.$eval(
      '[data-page-id] > button:first-of-type:not([aria-current="page"])',
      (button) => button.textContent!,
    )
    await page.click('button[aria-label="New frame"]')
    await page.waitForSelector('iframe[data-doop-frame]')
    /* the room's broadcast can paint the frame before the create response
       selects it, and the picker only shows for a selection */
    await page.waitForSelector('[aria-label="Move selection to page"]:not([disabled])')
    await page.click('[aria-label="Move selection to page"]')
    await page.waitForSelector('[role="option"]')
    expect(await page.$$('[role="option"]')).toHaveLength(1)
    expect(await page.$eval('[role="option"]', (option) => option.textContent)).toBe(destination)
    /* keys in the open list stay with it: ⌫ must not delete the frame being
       moved, nor a letter switch the canvas tool */
    await page.keyboard.press('Backspace')
    await page.keyboard.press('r')
    expect(await page.$$('iframe[data-doop-frame]')).toHaveLength(1)
    expect(await page.$eval('button[aria-label="Rectangle"]', (b) => b.getAttribute('aria-pressed'))).toBe('false')
    expect(await page.$('[role="option"]')).not.toBeNull()
    await page.screenshot({ path: '/tmp/doop-page-move.png' })
    await page.click('[role="option"]')
    await page.waitForFunction(
      (name) => document.querySelector('[aria-current="page"]')?.textContent === name,
      {},
      destination,
    )
    await page.waitForSelector('iframe[data-doop-frame]')
    await shortcut()
    await page.waitForFunction(
      (id) => document.querySelector(`[data-page-id="${id}"] [aria-current="page"]`),
      {},
      source,
    )
    await page.waitForSelector('iframe[data-doop-frame]')
    await shortcut(true)
    await page.waitForFunction(
      (name) => document.querySelector('[aria-current="page"]')?.textContent === name,
      {},
      destination,
    )
    await page.waitForSelector('iframe[data-doop-frame]')
  }, 20_000)

  it('claims Backspace on the canvas: deletes the selection, never leaves the page', async () => {
    await page.keyboard.press('Escape')
    const before = (await page.$$('iframe[data-doop-frame]')).length
    const url = page.url()
    await page.evaluate(() => {
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') (window as unknown as { prevented: boolean[] }).prevented.push(e.defaultPrevented)
      })
      ;(window as unknown as { prevented: boolean[] }).prevented = []
    })
    /* nothing selected: the key does nothing, and the browser never sees an
       unhandled Backspace (some engines take one as "back") */
    await page.keyboard.press('Backspace')
    expect(await page.$$('iframe[data-doop-frame]')).toHaveLength(before)
    expect(page.url()).toBe(url)
    expect(await page.evaluate(() => (window as unknown as { prevented: boolean[] }).prevented)).toEqual([true])
    /* a selected frame goes */
    await page.click('button[aria-label="New frame"]')
    /* the room's broadcast can paint the frame before the create response
       selects it; a canvas with one page has no page picker to wait on */
    await page.waitForSelector('[role="treeitem"][aria-selected="true"]')
    expect(await page.$$('iframe[data-doop-frame]')).toHaveLength(before + 1)
    const deleted = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' && /^\/api\/frames\//.test(new URL(response.url()).pathname),
    )
    await page.keyboard.press('Backspace')
    expect((await deleted).ok()).toBe(true)
    await page.waitForFunction((n) => document.querySelectorAll('iframe[data-doop-frame]').length === n, {}, before)
    expect(page.url()).toBe(url)
    expect(await page.evaluate(() => (window as unknown as { prevented: boolean[] }).prevented)).toEqual([true, true])
  }, 20_000)
})
