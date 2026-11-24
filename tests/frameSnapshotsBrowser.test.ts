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

  it('keeps snapshots in motion between paced pinch events', async () => {
    const page = await pages.open()
    await openCanvasPage(page, [sample])
    await page.waitForSelector('[data-frame-snapshot-ready]')
    const transitions = await page.evaluate(async () => {
      const stage = document.querySelector('.stage')!
      const motionAttribute = 'data-frame-camera-moving'
      const states: boolean[] = []
      const observer = new MutationObserver(() => states.push(stage.hasAttribute(motionAttribute)))
      observer.observe(stage, { attributes: true, attributeFilter: [motionAttribute] })
      try {
        for (let event = 0; event < 3; event++) {
          stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -10 }))
          await new Promise((resolve) => setTimeout(resolve, 165))
        }
        return states
      } finally {
        observer.disconnect()
      }
    })
    expect(transitions).toEqual([true])
  })

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

  it.each([
    ['WebKit', 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko)'],
    ['Chromium', 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'],
  ])('draws deferred frames as images on a large %s overview and preserves loaded documents', async (_engine, ua) => {
    const page = await pages.open()
    await page.setViewport({ width: 1280, height: 800 })
    await page.setUserAgent(ua)
    const deferred = [
      canvasFrame({ id: 'long-a', name: 'Long A', x: 18000, y: 0, width: 4000, height: 12000 }),
      canvasFrame({ id: 'long-b', name: 'Long B', x: 23000, y: 0, width: 4000, height: 12000 }),
    ]
    await openCanvasPage(page, [sample, ...deferred])
    await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 30, y: 105, zoom: 0.57 }))
    const live = await page.waitForSelector('[data-doop-frame-shell="cached"] iframe[data-doop-frame]')
    const child = await live!.contentFrame()
    await child!.waitForSelector('input')
    await child!.evaluate(() => {
      document.querySelector('input')!.value = 'kept'
    })
    await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 30, y: 105, zoom: 0.015 }))
    for (const { id } of deferred) {
      await page.waitForSelector(`[data-doop-frame-shell="${id}"] img[data-frame-snapshot-ready]`, { visible: true })
      expect(await page.$(`[data-doop-frame-shell="${id}"] iframe[data-doop-frame]`)).toBeNull()
    }
    await page.waitForFunction((iframe) => getComputedStyle(iframe).display === 'none', {}, live!)

    await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 30, y: 105, zoom: 0.57 }))
    await page.waitForFunction(() => {
      const frame = document.querySelector('[data-doop-frame-shell="cached"] iframe[data-doop-frame]')
      return frame && getComputedStyle(frame).visibility === 'visible'
    })
    expect(await child!.evaluate(() => document.querySelector('input')!.value)).toBe('kept')
  })

  it('holds the heavy overview layer through threshold crossings until the zoom settles', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })
    const large = canvasFrame({ id: 'large', name: 'Large', x: 3000, y: 0, width: 5000, height: 16000 })
    await openCanvasPage(page, [sample, large])
    await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 230, y: 140, zoom: 0.04 }))
    await page.waitForSelector('[data-frame-overview] img[data-frame-snapshot-ready]', { visible: true })
    const layers = await page.evaluate(async () => {
      const stage = document.querySelector('.stage')!
      const layer = stage.querySelector('[data-frame-overview]')!
      const world = stage.querySelector('.world')!
      const states = []
      for (const zoom of [0.11, 0.04, 0.11]) {
        window.canvasPageHarness.setCamera({ x: 230, y: 140, zoom })
        await new Promise(requestAnimationFrame)
        states.push(layer.hasAttribute('data-frame-overview'))
      }
      return { states, willChange: getComputedStyle(world).willChange }
    })
    expect(layers).toEqual({ states: [true, true, true], willChange: 'auto' })
    await page.waitForFunction(() => !document.querySelector('.stage [data-frame-overview]'))
  })

  it('preserves dark root rules and increases cached density as the camera zooms in', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })
    const dark = {
      ...sample,
      html: `<!doctype html><html data-theme="dark"><style>
        :root { --page: white }
        :root[data-theme="dark"] { --page: #102030 }
        body { margin: 0; background: var(--page) }
        </style><body><p>Dark frame</p></body></html>`,
    }
    const far = canvasFrame({ id: 'far', name: 'Far', x: 28000, y: 0, width: 4000, height: 12000 })
    await openCanvasPage(page, [{ ...dark, html: '' }, far])
    const setZoom = (zoom: number) =>
      page.evaluate((zoom) => window.canvasPageHarness.setCamera({ x: 240, y: 160, zoom }), zoom)
    await setZoom(0.1)
    // Seed the document after the initial fit, so the first capture is at
    // the low zoom even if Chromium scheduled an idle task during opening.
    await page.evaluate((frames) => window.canvasPageHarness.seed(frames), [dark, far])
    const image = await page.waitForSelector('[data-doop-frame-shell="cached"] img[data-frame-snapshot-ready]')
    const low = await image!.evaluate((node) => node.naturalWidth)
    expect(low).toBe(170)
    await setZoom(0.5)
    await page.waitForFunction((image, width) => image.naturalWidth > width, {}, image!, low)
    expect(await image!.evaluate((node) => node.naturalWidth)).toBeGreaterThanOrEqual(dark.width)
    const color = await image!.evaluate((node) => {
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')!
      context.drawImage(node, 0, 0)
      return [...context.getImageData(120, 70, 1, 1).data]
    })
    expect(color).toEqual([16, 32, 48, 255])
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

