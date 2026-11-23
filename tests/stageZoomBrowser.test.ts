import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

type CommitCounts = { stage: number; frameStack: number; frameView: number }

interface Fiber {
  elementType: unknown
  flags: number
  return: Fiber | null
  child: Fiber | null
  sibling: Fiber | null
}

declare global {
  interface Window {
    zoomCommits: CommitCounts
  }
}

function installZoomCommitCounter() {
  window.zoomCommits = { stage: 0, frameStack: 0, frameView: 0 }
  let previous = new Set<Fiber>()
  /* The production React 18 renderer reports each committed root to DevTools.
     PerformedWork (bit 0) identifies fibers that rendered in that commit.
     A Profiler around Stage would also count overlay-only updates. */
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
    value: {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberRoot: (_renderer: number, { current }: { current: Fiber }) => {
        const types = window.canvasPageHarness?.componentTypes
        if (!types) return
        const committed = new Set<Fiber>()
        function rendered(fiber: Fiber | null | undefined) {
          if (!fiber) return false
          committed.add(fiber)
          // A bailed-out subtree can reuse its fibers with their old flags.
          return !previous.has(fiber) && (fiber.flags & 1) !== 0
        }
        let stage = false
        let frameStack = false
        let frameView = false
        function visit(first: Fiber | null) {
          for (let fiber = first; fiber; fiber = fiber.sibling) {
            if (fiber.elementType === types.stage && rendered(fiber)) stage = true
            if (fiber.elementType === types.frame) {
              if (rendered(fiber)) frameView = true
              // FrameStack renders each FrameView directly inside its layer div.
              if (rendered(fiber.return?.return)) frameStack = true
            }
            if (fiber.child) visit(fiber.child)
          }
        }
        visit(current)
        previous = committed
        window.zoomCommits.stage += Number(stage)
        window.zoomCommits.frameStack += Number(frameStack)
        window.zoomCommits.frameView += Number(frameView)
      },
    },
  })
}

async function measureZoomCommits() {
  const stage = document.querySelector('.stage')!
  const { left, top, width, height } = stage.getBoundingClientRect()
  const { camera, setCamera } = window.canvasPageHarness
  setCamera({ x: 75, y: 100, zoom: 0.5 })
  // Let the initial fit and frame admission settle before counting.
  await new Promise((resolve) => setTimeout(resolve, 350))
  const mounted = { ...window.zoomCommits }
  window.zoomCommits = { stage: 0, frameStack: 0, frameView: 0 }
  const initial = camera().zoom
  let lastZoom = initial
  let peak = initial
  let cameraUpdates = 0
  let previousOffset = 0
  await new Promise<void>((resolve) => {
    let started: number | undefined
    function tick(now: number) {
      started ??= now
      const progress = Math.min((now - started) / 3000, 1)
      const zoom = camera().zoom
      if (zoom !== lastZoom) cameraUpdates++
      lastZoom = zoom
      peak = Math.max(peak, zoom)
      if (progress === 1) return resolve()
      // Zoom in and back out, staying below the hi-DPI relayout threshold.
      const offset = Math.sin(progress * Math.PI) * 35
      const deltaY = previousOffset - offset
      previousOffset = offset
      stage.dispatchEvent(
        new WheelEvent('wheel', {
          ctrlKey: true,
          deltaY,
          clientX: left + width / 2,
          clientY: top + height / 2,
          bubbles: true,
          cancelable: true,
        }),
      )
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  return { mounted, commits: window.zoomCommits, cameraUpdates, initial, peak }
}

describe.skipIf(!findBrowserPath())('canvas zoom commits', { timeout: 30_000 }, () => {
  const pages = pagePerTest()

  it('keeps the Stage and frame stack out of the continuous zoom path', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1280, height: 800 })
    await page.evaluateOnNewDocument(installZoomCommitCounter)

    const frames = Array.from({ length: 40 }, (_, i) =>
      canvasFrame({
        id: `frame-${i}`,
        name: `Frame ${i}`,
        x: (i % 8) * 155,
        y: Math.floor(i / 8) * 140,
        width: 130,
        height: 100,
      }),
    )
    await openCanvasPage(page, frames)
    await page.waitForFunction(() => document.querySelectorAll('[data-frame-title]').length === 40)
    const result = await page.evaluate(measureZoomCommits)
    const { commits, mounted, cameraUpdates, initial, peak } = result
    console.info('3s ctrl+wheel zoom', result)
    expect(mounted.stage).toBeGreaterThan(0)
    expect(mounted.frameStack).toBeGreaterThan(0)
    expect(mounted.frameView).toBeGreaterThan(0)
    expect(cameraUpdates).toBeGreaterThan(30)
    expect(peak).toBeGreaterThan(initial * 1.3)
    expect(peak).toBeLessThanOrEqual(1)
    expect(commits.stage).toBeLessThanOrEqual(10)
    expect(commits.frameStack).toBeLessThanOrEqual(10)
    expect(commits.frameView).toBeLessThanOrEqual(10)
  })
})

