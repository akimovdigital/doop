import { describe, expect, it } from 'vitest'
import { orderFrameworkImports, readFrameworkData, readFrameworkMarkdown } from '../src/lib/frameworkFiles'

describe('Framework sources', () => {
  it('reads the structured DESIGN.md schema, including typed references and typography', () => {
    const tokens = readFrameworkMarkdown(`---
name: Site
colors:
  brand: "#125ace"
  accent: "{colors.brand}"
spacing:
  base: 8
  large: "clamp(1rem, 3vw, 2rem)"
typography:
  body:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.5
rounded:
  card: 12px
---
# Overview
Avoid using #ffffff in the hero.
`)
    expect(tokens).toEqual(
      expect.arrayContaining([
        { name: '--color-accent', type: 'color', value: 'var(--color-brand)' },
        { name: '--space-base', type: 'spacing', value: '8px' },
        { name: '--space-large', type: 'spacing', value: 'clamp(1rem, 3vw, 2rem)' },
        { name: '--font-body', type: 'fontFamily', value: 'Inter' },
        { name: '--text-body', type: 'fontSize', value: '1rem' },
        { name: '--font-weight-body', type: 'fontWeight', value: '400' },
        { name: '--leading-body', type: 'lineHeight', value: '1.5' },
        { name: '--radius-card', type: 'radius', value: '12px' },
      ]),
    )
    expect(tokens).toHaveLength(9)
  })

  it('accepts portable JSON and keeps the names, aliases and theme overrides', () => {
    const base = { name: '--ink', type: 'color', value: '#123', themes: { dark: '#fae' }, description: 'Text' }
    const alias = { name: '--label', type: 'color', value: 'var(--ink)' }
    expect(readFrameworkData({ tokens: [base, alias] })).toEqual([base, alias])
    expect(orderFrameworkImports(readFrameworkData({ tokens: [alias, base] }), new Set())).toEqual([base, alias])
  })

  it('reads grouped Tokens Studio and CSS-independent DTCG color and length values', () => {
    expect(
      readFrameworkData({
        color: {
          $type: 'color',
          base: { $value: { colorSpace: 'srgb', components: [1, 0, 0], alpha: 0.8 } },
          alias: { $value: '{color.base}' },
        },
        space: { small: { $type: 'dimension', $value: { value: 4, unit: 'px' } } },
        font: { text: { type: 'fontFamilies', value: 'Inter, sans-serif' } },
      }),
    ).toEqual([
      { name: '--color-base', type: 'color', value: 'color(srgb 1 0 0 / 0.8)' },
      { name: '--color-alias', type: 'color', value: 'var(--color-base)' },
      { name: '--space-small', type: 'spacing', value: '4px' },
      { name: '--font-text', type: 'fontFamily', value: 'Inter, sans-serif' },
    ])
  })

  it('skips duplicates already in a canvas and preserves a server-visible error for unresolved aliases', () => {
    const tokens = readFrameworkData({
      tokens: [
        { name: '--base', type: 'color', value: '#aaa' },
        { name: '--next', type: 'color', value: 'var(--base)' },
        { name: '--broken', type: 'color', value: 'var(--absent)' },
        { name: '--unsafe', type: 'color', value: 'red;}body{color:blue' },
      ],
    })
    expect(orderFrameworkImports(tokens, new Set(['--base'])).map((t) => t.name)).toEqual(['--next', '--broken'])
  })
})
