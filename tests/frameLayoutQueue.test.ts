// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createFrameLayoutQueue } from '../src/lib/frameLayoutQueue'

afterEach(() => vi.unstubAllGlobals())

it('keeps onscreen documents live and restores deferred documents in bounded paint batches', () => {
  let id = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
  const advance = () => {
    for (const [id, callback] of [...callbacks]) {
      callbacks.delete(id)
      callback(0)
    }
  }
  const queue = createFrameLayoutQueue()
  const wrappers = Array.from({ length: 9 }, (_, i) => {
    const wrapper = document.createElement('div')
    wrapper.dataset.frameLayoutRoot = String(i)
    wrapper.innerHTML = '<iframe></iframe>'
    return wrapper
  })
  const documents = wrappers.map((el) => el.firstElementChild)
  queue.defer(wrappers, new Set(['0']))
  expect(wrappers[0]!.style.contentVisibility).toBe('')
  expect(queue.pending).toBe(8)
  advance()
  expect(queue.pending).toBe(8)
  advance()
  expect(queue.pending).toBe(4)
  // A camera jump makes a queued frame visible before the next batch.
  queue.reveal('8')
  expect(wrappers[8]!.style.contentVisibility).toBe('')
  expect(queue.pending).toBe(3)
  advance()
  expect(queue.pending).toBe(0)
  expect(wrappers.map((el) => el.firstElementChild)).toEqual(documents)

  queue.defer(wrappers, new Set())
  queue.clear()
  expect(callbacks.size).toBe(0)
  expect(wrappers.every((el) => !el.style.contentVisibility)).toBe(true)
})
