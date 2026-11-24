import { describe, expect, it } from 'vitest'
import { classifyHtmlExpense } from '../server/htmlExpense.ts'

describe('classifyHtmlExpense', () => {
  it('classifies a 400 KB document within 20 ms of CPU time at the warmed median', () => {
    const section = '<article><div class="card" style="filter: blur(4px)">A card with regular body text</div></article>'
    const start = '<!doctype html><style>.hero{animation: pulse 2s infinite;filter:blur(46px)}</style><main>'
    const end = '</main>'
    const body = section.repeat(Math.floor((400_000 - start.length - end.length) / section.length))
    const html = start + body + ' '.repeat(400_000 - start.length - end.length - body.length) + end
    expect(classifyHtmlExpense(html)).toMatchObject({ level: 'heavy', maxBlurPx: 46, infiniteAnimations: 1 })

    const samples = Array.from({ length: 7 }, () => {
      const started = process.cpuUsage()
      classifyHtmlExpense(html)
      const { user, system } = process.cpuUsage(started)
      return (user + system) / 1000
    }).sort((a, b) => a - b)
    const median = samples[3]!
    expect(median, '400 KB classifier median CPU time in ms').toBeLessThan(20)
  })

  it('leaves static HTML quiet and ignores examples, comments and inert scripts', () => {
    const html = `<!doctype html><!-- <script src="fake.js"></script> -->
      <textarea><script src="fake.js"></script></textarea>
      <template><div style="filter: blur(80px)"></div></template>
      <script type="application/ld+json">{"name":"Doop"}</script>
      <style>/* .fake { animation: f infinite; } */ .demo::before { content: 'filter:blur(80px)'; }</style>
      <div style="filter: blur(8px)">Design</div>`
    expect(classifyHtmlExpense(html)).toMatchObject({
      level: 'ok',
      notes: [],
      scripts: 0,
      infiniteAnimations: 0,
      maxBlurPx: 8,
      backdropBlur: false,
    })
  })

  it('warns about a single infinite animation in a streaming fragment', () => {
    const result = classifyHtmlExpense(`<section style="animation: hop 2s steps(2, end) infinite">Next section`)
    expect(result).toMatchObject({ level: 'warn', infiniteAnimations: 1, infiniteOutsideIslands: 1 })
    expect(result.notes.join(' ')).toMatch(/hop.*data-doop-island/)
  })

  it('reports heavy filter and backdrop-filter declarations in sheets and inline styles', () => {
    const result = classifyHtmlExpense(`
      <style>@supports (filter: blur(1px)) {
        .hero::before { animation: wave-flow 2s infinite, drift 3s infinite; filter: blur(46px); }
      }</style>
      <div id="glass" style="-webkit-backdrop-filter: saturate(110%) blur(12px);
        animation-name: pulse, idle; animation-iteration-count: infinite, 2"></div>`)
    expect(result).toMatchObject({
      level: 'heavy',
      infiniteAnimations: 3,
      infiniteOutsideIslands: 3,
      maxBlurPx: 46,
      heavyBlurOutsideIslands: 2,
      backdropBlur: true,
    })
    const notes = result.notes.join(' ')
    expect(notes).toMatch(/3 infinite animations.*wave-flow.*drift.*pulse/)
    expect(notes).toMatch(/blur 46px on \.hero::before/)
  })

  it('accepts marked island descendants and explicitly scoped selector lists', () => {
    const result = classifyHtmlExpense(`
      <style>@media (prefers-reduced-motion: no-preference) {
        [data-doop-island="first"] .dot, [data-doop-island].dot::after {
          animation: pulse 2s infinite; filter: blur(20px);
        }
      }</style>
      <section data-doop-island><div><span style="filter: blur(30px)"></span></div>
        <script src="./motion.js"></script></section>`)
    expect(result).toMatchObject({
      level: 'ok',
      notes: [],
      scripts: 1,
      externalScripts: 1,
      scriptsOutsideIslands: 0,
      infiniteAnimations: 1,
      infiniteOutsideIslands: 0,
      maxBlurPx: 30,
      heavyBlurOutsideIslands: 0,
      reducedMotionRespected: true,
    })
  })

  it('flags script sources and selector arms that can escape islands', () => {
    const result = classifyHtmlExpense(`
      <div data-doop-island><div></div></div><script src="https://example.test/motion.js"></script>
      <style>
        :not([data-doop-island]), [data-doop-island] + .neighbor { filter: blur(9px); }
        [data-doop-island] .dot, .unstamped { animation: wave 2s infinite; }
      </style>`)
    expect(result).toMatchObject({
      level: 'heavy',
      scripts: 1,
      externalScripts: 1,
      scriptsOutsideIslands: 1,
      infiniteOutsideIslands: 1,
      heavyBlurOutsideIslands: 1,
      reducedMotionRespected: false,
    })
  })

  it('detects a reduced-motion override for the animated selector', () => {
    const protectedMotion = `<style>.dot { animation: wobble 2s infinite }
      @media (prefers-reduced-motion: reduce) { .dot { animation: none !important } }</style>`
    expect(classifyHtmlExpense(protectedMotion).reducedMotionRespected).toBe(true)
    expect(
      classifyHtmlExpense(protectedMotion.replace('.dot { animation: none', '.other { animation: none'))
        .reducedMotionRespected,
    ).toBe(false)
    expect(
      classifyHtmlExpense('<style>/* @media (prefers-reduced-motion: reduce) */</style>').reducedMotionRespected,
    ).toBe(false)
  })
})
