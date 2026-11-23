// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  canAcquireFrameSource,
  framePreviewAddress,
  frameWebSource,
  nextHtmlDevice,
} from '../src/lib/canvasFrameChrome'
import type { Frame } from '../shared/types'

const frame: Frame = {
  id: 'first screen',
  canvasId: 'board',
  name: 'Screen',
  html: '<!doctype html><h1>Example</h1>',
  x: 0,
  y: 0,
  width: 600,
  height: 500,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
}

describe('HTML browser chrome address and presets', () => {
  it('targets the full-page player with the selected frame', () => {
    const preview = new URL(framePreviewAddress(frame))
    expect(preview.pathname).toBe('/c/board/proto')
    expect(preview.searchParams.get('frame')).toBe('first screen')
  })

  it('reads the persisted import marker and skips a non-web source', () => {
    expect(frameWebSource(frame)).toBeUndefined()
    expect(
      frameWebSource({
        ...frame,
        html: '<meta name="doop-import-source" content="https%3A%2F%2Fexample.com%2Fpricing%3Fregion%3Deu">',
      }),
    ).toBe('https://example.com/pricing?region=eu')
    expect(
      frameWebSource({
        ...frame,
        html: '<meta name="doop-import-source" content="javascript%3Aalert(1)">',
      }),
    ).toBeUndefined()
  })

  it.each([
    ['http://127.0.0.1:8747/', false],
    ['http://[::1]:8747/', false],
    ['http://printer.local/', false],
    ['https://example.com/', true],
    ['https://10.example.com/', true],
  ])('limits server acquisition for %s', (url, eligible) => {
    expect(canAcquireFrameSource(url)).toBe(eligible)
  })

  it.each([
    [600, 500, 'laptop'],
    [1440, 900, 'tablet'],
    [768, 1024, 'phone'],
    [390, 844, 'laptop'],
  ])('suggests the next preset from %s × %s', (width, height, next) => {
    expect(nextHtmlDevice({ ...frame, width, height })).toBe(next)
  })
})
