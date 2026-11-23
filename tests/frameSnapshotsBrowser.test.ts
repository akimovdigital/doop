import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'puppeteer-core'
import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

const sample = canvasFrame({ id: 'cached', name: 'Cached', x: 0, y: 0, width: 680, height: 300 })
sample.html = '<body style="margin:0;background:#235a8d;color:white"><input value="original"><h1>Design</h1></body>'
const unsupported = {
  ...sample,
  id: 'unsupported',
  y: 330,
  html: '<body><iframe src="about:blank" title="Nested"></iframe></body>',
}

function gestureLayers(page: Page, ctrlKey: boolean) {
  return page.evaluate((ctrlKey) => {
    const stage = document.querySelector('.stage')!
    return new Promise<{ documents: string[]; bitmap: string }>((resolve) => {
      const observer = new MutationObserver(() => {
        if (!stage.hasAttribute('data-frame-camera-moving')) return
        observer.disconnect()
        return resolve({
          documents: [...document.querySelectorAll('iframe[data-doop-frame]')].map(
            (node) => getComputedStyle(node).visibility,
          ),
          bitmap: getComputedStyle(document.querySelector('img[data-frame-snapshot-ready]')!).visibility,
        })
      })
      observer.observe(stage, { attributes: true, attributeFilter: ['data-frame-camera-moving'] })
      stage.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey, deltaY: ctrlKey ? -10 : 30 }),
      )
    })
  }, ctrlKey)
}

describe.skipIf(!findBrowserPath())('canvas frame snapshots', { timeout: 30_000 }, () => {
  const pages = pagePerTest()

  it('swaps cached documents during zoom, keeps a missing snapshot live, and restores the same document', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1280, height: 800 })
    await openCanvasPage(page, [sample, unsupported])
    await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 190, y: 140, zoom: 0.5 }))
    const live = await page.waitForSelector('[data-doop-frame-shell="cached"] iframe[data-doop-frame]')
    const child = await live!.contentFrame()
    await child!.waitForSelector('input')
    await child!.evaluate(() => {
      document.querySelector('input')!.value = 'kept'
    })
    await page.waitForSelector('[data-doop-frame-shell="cached"] [data-frame-snapshot-ready]')

    const rasterPixel = await page.$eval('img[data-frame-snapshot-ready]', (image) => {
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      return [...context.getImageData(250, 100, 1, 1).data]
    })
    expect(rasterPixel).toEqual([35, 90, 141, 255])

    const moving = { documents: ['hidden', 'visible'], bitmap: 'visible' }
    expect(await gestureLayers(page, true)).toEqual(moving)
    await page.waitForFunction(() => {
      const live = document.querySelector('[data-doop-frame-shell="cached"] iframe[data-doop-frame]')
      return live && getComputedStyle(live).visibility === 'visible'
    })
    expect(await child!.evaluate(() => document.querySelector('input')!.value)).toBe('kept')
    expect(await live!.evaluate((iframe) => iframe.isConnected)).toBe(true)

    expect(await gestureLayers(page, false)).toEqual(moving)

    await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 190, y: 140, zoom: 0.15 }))
    await page.waitForFunction(() => !document.querySelector('.stage')?.hasAttribute('data-frame-camera-moving'))
    expect(await live!.evaluate((iframe) => getComputedStyle(iframe).visibility)).toBe('hidden')
  })

  it('paints the same pixels as the live-only view at rest above the size cutoff', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1440, height: 800 })
    await page.mouse.move(1, 799)
    await openCanvasPage(page, [sample])
    await page.waitForSelector('[data-frame-snapshot-ready]')
    await page.locator('button[aria-label="Close panel"]').click()
    await page.mouse.move(1, 799)
    const output = await mkdtemp(join(tmpdir(), 'doop-motion-pixels-'))
    console.info('Motion LOD rest screenshots:', output)

    for (const zoom of [0.25, 1]) {
      await page.evaluate((zoom) => window.canvasPageHarness.setCamera({ x: 410, y: 240, zoom }), zoom)
      await page.waitForFunction(() => !document.querySelector('.stage')?.hasAttribute('data-frame-camera-moving'))
      const layer = await page.waitForSelector('[data-doop-frame-shell="cached"]')
      const stack = await layer!.evaluateHandle((shell) => shell.parentElement!)
      const surface = await layer!.$('[data-frame-surface]')
      const clip = (await surface!.boundingBox())!
      const label = String(zoom * 100)
      const optimized = await page.screenshot({
        clip,
        captureBeyondViewport: false,
        path: join(output, `${label}-lod.png`),
      })
      await stack.evaluate((node) => node.setAttribute('data-frame-snapshots-disabled', ''))
      const live = await page.screenshot({
        clip,
        captureBeyondViewport: false,
        path: join(output, `${label}-live.png`),
      })
      expect(Buffer.from(optimized).equals(Buffer.from(live))).toBe(true)
      await stack.evaluate((node) => node.removeAttribute('data-frame-snapshots-disabled'))
    }

    for (const width of [375, 768, 1440]) {
      await page.setViewport({ width, height: 800 })
      await page.evaluate(
        (x) => window.canvasPageHarness.setCamera({ x, y: 220, zoom: 0.45 }),
        width === 375 ? 25 : width === 768 ? 210 : 410,
      )
      await page.waitForFunction(() => !document.querySelector('.stage')?.hasAttribute('data-frame-camera-moving'))
      await page.screenshot({ path: join(output, `viewport-${width}.png`) })
    }
  })
})
