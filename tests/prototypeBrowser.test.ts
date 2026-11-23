import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Frame as PuppeteerFrame, KeyInput, Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import type { Canvas, Frame } from '../shared/types'

type Message = { type?: string; interaction?: { action?: string; target?: string } }
/* what tests/fixtures/prototype.html puts on window */
type Fixture = {
  messages: Message[]
  fixtureReady: boolean
  playerClosed: boolean
  seed: (canvas: Canvas) => void
  play: (frameId: string) => void
  playWithShell: (frameId: string) => void
  playSynced: (frameId: string) => void
  editFrame: (id: string, html: string) => void
  addRawFrame: () => void
  mountStage: (prototypeMode: boolean) => void
}

const doc = (body: string) =>
  `<!doctype html><html><head><style>*{margin:0}button{display:block;width:160px;height:60px}</style></head><body>${body}</body></html>`

const frame = (id: string, body: string, x = 0): Frame => ({
  id,
  canvasId: 'c',
  pageId: 'p',
  name: id.toUpperCase(),
  x,
  y: 0,
  width: 400,
  height: 300,
  html: doc(body),
  createdAt: 0,
  updatedAt: 1,
  updatedBy: 'Test',
})

const CANVAS: Canvas = {
  id: 'c',
  name: 'Prototype',
  pages: [{ id: 'p', name: 'Flow' }],
  frames: [
    frame(
      'home',
      `<button id="go" data-doop-on="click" data-doop-action="navigate:detail" data-doop-transition="push-left" data-doop-duration="120">Open</button>
       <button id="help" data-doop-on="click" data-doop-action="overlay:menu">Help</button>
       <p id="blank" style="height:100px">Nothing here</p>`,
    ),
    frame('detail', `<button id="back" data-doop-on="click" data-doop-action="back">Back</button>`, 500),
    frame('menu', `<button id="close" data-doop-on="click" data-doop-action="close-overlay">Close</button>`, 1000),
  ],
  createdAt: 0,
  updatedAt: 0,
}

/* the review-fix regressions: repeated screens in the browser history, press
   releases, press scrolls, overlay-first Escape and live delay edits */