describe.skipIf(!findBrowserPath())('settled WebKit layout path', { timeout: 30_000 }, () => {
  const pages = pagePerTest()

  it('keeps visible iframe geometry and reveals a panned-to iframe at the new layout zoom', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1280, height: 800 })
    await page.evaluateOnNewDocument(() => {
      // Exercise Stage's counter-zoom path in the repository's Chromium rig.
      Object.defineProperty(navigator, 'userAgent', { value: 'Safari/605.1.15' })
    })
    await openCanvasPage(page, [
      canvasFrame({ id: 'near', name: 'Near', x: 0, y: 0, width: 300, height: 200 }),
      canvasFrame({ id: 'far', name: 'Far', x: 5000, y: 0, width: 300, height: 200 }),
    ])
    await page.waitForFunction(() => document.querySelectorAll('iframe[data-doop-frame]').length === 2)

    const result = await page.evaluate(async () => {
      const { setCamera } = window.canvasPageHarness
      const world = document.querySelector<HTMLElement>('.world')!
      const near = world.querySelector<HTMLIFrameElement>('[data-frame-layout-root="near"] iframe')!
      const far = world.querySelector<HTMLIFrameElement>('[data-frame-layout-root="far"] iframe')!
      const content = far.contentWindow
      const viewport = { x: 50, y: 100, zoom: 2 }
      setCamera(viewport)
      await new Promise(requestAnimationFrame)
      const before = near.getBoundingClientRect()
      return new Promise<{
        drift: number
        nearEffectiveZoom: number
        farEffectiveZoom: number
        wasDeferred: boolean
        revealed: boolean
        sameDocument: boolean
      }>((resolve, reject) => {
        const observer = new MutationObserver(() => {
          const k = Number(world.style.zoom)
          if (k < 2) return
          observer.disconnect()
          clearTimeout(timeout)
          const after = near.getBoundingClientRect()
          const drift = Math.max(
            ...(['x', 'y', 'width', 'height'] as const).map((key) => Math.abs(after[key] - before[key])),
          )
          const wrapper = far.parentElement!
          const wasDeferred = wrapper.style.contentVisibility === 'hidden'
          setCamera({ ...viewport, x: viewport.x - 5000 * viewport.zoom })
          resolve({
            drift,
            nearEffectiveZoom: k * Number(getComputedStyle(near).zoom),
            farEffectiveZoom: k * Number(getComputedStyle(far).zoom),
            wasDeferred,
            revealed:
              wrapper.style.contentVisibility !== 'hidden' && Math.abs(far.getBoundingClientRect().x - after.x) < 1,
            sameDocument: far.isConnected && far.contentWindow === content,
          })
        })
        const timeout = window.setTimeout(() => {
          observer.disconnect()
          reject(new Error('Layout zoom did not settle to 2×'))
        }, 5000)
        observer.observe(world, { attributes: true, attributeFilter: ['style'] })
      })
    })
    expect(result).toMatchObject({
      nearEffectiveZoom: 1,
      farEffectiveZoom: 1,
      wasDeferred: true,
      revealed: true,
      sameDocument: true,
    })
    expect(result.drift).toBeLessThan(1)
  })
})
