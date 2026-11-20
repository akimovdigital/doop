import { afterEach, describe, expect, it } from 'vitest'
import { desktopPlatform, hasInsetTrafficLights, isDesktopShell, shellVersion } from '../src/lib/shell'

type Markers = {
  __DOOP_DESKTOP__?: unknown
  __DOOP_DESKTOP_PLATFORM__?: unknown
  __DOOP_DESKTOP_TRAFFIC_LIGHTS__?: unknown
}
const g = globalThis as Markers

function shell(version: unknown, platform?: unknown) {
  g.__DOOP_DESKTOP__ = version
  if (platform === undefined) delete g.__DOOP_DESKTOP_PLATFORM__
  else g.__DOOP_DESKTOP_PLATFORM__ = platform
}

afterEach(() => {
  delete g.__DOOP_DESKTOP__
  delete g.__DOOP_DESKTOP_PLATFORM__
  delete g.__DOOP_DESKTOP_TRAFFIC_LIGHTS__
})

describe('outside the shell', () => {
  it('reports no shell, version or platform', () => {
    expect(isDesktopShell()).toBe(false)
    expect(shellVersion()).toBeNull()
    expect(desktopPlatform()).toBeNull()
    expect(hasInsetTrafficLights()).toBe(false)
  })

  it('ignores a platform marker without a version marker', () => {
    g.__DOOP_DESKTOP_PLATFORM__ = 'windows'
    expect(desktopPlatform()).toBeNull()
  })
})

describe('desktopPlatform', () => {
  it('treats shells without a platform marker as macOS (they only shipped as DMGs)', () => {
    shell('0.1.3')
    expect(desktopPlatform()).toBe('macos')
  })

  it('reads the marker the shell injects', () => {
    shell('0.1.5', 'windows')
    expect(desktopPlatform()).toBe('windows')
    shell('0.1.5', 'linux')
    expect(desktopPlatform()).toBe('linux')
    shell('0.1.5', 'macos')
    expect(desktopPlatform()).toBe('macos')
  })

  it('falls back to macOS for an unknown marker value', () => {
    shell('0.1.5', 42)
    expect(desktopPlatform()).toBe('macos')
  })
})

describe('hasInsetTrafficLights', () => {
  it('reserves room for macOS window buttons in a separately versioned dev build', () => {
    shell('0.0.2', 'macos')
    g.__DOOP_DESKTOP_TRAFFIC_LIGHTS__ = true
    expect(hasInsetTrafficLights()).toBe(true)
  })

  it('respects a macOS shell that explicitly uses a native title bar', () => {
    shell('0.14.0', 'macos')
    g.__DOOP_DESKTOP_TRAFFIC_LIGHTS__ = false
    expect(hasInsetTrafficLights()).toBe(false)
  })

  it('ignores the traffic-light capability outside macOS shells', () => {
    g.__DOOP_DESKTOP_TRAFFIC_LIGHTS__ = true
    expect(hasInsetTrafficLights()).toBe(false)
    shell('0.0.2', 'windows')
    expect(hasInsetTrafficLights()).toBe(false)
  })

  it.each([
    ['0.1.1', undefined, false],
    ['0.1.2', undefined, true],
    ['0.1.3', undefined, true],
    ['0.1.10', undefined, true],
    ['0.2.0', undefined, true],
    ['1.0.0', undefined, true],
    ['0.1.5', 'macos', true],
    ['0.1.5', 'windows', false],
    ['0.1.5', 'linux', false],
    ['garbage', undefined, false],
  ])('shell %s on %s -> %s', (version, platform, expected) => {
    shell(version, platform)
    expect(hasInsetTrafficLights()).toBe(expected)
  })
})
