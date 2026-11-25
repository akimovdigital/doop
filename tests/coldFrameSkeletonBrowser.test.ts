import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage, showCanvasPage } from './canvasPageFixture'

declare global {
  interface Window {
    releaseColdFrameCallbacks: () => void
    holdColdFrameHtml: boolean
    heldColdFrameHtml: { html: string; data: unknown; time: number }[]
  }
}

const front = {
  ...canvasFrame({ id: 'front', name: 'Front', x: 100, y: 100, width: 300, height: 200 }),
  html: `<button onclick="this.textContent = 'Clicked'">Live</button>`,
}
const back = { ...front, id: 'back', name: 'Back', x: 145, y: 130, z: 1 }
const fixtures = [back, { ...front, z: 2 }]
const frontShell = '[data-doop-frame-shell="front"]'
const skeleton = '[data-frame-cold-skeleton]'

describe.skipIf(!findBrowserPath())('cold frame skeleton', () => {
  const pages = pagePerTest()

  it('covers the original surface until its runtime can render, and clears pending frames on canvas change', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1280, height: 800 })
    await page.evaluateOnNewDocument(() => {
      if (window === window.top) {
        Object.defineProperties(window, {
          __DOOP_DESKTOP__: { value: '0.15.0' },
          __DOOP_DESKTOP_PLATFORM__: { value: 'macos' },
        })
        localStorage.setItem('doop:html-frame-toolbar', '1')
        return
      }
      const native = window.requestAnimationFrame.bind(window)
      let held = true
      const pending: FrameRequestCallback[] = []
      window.requestAnimationFrame = (callback) =>
        native((time) => {
          if (held) pending.push(callback)
          else callback(time)
        })
      window.releaseColdFrameCallbacks = () => {
        held = false
        for (const callback of pending.splice(0)) native(callback)
      }
    })
    async function fit() {
      await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 10, y: 10, zoom: 0.25 }))
      await page.keyboard.down('Shift')
      await page.keyboard.press('Digit1')
      await page.keyboard.up('Shift')
      await page.waitForFunction(() => window.canvasPageHarness.camera().zoom !== 0.25)
    }
    const geometry = () =>
      page.$$eval('[data-doop-frame-shell]', (shells) =>
        shells.map((el) => {
          const { x, y, width, height } = el.getBoundingClientRect()
          return [el.getAttribute('data-doop-frame-shell'), getComputedStyle(el).zIndex, x, y, width, height]
        }),
      )
    await openCanvasPage(page, fixtures)
    await fit()
    const baseline = await geometry()
    expect(await page.$$(skeleton)).toHaveLength(0)

    await page.evaluate(() => localStorage.setItem('doop:cold-frame-skeleton', '1'))
    await showCanvasPage(page, fixtures)
    await page.waitForSelector(`${frontShell} ${skeleton}`, { timeout: 3000 })
    const iframe = (await page.waitForSelector(`${frontShell} iframe[data-doop-frame]`))!
    const child = (await iframe.contentFrame())!
    const liveButton = (await child.waitForSelector('button'))!
    await fit()
    const covered = await geometry()
    expect(covered).toEqual(baseline)
    const surface = (await page.$(`${frontShell} [data-frame-surface]`))!
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    const appearance = await surface.evaluate((el) => {
      const read = () => {
        const cue = getComputedStyle(el, '::after')
        return [cue.backgroundImage, cue.pointerEvents, cue.animationName, cue.transitionDuration]
      }
      document.documentElement.classList.remove('dark')
      const light = read()
      document.documentElement.classList.add('dark')
      return { light, dark: read() }
    })
    expect(appearance.light[0]).toContain('linear-gradient')
    expect(appearance.dark[0]).not.toBe(appearance.light[0])
    expect(appearance.dark.slice(1)).toEqual(['none', 'none', '0s'])

    // A normal window message from a design cannot substitute for the private port.
    await child.evaluate(() => {
      parent.postMessage({ event: 'cold-document-applied', generation: 1 }, '*')
      parent.postMessage({ event: 'viewport-painted', reqId: -1, coldGeneration: 1 }, '*')
    })
    expect(await surface.evaluate((el) => el.hasAttribute('data-frame-cold-skeleton'))).toBe(true)

    const originalWindow = (await iframe.evaluateHandle((el) => el.contentWindow))!
    await child.evaluate(() => window.releaseColdFrameCallbacks())
    await page.waitForSelector(`${frontShell} ${skeleton}`, { hidden: true })
    expect(await page.$$(skeleton)).toHaveLength(1)
    expect(await geometry()).toEqual(covered)
    expect(await iframe.evaluate((el, win) => el.isConnected && el.contentWindow === win, originalWindow)).toBe(true)
    expect(
      await liveButton.evaluate((el) => document.querySelector('button') === el && el.textContent === 'Live'),
    ).toBe(true)
    await page.evaluate(() => {
      window.canvasPageHarness.setCamera({ x: 250, y: 100, zoom: 1 })
      window.canvasPageHarness.select('front')
    })
    const play = '[data-canvas-browser-chrome="front"] .browser-canvas-bar button[aria-label="Interact with page"]'
    await page.waitForSelector(play, { visible: true, timeout: 3000 })
    await page.click(play)
    await page.waitForSelector(`${frontShell}[data-html-frame-active]`, { timeout: 3000 })
    await liveButton.click()
    await child.waitForFunction(() => document.querySelector('button')?.textContent === 'Clicked', { timeout: 3000 })
    await page.keyboard.press('Escape')

    await page.evaluate(() =>
      window.canvasPageHarness.seed(
        [
          {
            ...window.canvasPageHarness.frameState('back').frame!,
            canvasId: 'next',
            name: 'Next',
          },
        ],
        { id: 'next' },
      ),
    )
    await page.waitForFunction(
      () => document.querySelector('iframe[data-doop-frame]')?.getAttribute('title') === 'Next',
    )
    expect(await iframe.evaluate((el) => el.isConnected)).toBe(false)
    expect(await page.$$(skeleton)).toHaveLength(1)
    const next = (await (await page.$('iframe[data-doop-frame]'))!.contentFrame())!
    await next.waitForSelector('button')
    await next.evaluate(() => window.releaseColdFrameCallbacks())
    await page.waitForSelector(skeleton, { hidden: true })
  })

  it('keeps the cover through the RPC timeout and lets the same live document recover applied HTML', async () => {
    const page = await pages.open()
    await page.evaluateOnNewDocument(holdColdHtml)
    await openCanvasPage(page, [front])
    const iframe = (await page.waitForSelector('iframe[data-doop-frame]'))!
    const child = (await iframe.contentFrame())!
    await child.waitForFunction(() => window.heldColdFrameHtml.length === 1)
    const held = (await child.evaluate(() => window.heldColdFrameHtml[0]))!
    await page.waitForFunction((time) => Date.now() - time >= 2250, {}, held.time)
    expect(await page.$(skeleton)).not.toBeNull()
    expect(await child.$('button')).toBeNull()
    const originalWindow = await iframe.evaluateHandle((el) => el.contentWindow)

    await child.evaluate(() => {
      window.holdColdFrameHtml = false
    })
    await iframe.evaluate((el, data) => el.contentWindow!.postMessage(data, '*'), held.data)
    await child.waitForSelector('button')
    await page.waitForSelector(skeleton, { hidden: true, timeout: 3000 })
    expect(await iframe.evaluate((el, win) => el.isConnected && el.contentWindow === win, originalWindow)).toBe(true)
    expect(await child.$eval('button', (el) => el.textContent)).toBe('Live')
    expect(await page.$eval('[data-frame-surface]', (el) => getComputedStyle(el, '::before').content)).toBe('""')
  })

  it('keeps a replacement request covered when the previous generation applies in the same iframe', async () => {
    const page = await pages.open()
    await page.evaluateOnNewDocument(holdColdHtml)
    await openCanvasPage(page, [front])
    const iframe = (await page.waitForSelector('iframe[data-doop-frame]'))!
    const child = (await iframe.contentFrame())!
    await child.waitForFunction(() => window.heldColdFrameHtml.length === 1)
    const updated = { ...front, html: '<button>Replacement</button>' }
    await page.evaluate((frame) => window.canvasPageHarness.seed([frame]), updated)
    await child.waitForFunction(() => window.heldColdFrameHtml.some(({ html }) => html.includes('Replacement')))
    const [old, current] = await child.evaluate(() => {
      window.holdColdFrameHtml = false
      return [window.heldColdFrameHtml[0], window.heldColdFrameHtml.find(({ html }) => html.includes('Replacement'))]
    })
    await iframe.evaluate((el, data) => el.contentWindow!.postMessage(data, '*'), old!.data)
    await child.waitForSelector('button')
    await child.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    )
    expect(await page.$(skeleton)).not.toBeNull()
    expect(await child.$eval('button', (el) => el.textContent)).toBe('Live')

    await iframe.evaluate((el, data) => el.contentWindow!.postMessage(data, '*'), current!.data)
    await page.waitForSelector(skeleton, { hidden: true, timeout: 3000 })
    expect(await child.$eval('button', (el) => el.textContent)).toBe('Replacement')
  })
})

function holdColdHtml() {
  if (window === window.top) {
    Object.defineProperties(window, {
      __DOOP_DESKTOP__: { value: '0.15.0' },
      __DOOP_DESKTOP_PLATFORM__: { value: 'macos' },
    })
    localStorage.setItem('doop:cold-frame-skeleton', '1')
    return
  }
  window.holdColdFrameHtml = true
  window.heldColdFrameHtml = []
  window.addEventListener(
    'message',
    (event) => {
      if (!window.holdColdFrameHtml || !event.isTrusted || event.source !== parent || event.data?.type !== 'doop:html')
        return
      event.stopImmediatePropagation()
      window.heldColdFrameHtml.push({ html: event.data.html, data: event.data, time: Date.now() })
    },
    true,
  )
}
