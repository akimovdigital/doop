import sharp from 'sharp'
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
const back = { ...front, id: 'back', name: 'Back', x: 145, y: 130, width: 560, z: 1 }
const fixtures = [back, { ...front, z: 2 }]
const frontShell = '[data-doop-frame-shell="front"]'
const skeleton = '[data-frame-cold-skeleton]'

describe.skipIf(!findBrowserPath())('cold frame skeleton', () => {
  const pages = pagePerTest()

  it('covers the original surface until its runtime can render, and clears pending frames on canvas change', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1280, height: 800 })
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }])
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
    const stack = (await page.$('[data-frame-cold-skeleton-stack]'))!
    expect(
      await stack.evaluate((el) => {
        const style = getComputedStyle(el)
        return [style.animationName, style.animationDuration, style.animationIterationCount]
      }),
    ).toEqual(['cold-frame-pulse', '0.42s', '1'])
    expect(await surface.evaluate((el) => el.getAttribute('data-frame-cold-skeleton'))).toBe('narrow')
    expect(await page.$('[data-doop-frame-shell="back"] [data-frame-cold-skeleton="wide"]')).not.toBeNull()
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    expect(await stack.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    const appearance = await surface.evaluate((el) => {
      const read = () => {
        const cue = getComputedStyle(el, '::after')
        return [cue.backgroundColor, cue.pointerEvents, cue.animationName, cue.transitionDuration, cue.opacity]
      }
      document.documentElement.classList.remove('dark')
      const light = read()
      document.documentElement.classList.add('dark')
      return { light, dark: read() }
    })
    expect(appearance.light[0]).toBe('rgb(247, 247, 247)')
    expect(appearance.dark[0]).toBe('rgb(35, 35, 37)')
    expect(appearance.dark[0]).not.toBe(appearance.light[0])
    expect(appearance.dark.slice(1)).toEqual(['none', 'none', '0s', '1'])

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
            ...window.canvasPageHarness.frameState('front').frame!,
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
    const nextIframe = (await page.$(`${frontShell} iframe[data-doop-frame]`))!
    expect(await nextIframe.evaluate((el, win) => el.contentWindow !== win, originalWindow)).toBe(true)
    const next = (await nextIframe.contentFrame())!
    await next.waitForSelector('button')
    expect(await page.$(`${frontShell} ${skeleton}`)).not.toBeNull()
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

  it('distinguishes a replaced cover from a separately delayed visual update', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    await page.evaluateOnNewDocument(holdColdHtml)
    await openCanvasPage(page, [
      {
        ...front,
        html: '<div id="marker" hidden style="position:fixed;inset:0;background:#124e96"></div>',
      },
    ])
    await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 300, y: 140, zoom: 1 }))
    const iframe = (await page.waitForSelector(`${frontShell} iframe[data-doop-frame]`))!
    const child = (await iframe.contentFrame())!
    await child.waitForFunction(() => window.heldColdFrameHtml.length === 1)
    await page.waitForSelector(`${frontShell} ${skeleton}`, { visible: true })
    const owner = await iframe.evaluateHandle((el) => el.contentWindow)
    const sample = async () => {
      const box = (await iframe.boundingBox())!
      const clip = { x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height / 2), width: 1, height: 1 }
      return [
        ...(await sharp(await page.screenshot({ clip }))
          .removeAlpha()
          .raw()
          .toBuffer()),
      ]
    }

    expect(await sample()).not.toEqual([255, 255, 255])
    const payload = await child.evaluate(() => {
      window.holdColdFrameHtml = false
      return window.heldColdFrameHtml[0]!.data
    })
    await iframe.evaluate((el, data) => el.contentWindow!.postMessage(data, '*'), payload)
    const marker = (await child.waitForSelector('#marker'))!
    await page.waitForSelector(skeleton, { hidden: true })

    // This fixture controls a late visual update after the real HTML handoff.
    // The sampled white pixel characterizes the browser model, not CEF presentation.
    expect(await sample()).toEqual([255, 255, 255])
    await page.addStyleTag({ content: `${frontShell} [data-frame-surface]::before { background: #cc2266 !important }` })
    expect(await sample()).toEqual([204, 34, 102])
    await child.evaluate(() => (document.documentElement.style.backgroundColor = 'white'))
    expect(await sample()).toEqual([255, 255, 255])
    await marker.evaluate((el) => el.removeAttribute('hidden'))
    expect(await sample()).toEqual([18, 78, 150])
    expect(await iframe.evaluate((el, win) => el.isConnected && el.contentWindow === win, owner)).toBe(true)
    expect(await marker.evaluate((el) => el === document.querySelector('#marker'))).toBe(true)
  })

  it('waits for the cold paint before the far overview locks the same iframe', async () => {
    const page = await pages.open()
    await page.evaluateOnNewDocument(() => {
      if (window === window.top) {
        Object.defineProperties(window, {
          __DOOP_DESKTOP__: { value: '0.15.0' },
          __DOOP_DESKTOP_PLATFORM__: { value: 'macos' },
        })
        localStorage.setItem('doop:cold-frame-skeleton', '1')
        localStorage.setItem('doop:far-overview', '1')
        return
      }
      const request = window.requestAnimationFrame.bind(window)
      const pending: FrameRequestCallback[] = []
      let held = true
      window.requestAnimationFrame = (callback) => {
        if (!held) return request(callback)
        return pending.push(callback)
      }
      window.releaseColdFrameCallbacks = () => {
        held = false
        for (const callback of pending.splice(0)) request(callback)
      }
    })
    await openCanvasPage(page, [front])
    await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 150, y: 100, zoom: 0.05 }))
    await page.waitForSelector('.stage[data-far-overview]')
    const iframe = (await page.waitForSelector('iframe[data-doop-frame]'))!
    const child = (await iframe.contentFrame())!
    await child.waitForSelector('button')

    expect(await page.$(skeleton)).not.toBeNull()
    expect(await iframe.evaluate((el) => getComputedStyle(el).contentVisibility)).not.toBe('hidden')
    await child.evaluate(() => window.releaseColdFrameCallbacks())
    await page.waitForSelector(skeleton, { hidden: true })
    await page.waitForSelector('[data-far-overview-paper]', { visible: true })
    expect(await iframe.evaluate((el) => getComputedStyle(el).contentVisibility)).toBe('hidden')

    await page.evaluate(() => window.canvasPageHarness.select('front'))
    await page.waitForSelector('[data-far-overview-paper]', { hidden: true })
    expect(await iframe.evaluate((el) => el.isConnected && getComputedStyle(el).contentVisibility !== 'hidden')).toBe(
      true,
    )
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