const FLOW: Canvas = {
  ...CANVAS,
  frames: [
    frame(
      'home',
      `<button id="go" data-doop-on="click" data-doop-action="navigate:detail">Open</button>
       <button id="hold" data-doop-on="press" data-doop-action="navigate:detail" data-doop-transition="dissolve" data-doop-duration="3000">Hold</button>
       <button id="help" data-doop-on="click" data-doop-action="overlay:menu">Help</button>
 <button id="peek" data-doop-on="press" data-doop-action="overlay:menu">Peek</button>
       <button id="jump" data-doop-on="press" data-doop-action="scroll-to:#end" data-doop-transition="instant">Jump</button>
       <div style="height:2000px"></div><p id="end">End</p>`,
    ),
    frame(
      'detail',
      `<button id="again" data-doop-on="click" data-doop-action="navigate:home">Home again</button>`,
      500,
    ),
    frame(
      'menu',
      `<button id="close" data-doop-on="click" data-doop-action="close-overlay">Close</button>
       <div data-doop-on="key:Escape" data-doop-action="navigate:detail"></div>
       <div data-doop-on="key:Enter" data-doop-action="navigate:gone"></div>`,
      1000,
    ),
  ],
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/* The first load transforms the app through a cold Vite dev server, which can
   take longer than the default test timeout on CI. */
describe.skipIf(!findBrowserPath())('prototype player', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page

  beforeEach(async () => {
    page = await pages.open()
    await page.setViewport({ width: 1000, height: 700 })
    await page.goto(fixtureUrl('prototype.html'))
    await page.waitForFunction(() => (window as unknown as Fixture).fixtureReady)
  })

  async function screen(frameId: string): Promise<PuppeteerFrame> {
    /* the iframe is in the page before its document is: wait for a live one */
    for (let attempt = 0; attempt < 40; attempt++) {
      const handle = await page.waitForSelector(`iframe[data-doop-proto-frame="${frameId}"]`)
      const content = await handle?.contentFrame()
      if (content && !content.detached && (await content.$('button').catch(() => null))) return content
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`screen ${frameId} never rendered`)
  }

  async function current() {
    return page.$eval('[data-proto-current]', (el) => el.textContent)
  }

  /* a trigger is live once the player has switched the frame's runtime on,
     a moment after the HTML lands — retry the click until it takes. The
     click is dispatched in the frame: the player scales its iframes, which
     puppeteer's point clicks do not map through */
  async function clickUntil(frame: PuppeteerFrame, selector: string, done: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 20; attempt++) {
      await frame.$eval(selector, (el) => (el as HTMLElement).click())
      for (let wait = 0; wait < 5; wait++) {
        if (await done()) return
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    throw new Error(`clicking ${selector} never took effect`)
  }

  const control = (label: string) => `[data-preview-toolbar] button[aria-label="${label}"]`
  const addressField = '[role="combobox"][aria-label="Preview address"]'
  const pressCommand = async (key: KeyInput) => {
    await page.keyboard.down('Meta')
    try {
      await page.keyboard.press(key)
    } finally {
      await page.keyboard.up('Meta')
    }
  }
  const waitForCurrent = (name: string) =>
    page.waitForFunction((name) => document.querySelector('[data-proto-current]')?.textContent === name, {}, name)

  it('keeps all the controls above the site and resizes the site in windowed mode', async () => {
    await page.evaluate((canvas) => {
      document.documentElement.style.setProperty('--app-inset', '38px')
      ;(window as unknown as Fixture).seed(canvas)
      ;(window as unknown as Fixture).play('home')
    }, CANVAS)
    await screen('home')
    const geometry = () =>
      page.$eval('[data-prototype-player]', (player) => {
        const bar = player.querySelector('[data-preview-toolbar]')!
        const area = player.querySelector('[data-proto-viewport]')!.getBoundingClientRect()
        return {
          barTop: bar.getBoundingClientRect().top,
          barBottom: bar.getBoundingClientRect().bottom,
          screenTop: player.querySelector('[data-proto-screen]')!.getBoundingClientRect().top,
          width: area.width,
          height: area.height,
          buttons: [...bar.querySelectorAll('button')].map((button) => [
            button.getAttribute('aria-label'),
            button.title,
          ]),
        }
      })
    const full = await geometry()
    expect(full.barTop).toBe(38)
    expect(full.screenTop).toBe(full.barBottom)
    expect(full.buttons).toEqual([
      ['Back', 'Back'],
      ['Forward', 'Forward'],
      ['Reload screen', 'Reload screen'],
      ['Restart prototype', 'Restart prototype'],
      ['Annotate', 'Annotate (⌘⇧D)'],
      ['Scaling', 'Scaling'],
      ['Open prototype in a new tab', 'Open prototype in a new tab'],
      ['Minimize preview', 'Minimize preview'],
      ['Exit prototype', 'Exit (Esc)'],
    ])

    await page.click(control('Minimize preview'))
    await page.waitForFunction(() => document.querySelector('[data-proto-viewport]')!.clientWidth < 810)
    const small = await geometry()
    expect(small.screenTop).toBe(small.barBottom)
    expect(small.width).toBeLessThan(full.width)
    expect(small.height).toBeLessThan(full.height)
    await page.mouse.click(10, 48)
    expect(await page.$('[data-prototype-player][data-minimized]')).not.toBeNull()

    await page.click(control('Expand preview'))
    await page.waitForFunction(
      (width, height) => {
        const viewport = document.querySelector('[data-proto-viewport]')
        return viewport?.clientWidth === width && viewport.clientHeight === height
      },
      {},
      full.width,
      full.height,
    )
    await page.click(control('Exit prototype'))
    await page.waitForFunction(() => (window as unknown as Fixture).playerClosed)
  })

  it('searches the current page, accepts preview links, walks local history and remounts on Reload', async () => {
    const canvas = {
      ...CANVAS,
      pages: [...CANVAS.pages!, { id: 'other', name: 'Other page' }],
      frames: [...CANVAS.frames, { ...frame('other', '<button>Other</button>'), pageId: 'other' }],
    }
    await page.evaluate((canvas) => {
      ;(window as unknown as Fixture).seed(canvas)
      ;(window as unknown as Fixture).play('home')
    }, canvas)
    await screen('home')
    const disabled = (label: string) => page.$eval(control(label), (el) => (el as HTMLButtonElement).disabled)
    const enter = async (value: string) => {
      await page.click(addressField)
      await page.keyboard.type(value)
      await page.keyboard.press('Enter')
    }
    expect(await disabled('Forward')).toBe(true)

    await page.click(addressField)
    await pressCommand('l')
    expect(await page.$eval(addressField, (el) => (el as HTMLInputElement).selectionEnd)).toBeGreaterThan(0)
    expect(await page.$$eval('[role="option"]', (all) => all.map((option) => option.textContent))).toEqual([
      'HOME',
      'DETAIL',
      'MENU',
    ])
    await page.keyboard.type('tAi')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await waitForCurrent('DETAIL')
    await page.click(control('Back'))
    await waitForCurrent('HOME')
    expect(await disabled('Forward')).toBe(false)
    await page.click(control('Forward'))
    await waitForCurrent('DETAIL')
    expect(await disabled('Forward')).toBe(true)

    const detail = await screen('detail')
    await detail.evaluate(() => document.body.setAttribute('data-reload-check', 'old'))
    const oldFrame = await page.$('iframe[data-doop-proto-frame="detail"]')
    await page.click(control('Reload screen'))
    await page.waitForFunction((previous) => !previous?.isConnected, {}, oldFrame)
    expect(await current()).toBe('DETAIL')
    const reloaded = await screen('detail')
    expect(await reloaded.$('[data-reload-check]')).toBeNull()

    await page.click(control('Back'))
    await waitForCurrent('HOME')
    await enter('/c/c/proto?frame=other')
    await waitForCurrent('OTHER')
    expect(await disabled('Forward')).toBe(true)
    await enter('does not exist')
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === 'No screen matches')
    expect(await page.$eval(addressField, (el) => (el as HTMLInputElement).value)).toMatch(
      /\/c\/c\/proto\?frame=other$/,
    )

    await page.click(addressField)
    await page.keyboard.type('draft')
    await page.keyboard.press('Escape')
    expect(await current()).toBe('OTHER')
    expect(await page.$eval(addressField, (el) => (el as HTMLInputElement).value)).toMatch(/\?frame=other$/)
  })

  it('uses player shortcuts while the previewed document has focus', async () => {
    await page.evaluate((canvas) => {
      ;(window as unknown as Fixture).seed(canvas)
      ;(window as unknown as Fixture).play('home')
    }, CANVAS)
    const home = await screen('home')
    await clickUntil(home, '#go', async () => (await current()) === 'DETAIL')
    const detail = await screen('detail')
    await detail.focus('#back')
    await pressCommand('[')
    await waitForCurrent('HOME')
    const back = await screen('home')
    await back.focus('#go')
    await pressCommand(']')
    await waitForCurrent('DETAIL')
    const again = await screen('detail')
    await again.focus('#back')
    const oldFrame = await page.$('iframe[data-doop-proto-frame="detail"]')
    await pressCommand('r')
    await page.waitForFunction((previous) => !previous?.isConnected, {}, oldFrame)
    const reloaded = await screen('detail')
    await reloaded.focus('#back')
    await pressCommand('l')
    await page.waitForSelector('[data-preview-chat-field]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-preview-chat-field]', { hidden: true })
    await page.click(addressField)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await waitForCurrent('HOME')
  })

  it('shares Forward with browser history and hides editor-only controls in standalone mode', async () => {
    await page.evaluate((canvas) => {
      ;(window as unknown as Fixture).seed(canvas)
      ;(window as unknown as Fixture).playSynced('home')
    }, CANVAS)
    expect(await page.$(control('Minimize preview'))).toBeNull()
    expect(await page.$(control('Exit prototype'))).toBeNull()
    expect(await page.$(control('Open prototype in a new tab'))).toBeNull()

    const home = await screen('home')
    await clickUntil(home, '#go', async () => (await current()) === 'DETAIL')
    await page.evaluate(() => history.back())
    await waitForCurrent('HOME')
    await page.click(control('Forward'))
    await waitForCurrent('DETAIL')
    expect(new URL(page.url()).searchParams.get('frame')).toBe('detail')
    await page.click(control('Back'))
    await waitForCurrent('HOME')
    await page.evaluate(() => history.forward())
    await waitForCurrent('DETAIL')
  })

  it.skipIf(!process.env.DOOP_PREVIEW_SHOTS)(
    'captures preview toolbar screenshots',
    async () => {
      const source = 'http://127.0.0.1:8747/'
      const response = await fetch(source)
      if (!response.ok) throw new Error(`Local site returned ${response.status}`)
      const html = (await response.text()).replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}<base href="${source}">`)
      const canvas: Canvas = {
        ...CANVAS,
        name: 'Akimov Digital',
        frames: [
          { ...frame('akimov-home', ''), name: 'Akimov Digital · Главная', width: 1440, height: 900, html },
          { ...frame('akimov-contact', '<button>Contact</button>', 1540), name: 'Akimov Digital · Контакты' },
        ],
      }
      await page.setViewport({ width: 1440, height: 960 })
      await page.evaluate((canvas) => {
        localStorage.setItem('doop:proto-scaling', 'responsive')
        ;(window as unknown as Fixture).seed(canvas)
        ;(window as unknown as Fixture).playWithShell('akimov-home')
        localStorage.removeItem('doop:proto-scaling')
      }, canvas)
      const tab = await page.waitForSelector('[role="tab"][aria-selected="true"]', { visible: true })
      expect(
        await tab?.evaluate((el) => el.closest('[role=tablist]')?.parentElement?.getBoundingClientRect().bottom),
      ).toBe(await page.$eval('[data-preview-toolbar]', (bar) => bar.getBoundingClientRect().top))
      const iframe = await page.waitForSelector('iframe[data-doop-proto-frame="akimov-home"]', { visible: true })
      const content = await iframe?.contentFrame()
      await content?.waitForSelector('body h1', { visible: true })
      await content?.evaluate(() => document.fonts.ready.then(() => undefined))
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 10_000 }).catch(() => {})
      const dir = join(homedir(), 'doop-preview-toolbar')
      await mkdir(dir, { recursive: true })
      const shot = (name: string) => page.screenshot({ path: join(dir, `preview-bar-${name}.png`) as `${string}.png` })

      await shot('full')
      await page.click(addressField)
      await page.keyboard.type('akimov')
      await page.waitForSelector('[role="option"]')
      await page.keyboard.press('ArrowDown')
      await shot('address-search')
      await page.keyboard.press('Escape')
      await page.click(control('Scaling'))
      await page.waitForSelector('[data-proto-menu]', { visible: true })
      await sleep(200)
      await shot('scaling-menu')
      await page.keyboard.press('Escape')
      await page.click(control('Minimize preview'))
      await page.waitForFunction(() => document.querySelector('[data-proto-window]')!.clientWidth <= 1150)
      await sleep(200)
      await page.mouse.move(4, 940)
      await shot('minimized')

      await page.click(control('Expand preview'))
      for (const width of [375, 768]) {
        await page.setViewport({ width, height: 960 })
        await page.waitForFunction(
          (width) => document.querySelector('[data-proto-viewport]')?.clientWidth === width,
          {},
          width,
        )
        await page.mouse.move(4, 940)
        await shot(`full-${width}`)
      }
    },
    60_000,
  )

  it('navigates on click, goes back, and opens and closes an overlay', async () => {
    await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), CANVAS)
    await page.evaluate(() => (window as unknown as Fixture).play('home'))
    const home = await screen('home')
    expect(await current()).toBe('HOME')

    await clickUntil(home, '#go', async () => (await current()) === 'DETAIL')
    const detail = await screen('detail')
    /* the push transition settles and the outgoing screen unmounts */
    await page.waitForFunction(() => !document.querySelector('iframe[data-doop-proto-frame="home"]'))
    expect(await page.$$('iframe[data-doop-proto-frame]')).toHaveLength(1)

    await clickUntil(detail, '#back', async () => (await current()) === 'HOME')
    await page.waitForFunction(() => !document.querySelector('iframe[data-doop-proto-frame="detail"]'))

    const back = await screen('home')
    await clickUntil(back, '#help', async () => !!(await page.$('[data-proto-overlay="menu"]')))
    const menu = await screen('menu')
    await clickUntil(menu, '#close', async () => !(await page.$('[data-proto-overlay="menu"]')))

    /* the scrim closes an overlay too */
    await clickUntil(back, '#help', async () => !!(await page.$('[data-proto-overlay="menu"]')))
    await page.mouse.click(20, 60)
    await page.waitForFunction(() => !document.querySelector('[data-proto-overlay]'))
  })

  it('re-renders a frame edited live and flashes hotspots on a miss', async () => {
    await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), CANVAS)
    await page.evaluate(() => (window as unknown as Fixture).play('home'))
    const home = await screen('home')
    await page.evaluate(() =>
      (window as unknown as Fixture).editFrame(
        'home',
        '<!doctype html><html><head></head><body><button id="go" data-doop-on="click" data-doop-action="navigate:detail">Edited</button><p id="blank" style="height:100px">x</p></body></html>',
      ),
    )
    await home.waitForFunction(() => document.querySelector('#go')?.textContent === 'Edited')
    for (let attempt = 0; attempt < 20; attempt++) {
      await home.$eval('#blank', (el) => (el as HTMLElement).click())
      if (await home.$('[data-v-proto-flash]')) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(await home.$('#go[data-v-proto-flash]')).not.toBeNull()
  })

  it('sits below the app inset and rescales from its scaling menu', async () => {
    await page.evaluate(() => document.documentElement.style.setProperty('--app-inset', '40px'))
    /* the scaling pick is kept in storage, which the file's pages share */
    try {
      await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), CANVAS)
      await page.evaluate(() => (window as unknown as Fixture).play('home'))
      await screen('home')
      expect(await page.$eval('[data-prototype-player]', (el) => el.getBoundingClientRect().top)).toBe(40)
      const width = () => page.$eval('[data-proto-screen="home"] > div', (el) => el.getBoundingClientRect().width)
      /* 1000 × 624 fits the 400 × 300 frame at 2.08× */
      expect(await width()).toBe(832)

      await page.click('[aria-label="Scaling"]')
      await page.waitForSelector('[data-proto-menu]')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => !document.querySelector('[data-proto-menu]'))
      /* the menu's keys stayed with the menu: the player is still up */
      expect(await page.evaluate(() => (window as unknown as Fixture).playerClosed)).toBe(false)
      /* and the keys are the screen's again: a keyboard user is not left nowhere */
      await page.waitForFunction(() => document.activeElement?.matches('iframe[data-doop-proto-frame="home"]'))
      await page.waitForFunction(
        () => document.querySelector('[data-proto-screen="home"] > div')?.getBoundingClientRect().width === 400,
      )

      await page.click('[aria-label="Scaling"]')
      await page.waitForSelector('[data-proto-menu]')
      await page.$$eval('[data-proto-menu] [role="menuitemradio"]', (items) =>
        (items.find((item) => item.textContent === 'Responsive') as HTMLElement | undefined)?.click(),
      )
      await page.waitForFunction(
        () => document.querySelector('[data-proto-screen="home"] > div')?.getBoundingClientRect().width === 1000,
      )
    } finally {
      await page.evaluate(() => localStorage.removeItem('doop:proto-scaling'))
    }
  })

  it('opens the scaling menu from the keyboard without driving the screen', async () => {
    const keyed: Canvas = {
      ...CANVAS,
      frames: CANVAS.frames.map((f) =>
        f.id === 'home'
          ? {
              ...f,
              html: f.html.replace(
                '</body>',
                '<div data-doop-on="key:ArrowDown" data-doop-action="navigate:detail"></div></body>',
              ),
            }
          : f,
      ),
    }
    await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), keyed)
    await page.evaluate(() => (window as unknown as Fixture).play('home'))
    await screen('home')
    await page.focus('[aria-label="Scaling"]')
    await page.keyboard.press('ArrowDown')
    await page.waitForSelector('[data-proto-menu]')
    await sleep(200)
    expect(await current()).toBe('HOME')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-proto-menu]'))
    expect(await page.evaluate(() => (window as unknown as Fixture).playerClosed)).toBe(false)
  })

  it('scrolls an oversized screen to its far corner, and crops it centred under Fill', async () => {
    const big: Canvas = {
      ...CANVAS,
      frames: [{ ...frame('big', '<button>Big</button>'), width: 2000, height: 1400 }],
    }
    /* the player's box, the screen's box, and how far its scroller can go */
    const measure = () =>
      page.$eval('[data-proto-screen="big"]', (scroller) => {
        const player = scroller.closest('[data-proto-viewport]')!.getBoundingClientRect()
        scroller.scrollTo(scroller.scrollWidth, scroller.scrollHeight)
        const box = scroller.firstElementChild!.getBoundingClientRect()
        return {
          scrolled: scroller.scrollLeft > 0 || scroller.scrollTop > 0,
          right: box.right - player.right,
          bottom: box.bottom - player.bottom,
          left: box.left - player.left,
          top: box.top - player.top,
        }
      })
    const playAt = async (scaling: string) => {
      await page.evaluate((s) => localStorage.setItem('doop:proto-scaling', s), scaling)
      await page.evaluate(() => (window as unknown as Fixture).play('big'))
      await screen('big')
      return measure()
    }
    try {
      await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), big)
      /* 2000 × 1400 at 1×: scrolled to the far corner of the site area */
      expect(await playAt('actual')).toMatchObject({ scrolled: true, right: 0, bottom: 0 })
      /* at 0.5×: 1000 × 700 fills the width and scrolls under the 36px bar */
      expect(await playAt('fit-width')).toMatchObject({ scrolled: true, right: 0, bottom: 0, left: 0, top: -36 })
      await page.setViewport({ width: 1000, height: 600 })
      /* 1000 × 700 in 1000 × 564: scrolls down to the bottom edge */
      expect(await playAt('fit-width')).toMatchObject({ scrolled: true, bottom: 0, left: 0 })
      /* 0.5× covers 1000 × 564: 136px cropped, 68 each side, nothing to scroll */
      expect(await playAt('fill')).toEqual({ scrolled: false, right: 0, bottom: 68, left: 0, top: -68 })
    } finally {
      await page.evaluate(() => localStorage.removeItem('doop:proto-scaling'))
    }
  })

  it('closes on Escape when presenting over the editor', async () => {
    await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), CANVAS)
    await page.evaluate(() => (window as unknown as Fixture).play('home'))
    await screen('home')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => (window as unknown as Fixture).playerClosed)
  })

  it('draws connectors and the flow start in Prototype mode only', async () => {
    const pages = [{ id: 'p', name: 'Flow', startFrameId: 'home' }]
    await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), { ...CANVAS, pages })
    await page.evaluate(() => (window as unknown as Fixture).mountStage(false))
    await page.waitForSelector('iframe[data-doop-frame]')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await page.$('[data-prototype-overlay]')).toBeNull()

    await page.evaluate(() => (window as unknown as Fixture).mountStage(true))
    /* home → detail and home → menu; detail's Back and menu's Close are labels */
    await page.waitForFunction(() => document.querySelectorAll('[data-proto-connector]').length === 2)
    expect(await page.$eval('[data-flow-start]', (el) => (el as HTMLElement).dataset.flowStart)).toBe('home')
  })

  it('keeps interactions inert in a frame the editor drives', async () => {
    await page.evaluate(() => (window as unknown as Fixture).addRawFrame())
    const handle = await page.waitForSelector('iframe#raw')
    const raw = (await handle!.contentFrame())!
    await page.waitForFunction(() => (window as unknown as Fixture).messages.some((m) => m.type === 'doop:frame-ready'))
    const html = doc('<button id="go" data-doop-on="click" data-doop-action="navigate:detail">Go</button>')
    await page.evaluate((html) => {
      ;(window as unknown as Fixture).messages = []
      ;(document.querySelector('iframe#raw') as HTMLIFrameElement).contentWindow!.postMessage(
        { type: 'doop:html', html },
        '*',
      )
    }, html)
    await raw.waitForSelector('#go')
    const actions = () =>
      page.evaluate(() => (window as unknown as Fixture).messages.filter((m) => m.type === 'doop:proto-action').length)

    /* canvas mode: the runtime never turned prototype mode on */
    await raw.click('#go')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await actions()).toBe(0)

    /* text-edit mode wins over prototype mode */
    const post = (message: Record<string, unknown>) =>
      page.evaluate(
        (message) =>
          (document.querySelector('iframe#raw') as HTMLIFrameElement).contentWindow!.postMessage(message, '*'),
        message,
      )
    await post({ type: 'doop:proto', on: true })
    await post({ type: 'doop:edit', on: true })
    await raw.click('#go')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await actions()).toBe(0)

    /* the player's mode: the same click navigates */
    await post({ type: 'doop:edit', on: false })
    await raw.click('#go')
    await page.waitForFunction(() =>
      (window as unknown as Fixture).messages.some((m) => m.type === 'doop:proto-action'),
    )
    expect(
      await page.evaluate(
        () => (window as unknown as Fixture).messages.find((m) => m.type === 'doop:proto-action')!.interaction,
      ),
    ).toMatchObject({ action: 'navigate', target: 'detail' })
  })

  describe('review fixes', () => {
    async function start(synced = false) {
      await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), FLOW)
      await page.evaluate(
        (synced) =>
          synced ? (window as unknown as Fixture).playSynced('home') : (window as unknown as Fixture).play('home'),
        synced,
      )
      return screen('home')
    }

    /* a press fires on pointerdown, so retry it until the screen's runtime is on */
    async function pressUntil(frame: PuppeteerFrame, selector: string, done: () => Promise<boolean>) {
      for (let attempt = 0; attempt < 20; attempt++) {
        await frame.$eval(selector, (el) =>
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })),
        )
        for (let wait = 0; wait < 5; wait++) {
          if (await done()) return
          await sleep(50)
        }
      }
      throw new Error(`pressing ${selector} never took effect`)
    }

    it('walks repeated screens back to the start and forward again with the browser history', async () => {
      const home = await start(true)
      expect(await page.$eval('[aria-label="Back"]', (el) => (el as HTMLButtonElement).disabled)).toBe(true)
      await clickUntil(home, '#go', async () => (await current()) === 'DETAIL')
      const detail = await screen('detail')
      await clickUntil(detail, '#again', async () => (await current()) === 'HOME')

      const walk = async (step: 'back' | 'forward', expected: string) => {
        await page.evaluate((step) => (step === 'back' ? history.back() : history.forward()), step)
        await page.waitForFunction(
          (expected) => document.querySelector('[data-proto-current]')?.textContent === expected,
          {},
          expected,
        )
      }
      await walk('back', 'DETAIL')
      await walk('back', 'HOME')
      expect(await page.$eval('[aria-label="Back"]', (el) => (el as HTMLButtonElement).disabled)).toBe(true)
      await walk('forward', 'DETAIL')
      await walk('forward', 'HOME')
      expect(await page.$eval('[aria-label="Back"]', (el) => (el as HTMLButtonElement).disabled)).toBe(false)
    })

    it('reverts a press navigation released on the outgoing screen', async () => {
      const home = await start()
      await pressUntil(home, '#hold', async () => (await current()) === 'DETAIL')
      /* the dissolve keeps home mounted, switched off, while the pointer comes up there */
      await home.evaluate(() => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
      await page.waitForFunction(() => document.querySelector('[data-proto-current]')?.textContent === 'HOME')
    })

    it('keeps a held press pending through another interaction', async () => {
      const home = await start()
      await pressUntil(home, '#peek', async () => !!(await page.$('[data-proto-overlay="menu"]')))
      await screen('menu')
      /* the overlay's key:Enter runs (its target is gone, so only a notice shows) */
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.body.textContent?.includes('no longer on the canvas'))
      await home.evaluate(() => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
      await page.waitForFunction(() => !document.querySelector('[data-proto-overlay]'))
    })

    it('scrolls on a press scroll-to', async () => {
      const home = await start()
      await pressUntil(home, '#jump', () => home.evaluate(() => window.scrollY > 0))
      expect(await current()).toBe('HOME')
    })

    it('closes an overlay on Escape before the overlay screen runs its own key:Escape', async () => {
      const home = await start()
      await clickUntil(home, '#help', async () => !!(await page.$('[data-proto-overlay="menu"]')))
      const menu = await screen('menu')
      await menu.$eval('#close', (el) => (el as HTMLElement).focus())
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('[data-proto-overlay]'))
      await sleep(300)
      expect(await current()).toBe('HOME')
    })

    /* only the top screen takes input: the screen an overlay covers stays put */
    const COVERED: Canvas = {
      ...CANVAS,
      frames: [
        frame(
          'home',
          `<button id="help" data-doop-on="click" data-doop-action="overlay:menu">Help</button>
           <div data-doop-on="delay:800" data-doop-action="navigate:detail"></div>
           <div data-doop-on="key:k" data-doop-action="navigate:detail"></div>`,
        ),
        frame('detail', `<button id="back" data-doop-on="click" data-doop-action="back">Back</button>`, 500),
        frame(
          'menu',
          `<button id="close" data-doop-on="click" data-doop-action="close-overlay">Close</button>
           <button id="more" data-doop-on="click" data-doop-action="overlay:sheet">More</button>
           <div data-doop-on="key:k" data-doop-action="close-overlay"></div>`,
          1000,
        ),
        frame(
          'sheet',
          `<button id="done" data-doop-on="click" data-doop-action="close-overlay">Done</button>
           <div data-doop-on="key:k" data-doop-action="close-overlay"></div>`,
          1500,
        ),
      ],
    }
    const focusedScreen = () =>
      page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.doopProtoFrame)
    /* a wait that, when it never comes true, says where the focus and the overlays are */
    async function waitFor(label: string, check: () => boolean) {
      try {
        await page.waitForFunction(check)
      } catch (error) {
        const state = await page
          .evaluate(() => ({
            active: (document.activeElement as HTMLElement | null)?.outerHTML.slice(0, 120),
            overlays: [...document.querySelectorAll('[data-proto-overlay]')].map((el) =>
              el.getAttribute('data-proto-overlay'),
            ),
            current: document.querySelector('[data-proto-current]')?.textContent,
            messages: (window as unknown as Fixture).messages.map((m) => m.type).slice(-40),
          }))
          .catch(() => 'unavailable')
        throw new Error(`${label}: ${String(error)}\n${JSON.stringify(state)}`, { cause: error })
      }
    }

    it('runs only the top screen’s delays and keys while an overlay is open', async () => {
      await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), COVERED)
      await page.evaluate(() => (window as unknown as Fixture).play('home'))
      const home = await screen('home')
      /* a real click focuses the screen that opens the overlay */
      await home.$eval('#help', (el) => (el as HTMLElement).focus())
      await clickUntil(home, '#help', async () => !!(await page.$('[data-proto-overlay="menu"]')))
      await screen('menu')
      /* home's delay comes due under the overlay and does nothing */
      await sleep(1000)
      expect(await current()).toBe('HOME')
      expect(await page.$('[data-proto-overlay="menu"]')).not.toBeNull()

      /* the key goes to the menu on top, not to home, which held the focus */
      await page.keyboard.press('k')
      await page.waitForFunction(() => !document.querySelector('[data-proto-overlay]'))
      await sleep(200)
      expect(await current()).toBe('HOME')
    })

    it('hands the focus back to the uncovered screen as nested overlays close', async () => {
      await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), COVERED)
      await page.evaluate(() => (window as unknown as Fixture).play('home'))
      const home = await screen('home')
      await home.$eval('#help', (el) => (el as HTMLElement).focus())
      await clickUntil(home, '#help', async () => !!(await page.$('[data-proto-overlay="menu"]')))
      const menu = await screen('menu')
      await waitFor(
        'menu focused',
        () => (document.activeElement as HTMLElement | null)?.dataset.doopProtoFrame === 'menu',
      )
      await clickUntil(menu, '#more', async () => !!(await page.$('[data-proto-overlay="sheet"]')))
      await screen('sheet')
      await waitFor(
        'sheet focused',
        () => (document.activeElement as HTMLElement | null)?.dataset.doopProtoFrame === 'sheet',
      )
      await page.keyboard.press('k')
      await waitFor('sheet closed', () => !document.querySelector('[data-proto-overlay="sheet"]'))
      await expect.poll(focusedScreen).toBe('menu')
      await page.keyboard.press('k')
      await waitFor('menu closed', () => !document.querySelector('[data-proto-overlay]'))
      await expect.poll(focusedScreen).toBe('home')
      expect(await current()).toBe('HOME')
    })

    it('starts the delays of a live edit', async () => {
      const home = await start()
      /* the runtime is on once a click takes: an overlay opens */
      await clickUntil(home, '#help', async () => !!(await page.$('[data-proto-overlay="menu"]')))
      await page.$eval('[data-proto-scrim]', (el) => (el as HTMLElement).click())
      await page.waitForFunction(() => !document.querySelector('[data-proto-overlay]'))
      await page.evaluate(() =>
        (window as unknown as Fixture).editFrame(
          'home',
          '<!doctype html><html><head></head><body><button id="wait" data-doop-on="delay:100" data-doop-action="navigate:detail">Wait</button></body></html>',
        ),
      )
      await page.waitForFunction(() => document.querySelector('[data-proto-current]')?.textContent === 'DETAIL')
    })
  })
})
