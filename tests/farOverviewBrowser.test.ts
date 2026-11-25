import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

const shell = '[data-doop-frame-shell="probe"]'
const overview = `${shell} [data-far-overview-paper]`
const fixture = {
  ...canvasFrame({ id: 'probe', name: 'Probe', x: 0, y: 0, width: 500, height: 320 }),
  html: `<body style="margin:0;padding:16px;background:#234567">
    <input id="field" aria-label="Probe field">
    <div id="scroller" style="margin-top:16px;width:220px;height:100px;overflow:auto">
      <div style="height:420px">Nested scrolling</div>
    </div>
  </body>`,
}

describe.skipIf(!findBrowserPath())('far overview browser handoff', () => {
  const pages = pagePerTest()

  it('preserves the scrolled document after a trusted click returns from the overview', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    await page.evaluateOnNewDocument(() => {
      if (window !== window.top) return
      Object.defineProperties(window, {
        __DOOP_DESKTOP__: { value: '0.15.0' },
        __DOOP_DESKTOP_PLATFORM__: { value: 'macos' },
      })
      localStorage.setItem('doop:far-overview', '1')
      localStorage.setItem('doop:html-frame-toolbar', '1')
    })
    await openCanvasPage(page, [fixture])
    const place = (zoom: number) =>
      page.evaluate((zoom) => window.canvasPageHarness.setCamera({ x: 435, y: 175, zoom }), zoom)
    await place(1)
    const iframe = (await page.waitForSelector(`${shell} iframe[data-doop-frame]`))!
    const child = (await iframe.contentFrame())!
    const input = (await child.waitForSelector('#field'))!
    const originalWindow = await iframe.evaluateHandle((el) => el.contentWindow)
    const originalDocument = await child.evaluateHandle(() => document)
    const pageState = () =>
      input.evaluate(
        (el, doc) => ({
          active: document.activeElement === el && document.hasFocus(),
          same: document === doc && document.querySelector('#field') === el,
          value: (el as HTMLInputElement).value,
          scroll: document.querySelector('#scroller')!.scrollTop,
        }),
        originalDocument,
      )

    const box = (await iframe.boundingBox())!
    await page.mouse.click(box.x + 65, box.y + 65)
    const play = '[data-canvas-browser-chrome="probe"] button[aria-label="Interact with page"]'
    await page.waitForSelector(play, { visible: true })
    await page.click(play)
    await page.waitForSelector(`${shell}[data-html-frame-active]`)
    await input.click()
    await page.keyboard.type('kept')
    const scroller = (await child.$('#scroller'))!
    const scrollBox = (await scroller.boundingBox())!
    await page.mouse.move(scrollBox.x + 30, scrollBox.y + 45)
    await page.mouse.wheel({ deltaY: 120 })
    await child.waitForFunction(() => document.querySelector('#scroller')!.scrollTop > 0)
    const edited = await pageState()
    expect(edited).toMatchObject({ active: true, same: true, value: 'kept' })

    await place(0.05)
    await page.waitForSelector('.stage[data-far-overview]')
    expect(await pageState()).toEqual(edited)
    expect(await iframe.evaluate((el) => getComputedStyle(el).contentVisibility)).not.toBe('hidden')

    // The first outside click exits Interact, the next clears the selection.
    await page.mouse.click(760, 560)
    await page.waitForSelector(`${shell}[data-html-frame-active]`, { hidden: true })
    expect(await page.evaluate(() => window.canvasPageHarness.frameState('probe').selectedId)).toBe('probe')
    expect(await pageState()).toEqual({ ...edited, active: false })
    await page.mouse.click(760, 560)
    await page.waitForSelector(overview, { visible: true })
    expect(await pageState()).toEqual({ ...edited, active: false })
    const agents = () =>
      page.evaluate(() => {
        const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(
          (el) => el.textContent?.trim() === 'Agents',
        )!
        const panel = tab.closest('[data-slot="panel"]')!
        const composer = panel.querySelector('textarea')!
        const { x, y, width, height } = panel.getBoundingClientRect()
        const bottom = document.elementFromPoint(x + width / 2, y + height - 6)
        return {
          rect: { x, y, width, height },
          composer: composer.getBoundingClientRect().height > 0,
          selected: tab.getAttribute('aria-selected'),
          bottomHit: panel.contains(bottom),
        }
      })
    const before = await agents()
    expect(before).toMatchObject({ composer: true, selected: 'true', bottomHit: true })
    const { x, y, width, height } = before.rect
    const clip = { x: Math.floor(x + width / 2), y: Math.floor(y + height * 0.78), width: 1, height: 1 }
    const panelPixel = async () => [
      ...(await sharp(await page.screenshot({ clip }))
        .removeAlpha()
        .raw()
        .toBuffer()),
    ]
    const pixelBefore = await panelPixel()

    const distant = (await iframe.boundingBox())!
    await page.mouse.click(distant.x + distant.width / 2, distant.y + distant.height / 2)
    await page.waitForSelector(overview, { hidden: true })
    expect(await iframe.evaluate((el, win) => el.isConnected && el.contentWindow === win, originalWindow)).toBe(true)
    expect(await iframe.boundingBox()).toEqual(distant)
    expect(await pageState()).toEqual({ ...edited, active: false })
    expect(await agents()).toEqual(before)
    expect(await panelPixel()).toEqual(pixelBefore)
  })
})
