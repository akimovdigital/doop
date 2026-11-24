import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

const sample = canvasFrame({ id: 'motion', name: 'Motion', x: 0, y: 0, width: 500, height: 320 })
sample.html = `<style>
  @keyframes pulse { from { opacity: 1 } to { opacity: .4 } }
  body { margin: 0; padding: 30px; background: #102343; color: white }
  #pulse { animation: pulse 5s infinite linear; filter: blur(12px) brightness(.9) }
  #finite { animation: pulse 60s 2; filter: blur(2px) }
  #glass { backdrop-filter: blur(12px); background: #91588388; padding: 20px }
</style><h1>Motion example</h1><p id="pulse">Infinite</p><p id="finite">Finite</p><div id="glass">Glass</div>`

describe.skipIf(!findBrowserPath())('canvas motion islands', { timeout: 30_000 }, () => {
  const pages = pagePerTest()

  it('rests expensive motion on the canvas without covering finite motion or Present', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1440, height: 800 })
    await openCanvasPage(page, [sample])
    await page.locator('button[aria-label="Close panel"]').click()
    await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 350, y: 140, zoom: 1 }))
    const iframe = await page.waitForSelector('iframe[data-doop-frame]')
    const child = (await iframe!.contentFrame())!
    const output = await mkdtemp(join(tmpdir(), 'doop-islands-pixels-'))
    console.info('Motion islands screenshots:', output)

    await child.waitForFunction(() => {
      const pulse = document.querySelector('#pulse')?.getAnimations()[0]
      const finite = document.querySelector('#finite')?.getAnimations()[0]
      return pulse?.playState === 'paused' && finite?.playState === 'running'
    }, { timeout: 5000 })
    const state = () =>
      child.evaluate(() => {
        const pulse = document.querySelector('#pulse')!
        const finite = document.querySelector('#finite')!
        return {
          time: Number(pulse.getAnimations()[0]!.currentTime),
          filter: getComputedStyle(pulse).filter,
          finite: finite.getAnimations()[0]!.playState,
          light: getComputedStyle(finite).filter,
          backdrop: getComputedStyle(document.querySelector('#glass')!).backdropFilter,
        }
      })
    const first = await state()
    expect(first).toMatchObject({
      filter: 'blur(12px) brightness(0.9)',
      finite: 'running',
      light: 'blur(2px)',
      backdrop: 'blur(12px)',
    })
    expect(first.time).toBeGreaterThanOrEqual(0)

    const webAnimation = await child.evaluate(() => {
      const motion = document.querySelector('#pulse')!.animate(
        { transform: ['translateX(0)', 'translateX(10px)'] },
        { duration: 2000, iterations: Infinity },
      )
      motion.id = 'waapi'
      return motion.playState
    })
    expect(webAnimation).toBe('paused')
    await child.$eval('#finite', (el) => el.getAnimations()[0]?.pause())
    await child.waitForFunction(() => document.getAnimations().every((animation) => !animation.pending))
    const clip = (await iframe!.boundingBox())!
    const before = await page.screenshot({ clip, path: join(output, 'rest-before.png') })

    await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 350, y: 140, zoom: 0.4 }))
    await child.waitForFunction(() => getComputedStyle(document.querySelector('#pulse')!).filter === 'brightness(0.9)')
    await page.waitForFunction(() => !document.querySelector('.stage')?.hasAttribute('data-frame-camera-moving'))
    expect(await state()).toMatchObject({
      time: first.time,
      filter: 'brightness(0.9)',
      light: 'blur(2px)',
      backdrop: 'none',
    })
    const exported = await iframe!.evaluate(
      (el) =>
        new Promise<string>((resolve) => {
          const win = (el as HTMLIFrameElement).contentWindow!
          const reqId = 'motion-islands-export'
          function onResult(event: MessageEvent) {
            if (event.source !== win || event.data?.type !== 'doop:snapshot-result' || event.data.reqId !== reqId) return
            window.removeEventListener('message', onResult)
            resolve(event.data.html)
          }
          window.addEventListener('message', onResult)
          win.postMessage({ type: 'doop:snapshot', reqId }, '*')
        }),
    )
    expect(exported).toMatch(/filter:\s*blur\(12px\) brightness\(0?\.9\)/)
    expect(exported).not.toContain('doop-motion-islands')

    await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 350, y: 140, zoom: 1 }))
    await child.waitForFunction(() => getComputedStyle(document.querySelector('#pulse')!).filter.includes('blur(12px)'))
    expect(await state()).toMatchObject({ time: first.time, backdrop: 'blur(12px)' })
    await page.waitForFunction(() => !document.querySelector('.stage')?.hasAttribute('data-frame-camera-moving'))
    const after = await page.screenshot({ clip, path: join(output, 'rest-after.png') })
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true)

    for (const width of [375, 768, 1280, 1440]) {
      await page.setViewport({ width, height: 800 })
      await page.evaluate(
        (width) => window.canvasPageHarness.setCamera({ x: width >= 1024 ? 350 : 24, y: 140, zoom: width === 375 ? 0.6 : 1 }),
        width,
      )
      await page.waitForFunction(() => !document.querySelector('.stage')?.hasAttribute('data-frame-camera-moving'))
      await page.screenshot({ path: join(output, `canvas-${width}.png`) })
    }

    await page.waitForSelector('button[aria-label="Present prototype"]:enabled')
    await page.click('button[aria-label="Present prototype"]')
    const presented = await page.waitForSelector('iframe[data-doop-proto-frame="motion"]', { visible: true })
    const playback = (await presented!.contentFrame())!
    await playback.waitForFunction(() => document.querySelector('#pulse')?.getAnimations()[0]?.playState === 'running')
    const start = await playback.$eval('#pulse', (el) => Number(el.getAnimations()[0]!.currentTime))
    await playback.waitForFunction(
      (start) => Number(document.querySelector('#pulse')?.getAnimations()[0]?.currentTime) > start,
      {},
      start,
    )
    expect(await playback.$eval('#pulse', (el) => getComputedStyle(el).filter)).toBe('blur(12px) brightness(0.9)')
    await page.screenshot({ path: join(output, 'present-1440.png') })
  })

  it('plays the selected frame and respects reduced motion inside it', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1280, height: 800 })
    await openCanvasPage(page, [sample])
    await page.evaluate(() => {
      window.canvasPageHarness.setCamera({ x: 350, y: 140, zoom: 0.4 })
      window.canvasPageHarness.select('motion')
    })
    const iframe = await page.waitForSelector('iframe[data-doop-frame]')
    const child = (await iframe!.contentFrame())!
    await child.waitForFunction(() => document.querySelector('#pulse')?.getAnimations()[0]?.playState === 'running')
    expect(await child.$eval('#pulse', (el) => getComputedStyle(el).filter)).toBe('blur(12px) brightness(0.9)')

    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await child.waitForFunction(() => document.querySelector('#pulse')?.getAnimations()[0]?.playState === 'paused')
    expect(await child.$eval('#finite', (el) => el.getAnimations()[0]?.playState)).toBe('running')
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }])
    await child.waitForFunction(() => document.querySelector('#pulse')?.getAnimations()[0]?.playState === 'running')
  })

  it('shows finished reveals and holds live effects through CEF canvas selection and interaction', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1440, height: 800 })
    await page.evaluateOnNewDocument(() => {
      if (window !== window.top) return
      Object.defineProperties(window, {
        __DOOP_DESKTOP__: { value: '0.14.0' },
        __DOOP_DESKTOP_PLATFORM__: { value: 'macos' },
      })
      localStorage.setItem('doop:html-frame-toolbar', '1')
    })
    const html = `<style>
        @keyframes reveal { from { opacity: 0 } to { opacity: 1 } }
        @keyframes pulse { to { transform: translateX(40px) } }
        #intro, #on-hover { opacity: 0 }
        #intro, button:hover + #on-hover { animation: reveal 20s 5s both }
        #pulse { animation: pulse 20s infinite linear }
      </style><h1 id="intro">Visible title</h1><p id="pulse">Loop</p>
      <button>Increment</button><p id="on-hover">Visible on hover</p><output>0</output>
      <script>
        let clicks = 0;
        document.querySelector('button').onclick = () => {
          document.querySelector('output').value = ++clicks;
          const effect = document.querySelector('output').animate([{ opacity: 0 }, { opacity: 1 }], 20000);
          effect.id = 'click-reveal';
        };
      </script>`
    await openCanvasPage(page, [{ ...sample, html }, { ...sample, id: 'other', x: 560 }])
    await page.evaluate(() => window.canvasPageHarness.setCamera({ x: 280, y: 180, zoom: 1 }))
    await page.waitForFunction(() => !document.querySelector('[data-frame-camera-moving]'))
    const shell = '[data-doop-frame-shell="motion"]'
    const iframe = (await page.waitForSelector(`${shell} iframe`))!
    const child = await iframe.contentFrame()
    await child.waitForSelector('#intro')
    const motion = () =>
      child.evaluate(() => ({
        opacity: getComputedStyle(document.querySelector('#intro')!).opacity,
        loop: document.querySelector('#pulse')!.getAnimations()[0]?.playState,
        time: Number(document.querySelector('#pulse')!.getAnimations()[0]?.currentTime),
      }))
    await child.waitForFunction(() => getComputedStyle(document.querySelector('#intro')!).opacity === '1')
    const initial = await motion()
    expect(initial).toEqual({ opacity: '1', loop: 'paused', time: 0 })

    await page.hover(`${shell} [data-frame-surface]`)
    await page.click(`${shell} [data-frame-surface]`)
    await page.evaluate(() => window.canvasPageHarness.select('other'))
    await page.evaluate(() => window.canvasPageHarness.select('motion'))
    const interact = '[data-html-browser-chrome] button[aria-label="Interact with page"]'
    await page.locator(interact).click()
    const button = (await child.waitForSelector('button'))!
    await button.hover()
    await child.waitForFunction(() => getComputedStyle(document.querySelector('#on-hover')!).opacity === '1')
    await button.click()
    await child.waitForFunction(() => document.querySelector('output')?.value === '1')
    expect(await motion()).toEqual(initial)
    expect(await child.$eval('output', (output) => getComputedStyle(output).opacity)).toBe('1')
    expect(await child.$eval('output', (output) => output.getAnimations()[0]?.playState)).toBe('paused')

    await page.keyboard.press('Escape')
    await page.locator('[data-html-browser-chrome] button[aria-label="Present browser"]').click()
    const presented = (await page.waitForSelector('iframe[data-doop-proto-frame="motion"]', { visible: true }))!
    const playback = await presented.contentFrame()
    await playback.waitForFunction(() => document.querySelector('#pulse')?.getAnimations()[0]?.playState === 'running')
    expect(await playback.$eval('#intro', (intro) => getComputedStyle(intro).opacity)).toBe('0')
  })
})
