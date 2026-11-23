import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import type { Frame } from '../shared/types'
import type { useStore } from '../src/lib/store'
import { fixtureUrl, pagePerTest } from './browser'

type Fiber = {
  child: Fiber | null
  sibling: Fiber | null
  elementType: unknown
  memoizedProps: { frame?: Frame } | null
  flags: number
}

declare global {
  interface Window {
    frameDragPerf: {
      store: typeof useStore
      frameView: unknown
      undo(): Promise<void>
      redo(): Promise<void>
      connect(canvasId: string): void
    }
    frameRenders: string[][]
    dragWire: unknown[]
    admissionObservations: number
  }
}

const fixtureFrames = (count: number): Frame[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `f${i}`,
    canvasId: 'c',
    name: `Frame ${i}`,
    x: i < 10 ? 40 + (i % 5) * 160 : 4000 + i * 160,
    y: 80 + Math.floor(i / 5) * 130,
    width: 100,
    height: 80,
    html: '<!doctype html><p>Frame</p>',
    createdAt: i,
    updatedAt: 0,
    updatedBy: 'Tester',
  }))

describe.skipIf(!findBrowserPath())('frame drag and render subscriptions', () => {
  const pages = pagePerTest()

  async function open(frames: Frame[]) {
    const page = await pages.open()
    await page.setViewport({ width: 1000, height: 740 })
    await page.evaluateOnNewDocument(() => {
      window.frameRenders = []
      window.dragWire = []
      window.admissionObservations = 0
      const NativeObserver = window.ResizeObserver
      window.ResizeObserver = class extends NativeObserver {
        override observe(target: Element, options?: ResizeObserverOptions) {
          if (target.classList.contains('stage')) window.admissionObservations++
          super.observe(target, options)
        }
      }
      const NativeSocket = window.WebSocket
      window.WebSocket = class extends EventTarget {
        static OPEN = NativeSocket.OPEN
        readyState = NativeSocket.OPEN
        onopen: (() => void) | null = null
        constructor() {
          super()
          queueMicrotask(() => this.onopen?.())
        }
        send(raw: string) {
          const message = JSON.parse(raw)
          if (message.type === 'frame:drag') window.dragWire.push(message)
        }
      } as unknown as typeof WebSocket
      // React 18 reports commits through this hook even in the production bundle.
      // PerformedWork marks component bodies that actually ran in that commit.
      Object.assign(window, {
        __REACT_DEVTOOLS_GLOBAL_HOOK__: {
          supportsFiber: true,
          inject: () => 1,
          onCommitFiberRoot: (_renderer: number, root: { current: Fiber }) => {
            if (!window.frameDragPerf) return
            const rendered: string[] = []
            function visit(fiber: Fiber | null) {
              for (let node = fiber; node; node = node.sibling) {
                if (node.elementType === window.frameDragPerf.frameView && node.flags & 1 && node.memoizedProps?.frame)
                  rendered.push(node.memoizedProps.frame.id)
                visit(node.child)
              }
            }
            visit(root.current)
            if (rendered.length) window.frameRenders.push(rendered)
          },
        },
      })
    })
    await page.goto(fixtureUrl('frameDragPerf.html'))
    await page.waitForFunction(() => !!window.frameDragPerf)
    await page.evaluate((frames) => {
      const { store, connect } = window.frameDragPerf
      store.getState().setCanvas({ id: 'c', name: 'Perf', frames, createdAt: 0, updatedAt: 0 })
      connect('c')
    }, frames)
    await page.waitForFunction(
      (count) => document.querySelectorAll('[data-frame-surface]').length === count,
      {},
      frames.length,
    )
    await page.waitForFunction(() => document.querySelectorAll('iframe').length >= 10)
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    )
    return page
  }

  it('moves ten frames in one store commit per paint and preserves drag, save, undo and redo traffic', async () => {
    const frames = fixtureFrames(10)
    const page = await open(frames)
    const writes: { id: string; patch: Partial<Frame> }[] = []
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      const id = new URL(request.url()).pathname.match(/^\/api\/frames\/(f\d+)$/)?.[1]
      const frame = frames.find((frame) => frame.id === id)
      if (frame && request.method() === 'PATCH') {
        const { actor, ...patch } = JSON.parse(request.postData()!)
        expect(actor.clientId).toEqual(expect.any(String))
        writes.push({ id: frame.id, patch })
        Object.assign(frame, patch)
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(frame) })
      } else await request.continue()
    })
    const result = await page.evaluate(async () => {
      const { store } = window.frameDragPerf
      const ids = store.getState().canvas!.frames.map((f) => f.id)
      store.getState().selectMany(ids)
      const label = [...document.querySelectorAll('span')].find((el) => el.textContent === 'Frame 0')!
      const pointer = (type: string, d: number) =>
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          pointerType: 'mouse',
          clientX: 60 + d,
          clientY: 65 + d,
          altKey: true,
        })
      label.dispatchEvent(pointer('pointerdown', 0))
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      window.frameRenders = []
      let commits = 0
      const off = store.subscribe(() => commits++)
      // A clock with exactly 50 ms between input samples makes the WS
      // throttle deterministic while the browser paints a real two-second drag.
      const realNow = Date.now
      let now = realNow()
      Date.now = () => now
      try {
        for (let step = 1; step <= 40; step++) {
          for (const d of [step * 2 - 1, step * 2]) {
            now += 50
            window.dispatchEvent(pointer('pointermove', d))
          }
          await Promise.all([
            new Promise((resolve) => setTimeout(resolve, 50)),
            new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
          ])
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      } finally {
        Date.now = realNow
        off()
      }
      const result = { commits, reactCommits: window.frameRenders.length, wire: window.dragWire }
      window.dispatchEvent(pointer('pointerup', 80))
      return result
    })
    console.info('Two-second drag:', { storeCommits: result.commits, reactCommits: result.reactCommits })
    const rect = ({ x, y, width, height }: Frame, d: number) => ({ x: x + d, y: y + d, width, height })
    const original = fixtureFrames(10)
    expect(result.wire).toEqual(
      Array.from({ length: 80 }, (_, i) =>
        original.map((f) => ({ type: 'frame:drag', frameId: f.id, ...rect(f, i + 1) })),
      ).flat(),
    )
    const patches = (d: number, sizes = false) =>
      original.map((f) => ({
        id: f.id,
        patch: sizes ? rect(f, d) : { x: f.x + d, y: f.y + d },
      }))
    await expect.poll(() => writes).toEqual(patches(80, true))
    await page.evaluate(() => window.frameDragPerf.undo())
    expect(writes).toEqual([...patches(80, true), ...patches(0)])
    await page.evaluate(() => window.frameDragPerf.undo())
    expect(writes).toHaveLength(20)
    await page.evaluate(() => window.frameDragPerf.redo())
    expect(writes).toEqual([...patches(80, true), ...patches(0), ...patches(80)])
    expect(result.commits).toBe(40)
    expect(result.reactCommits).toBeGreaterThan(0)
    expect(result.reactCommits).toBeLessThanOrEqual(40)
  }, 60_000)

  it('only renders the frames concerned by a presence and keeps admission attached during geometry changes', async () => {
    const page = await open(fixtureFrames(68))
    const result = await page.evaluate(async () => {
      const { store } = window.frameDragPerf
      const paint = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      async function renders(change: () => void) {
        window.frameRenders = []
        change()
        await paint()
        return [...new Set(window.frameRenders.flat())].sort()
      }
      const s = store.getState()
      const before = window.admissionObservations
      for (let x = 41; x < 46; x++) {
        s.patchFrameLocal('f0', { x })
        await paint()
      }
      const observations = window.admissionObservations - before
      const editing = await renders(() =>
        s.upsertPresence({ clientId: 'peer', name: 'Agent', color: '#f00', kind: 'agent', activeFrameId: 'f0' }),
      )
      const status = await renders(() => s.setStatus('peer', 'Working'))
      const moved = await renders(() => s.setEditing('peer', 'f1'))
      const comment = await renders(() =>
        s.upsertComment({
          id: 'comment',
          canvasId: 'c',
          frameId: 'f2',
          x: 25,
          y: 25,
          snippet: '',
          from: 'Peer',
          text: 'Comment',
          at: 1,
        }),
      )
      const flash = await renders(() => s.flash('f3', '#f00'))
      s.patchFrameLocal('f10', { x: 910, y: 80 })
      return { editing, status, moved, comment, flash, observations }
    })
    console.info('68-frame canvas:', {
      editing: result.editing.length,
      status: result.status.length,
      moved: result.moved.length,
      observations: result.observations,
    })
    expect(result.editing).toEqual(['f0'])
    expect(result.status).toEqual(['f0'])
    expect(result.moved).toEqual(['f0', 'f1'])
    expect(result.comment).toEqual(['f2'])
    expect(result.flash).toEqual(['f3'])
    expect(result.observations).toBe(0)
    await page.waitForSelector('[data-doop-frame-shell="f10"] iframe')
  }, 60_000)
})