describe.skipIf(!findBrowserPath())('canvas frame budgets', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  const iframe = (id: string) => `[data-doop-frame-shell="${id}"] iframe[data-doop-frame]`

  it('shows a snapshot for a visible frame beyond the live document budget', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1280, height: 800 })
    const frames = Array.from({ length: 21 }, (_, index) => ({
      ...sample,
      id: `preview-${index}`,
      x: (index % 7) * 500,
      y: Math.floor(index / 7) * 400,
      width: 480,
      height: 360,
    }))
    await openCanvasPage(page, frames)
    await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 290, y: 220, zoom: 0.2 }))
    await page.waitForFunction(() => document.querySelectorAll('iframe[data-doop-frame]').length === 20)
    const deferred = '[data-frame-document-deferred] img[data-frame-snapshot-ready]'
    const fallback = await page.waitForSelector(deferred, { visible: true })
    expect(await fallback!.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0)
    expect(await page.$$eval('iframe[data-doop-frame]', (nodes) => nodes.length)).toBe(20)
  })

  it('keeps a selected document, hibernates to a snapshot or placeholder, and reloads on return', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1280, height: 800 })
    // Exercise the settle queue used by engines that counter-zoom iframe documents.
    await page.setUserAgent({ userAgent: 'Doop layout zoom test' })
    const copies = (prefix: string, x: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...sample,
        id: prefix + i,
        html: '<body style="background:#475d78"><p>Frame preview</p></body>',
        x: x + (i % 5) * 115,
        y: Math.floor(i / 5) * 94,
        width: 112,
        height: 91,
      }))
    await openCanvasPage(page, [sample, unsupported, ...copies('near-', 30, 18), ...copies('far-', 4000, 20)])
    await page.evaluate(() => {
      const harness = window.canvasPageHarness
      harness.setCamera({ x: 220, y: 170, zoom: 0.6 })
    })
    const live = await page.waitForSelector(iframe('cached'))
    const child = await live!.contentFrame()
    await child!.waitForSelector('input')
    await child!.evaluate(() => {
      document.querySelector('input')!.value = 'before flight'
    })
    const snapshot = '[data-doop-frame-shell="cached"] [data-frame-snapshot-ready]'
    await page.waitForSelector(snapshot)
    await page.waitForFunction(() => {
      if (document.querySelector('.stage')?.hasAttribute('data-frame-camera-moving')) return false
      const frames = [...document.querySelectorAll('iframe[data-doop-frame]')]
      // The opening overview may still have far documents in their grace period.
      return frames.length === 20 && frames.every((node) => !node.closest('[data-doop-frame-shell^="far-"]'))
    })
    await page.evaluate(() => {
      window.canvasPageHarness.select('cached')
    })
    await page.waitForSelector(snapshot + '[data-frame-snapshot-blocked]')
    const released = await page.evaluate(() => {
      const stage = document.querySelector('.stage')!
      return new Promise<number[]>((resolve, reject) => {
        const batches: number[] = []
        const observer = new MutationObserver(() => {
          const deferred = [...stage.querySelectorAll<HTMLElement>('[data-frame-layout-root]')].filter(
            (wrapper) => wrapper.style.contentVisibility === 'hidden',
          ).length
          if (deferred === (batches.at(-1) ?? 0)) return
          batches.push(deferred)
          if (deferred === 0) {
            observer.disconnect()
            clearTimeout(timeout)
            resolve(batches)
          }
        })
        const timeout = setTimeout(() => {
          observer.disconnect()
          reject(new Error('Layout queue did not finish releasing far live frames'))
        }, 5000)
        observer.observe(stage, { subtree: true, attributes: true, attributeFilter: ['style'] })
        window.canvasPageHarness.setCamera({ x: -4940, y: 170, zoom: 1.25 })
      })
    })
    expect(released).toEqual([19, 15, 11, 7, 3, 0])
    await page.waitForFunction(() => {
      const frames = [...document.querySelectorAll('iframe[data-doop-frame]')]
      const farCount = frames.filter((node) =>
        node.closest('[data-doop-frame-shell]')?.getAttribute('data-doop-frame-shell')?.startsWith('far-'),
      ).length
      return frames.length === 20 && farCount === 19
    })
    expect(await live!.evaluate((node) => node.isConnected)).toBe(true)
    await page.evaluate(() => window.canvasPageHarness.select(null))
    // A snapshot can hide the iframe before the budget actually unloads it.
    await page.waitForFunction((node) => !node.isConnected, {}, live!)
    expect(await page.$eval(snapshot, (node) => getComputedStyle(node).visibility)).toBe('visible')
    expect(
      await page.$eval(
        '[data-doop-frame-shell="unsupported"] [data-frame-document-deferred]',
        (node) => getComputedStyle(node).backgroundColor,
      ),
    ).not.toBe('rgba(0, 0, 0, 0)')
    expect(await page.$('[data-doop-frame-shell="unsupported"] [data-frame-snapshot-ready]')).toBeNull()

    await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 220, y: 170, zoom: 0.6 }))
    const reloaded = await page.waitForSelector(iframe('cached'))
    const restoredChild = await reloaded!.contentFrame()
    await restoredChild!.waitForSelector('input')
    expect(await restoredChild!.$eval('input', (input) => input.value)).toBe('original')
  })

  it('keeps infinite effects held across the document budget, and plays them on selection', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1280, height: 800 })
    const animated = Array.from({ length: 6 }, (_, i) => ({
      ...sample,
      id: `animated-${i}`,
      x: i * 160,
      width: 260,
      height: 130,
      html: '<style>@keyframes pulse{to{opacity:.7}}p{animation:pulse 2s infinite}b{animation:pulse 2s infinite paused}</style><p>CSS</p><b>Authored pause</b>',
    }))
    await openCanvasPage(page, animated)
    await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 170, y: 175, zoom: 0.8 }))
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll('iframe[data-doop-frame]')]
      return (
        nodes.length === 6 && nodes.filter((node) => !node.hasAttribute('data-frame-animation-paused')).length === 4
      )
    })
    const focused = await page.waitForSelector('iframe[data-doop-frame]:not([data-frame-animation-paused])')
    const child = await focused!.contentFrame()
    await child!.waitForSelector('p')
    const cssState = () => child!.$eval('p', (p) => p.getAnimations()[0]?.playState)
    expect(await cssState()).toBe('paused')

    // Keep the gesture open while inspecting the opaque-origin child from the test driver.
    await page.evaluate(() => {
      let y = 175
      const timer = setInterval(() => window.canvasPageHarness.setCamera({ x: 170, y: ++y, zoom: 0.8 }), 30)
      setTimeout(() => clearInterval(timer), 1600)
    })
    await page.waitForFunction(() => document.querySelectorAll('iframe[data-frame-animation-paused]').length === 6)
    await child!.waitForFunction(() => document.querySelector('p')!.getAnimations()[0]?.playState === 'paused')
    await child!.$eval('p', (p) => {
      const animation = p.animate([{ opacity: 1 }, { opacity: 0.8 }], { duration: 3000, iterations: Infinity })
      animation.id = 'new-web-animation'
    })
    expect(
      await child!.evaluate(() => document.getAnimations().find((a) => a.id === 'new-web-animation')?.playState),
    ).toBe('paused')

    const id = await focused!.evaluate((node) =>
      node.closest('[data-doop-frame-shell]')!.getAttribute('data-doop-frame-shell'),
    )
    await page.evaluate((id) => window.canvasPageHarness.select(id), id)
    await child!.waitForFunction(
      () => document.getAnimations().find((a) => a.id === 'new-web-animation')?.playState === 'running',
    )
    expect(await cssState()).toBe('running')
    expect(await child!.$eval('b', (b) => b.getAnimations()[0]?.playState)).toBe('paused')
    await page.waitForFunction(() => !document.querySelector('.stage')?.hasAttribute('data-frame-camera-moving'))
    await page.evaluate(() => window.canvasPageHarness.select(null))
    await page.waitForFunction(() => document.querySelectorAll('iframe[data-frame-animation-paused]').length === 2)
    expect(await cssState()).toBe('paused')
  })
})
