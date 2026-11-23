import { describe, expect, it } from 'vitest'
import { normalizeBrowserUrl, browserViewport, browserDeviceSize } from '../shared/browserFrame'

describe('browser frame addresses', () => {
  it.each([
    ['127.0.0.1:8747', 'http://127.0.0.1:8747/'],
    ['localhost:3000/path', 'http://localhost:3000/path'],
    ['example.com', 'https://example.com/'],
    ['example.com:8443/path', 'https://example.com:8443/path'],
    ['/example', 'http://127.0.0.1:4437/example'],
    ['javascript:alert(1)', null],
    ['file:///tmp/index.html', null],
    ['data:text/html,hello', null],
    ['https://username:password@example.com', null],
    ['', ''],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeBrowserUrl(input, 'http://127.0.0.1:4437/canvas')).toBe(expected)
  })
})

describe('browser frame viewport', () => {
  it('lays out a zoomed page against the unscaled viewport', () => {
    expect(browserViewport(1440, 900, 1.5)).toEqual({ width: 960, height: 600 })
  })

  it('uses preset sizes and keeps the current size in responsive mode', () => {
    const size = { width: 800, height: 600 }
    expect(browserDeviceSize(undefined, size)).toEqual(size)
    expect(browserDeviceSize('laptop', size)).toEqual({ width: 1440, height: 900 })
    expect(browserDeviceSize('tablet', size)).toEqual({ width: 768, height: 1024 })
    expect(browserDeviceSize('phone', size)).toEqual({ width: 390, height: 844 })
  })
})
