import { describe, expect, it } from 'vitest'
import { DOOP_GUIDE, FRAME_STYLES } from '../server/guide'
import { systemFor } from '../server/resident'
import { AGENT_ROLES } from '../shared/agents'

describe('where frame CSS goes', () => {
  it('reaches MCP agents and every resident role in the same words', () => {
    expect(DOOP_GUIDE).toContain(FRAME_STYLES)
    for (const role of AGENT_ROLES) expect(systemFor(role)).toContain(FRAME_STYLES)
  })

  it('names what belongs in a <style> block', () => {
    for (const kept of ['@keyframes', ':hover', '::before', '@media', ':root', 'reset']) {
      expect(FRAME_STYLES).toContain(kept)
    }
  })

  it('defaults to static frames and scopes expensive effects to marked islands', () => {
    const guidance = FRAME_STYLES.replace(/\s+/g, ' ')
    for (const rule of [
      'Use static HTML + CSS by default.',
      'Put JavaScript only inside a marked `data-doop-island` element.',
      'Use one island per need. Skip GSAP and other frame-wide libraries.',
      'Keep infinite or decorative animations and blur above 8 px (in `filter` or `backdrop-filter`) inside islands only.',
      'Never apply these effects to the page background.',
      'Wrap CSS motion in `@media (prefers-reduced-motion: no-preference)`.',
      'Use CSS for scroll reveals.',
      'one tiny shared IntersectionObserver inside an island.',
      'pause islands when their frame is out of focus.',
      'Present, prototype playback and export keep the authored motion',
    ]) {
      expect(guidance).toContain(rule)
    }
    expect(FRAME_STYLES).toContain('<span data-doop-island="status">')
    expect(FRAME_STYLES).toContain('[data-doop-island="status"] .dot { animation:')
  })

  it('keeps a property that changes out of the style attribute, where it would outrank the rule', () => {
    expect(FRAME_STYLES).toContain('An inline value outranks every rule')
    expect(FRAME_STYLES).toContain('the resting value included')
  })
})
