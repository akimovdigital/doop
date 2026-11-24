import { describe, expect, it } from 'vitest'
import { frameCandidate } from '../src/components/frameBudget'
import { frameAnimationPolicy } from '../src/lib/frameAnimationPolicy'
import { cheapFrameFilter, hasFrameBackdropFilter, isInfiniteAnimation } from '../src/lib/frameAnimationRuntime'

describe('motion island classifier', () => {
  it('holds infinite animations, including WAAPI effects, and leaves finite effects alone', () => {
    expect(isInfiniteAnimation({ getTiming: () => ({ iterations: Infinity }) })).toBe(true)
    expect(isInfiniteAnimation({ getTiming: () => ({ iterations: 99 }) })).toBe(false)
    expect(isInfiniteAnimation(null)).toBe(false)
  })

  it('drops only blurs at or above 8 px and preserves other functions and references', () => {
    expect(cheapFrameFilter('none')).toBeNull()
    expect(cheapFrameFilter('blur(7.99px)')).toBeNull()
    expect(cheapFrameFilter('blur(8px)')).toBe('none')
    expect(cheapFrameFilter('blur(12px) drop-shadow(rgb(0, 0, 0) 0px 4px 16px) blur(2px)')).toBe(
      'drop-shadow(rgb(0, 0, 0) 0px 4px 16px) blur(2px)',
    )
    expect(cheapFrameFilter('url("https://example.com/#blur(12px)")')).toBeNull()
  })

  it('treats even a small backdrop filter as expensive, including prefixed WebKit', () => {
    expect(hasFrameBackdropFilter('blur(2px)', '')).toBe(true)
    expect(hasFrameBackdropFilter('none', 'saturate(0.4)')).toBe(true)
    expect(hasFrameBackdropFilter('none', 'none')).toBe(false)
  })
})

describe('canvas motion policy', () => {
  const policy = (overrides: Partial<Parameters<typeof frameAnimationPolicy>[0]> = {}) =>
    frameAnimationPolicy({
      playback: false,
      active: false,
      documentAllowed: true,
      moving: false,
      visiblePixelRatio: 1,
      ...overrides,
    })

  it('leaves the document budget in control and rests islands within an allowed document', () => {
    expect(policy({ documentAllowed: false })).toEqual({
      paused: true,
      restIslands: true,
      simplifyFilters: false,
    })
    expect(policy()).toEqual({
      paused: false,
      restIslands: true,
      simplifyFilters: false,
    })
  })

  it('simplifies filters during camera movement and below a quarter of native pixels', () => {
    const frame = {
      id: 'a',
      name: 'A',
      canvasId: 'c',
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      html: '',
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'Tester',
    }
    const fraction = (x: number, zoom: number) =>
      frameCandidate(frame, { x, y: 0, zoom }, 800, 800).visiblePixelRatio
    expect(fraction(0, 0.5)).toBe(0.25)
    expect(policy({ visiblePixelRatio: fraction(0, 0.5) })?.simplifyFilters).toBe(false)
    expect(policy({ visiblePixelRatio: fraction(0, 0.49) })?.simplifyFilters).toBe(true)
    expect(policy({ visiblePixelRatio: fraction(-301, 1) })?.simplifyFilters).toBe(true)
    expect(policy({ moving: true })?.simplifyFilters).toBe(true)
  })

  it('exempts active frames and applies no policy to playback', () => {
    expect(policy({ active: true, moving: true, visiblePixelRatio: 0 })).toEqual({
      paused: false,
      restIslands: false,
      simplifyFilters: false,
    })
    expect(policy({ playback: true, documentAllowed: false, moving: true, visiblePixelRatio: 0 })).toBeNull()
  })
})
