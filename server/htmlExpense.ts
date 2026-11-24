import { parse, parseFragment, type DefaultTreeAdapterTypes as Tree } from 'parse5'

export interface HtmlExpense {
  scripts: number
  scriptsOutsideIslands: number
  infiniteAnimations: number
  infiniteOutsideIslands: number
  maxBlurPx: number
  heavyBlurOutsideIslands: number
  backdropBlur: boolean
  reducedMotionRespected: boolean
  externalScripts: number
  level: 'ok' | 'warn' | 'heavy'
  notes: string[]
}

const ISLAND = 'data-doop-island'
const MAX_STATIC_BLUR_PX = 8
const HEAVY_ANIMATION_COUNT = 3
const MAX_EXAMPLES = 3
const MAX_INLINE_CACHE_ENTRIES = 256
const EXECUTABLE_SCRIPT =
  /^(?:$|module$|(?:application|text)\/(?:x-)?(?:java|ecma)script(?:1\.[0-5])?(?:\s*;|$)|text\/(?:jscript|livescript)$)/i
const REDUCED_PREFERENCE = /\(\s*prefers-reduced-motion\s*(?::\s*reduce\s*)?\)/i
const FULL_MOTION_PREFERENCE = /\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/i
const CSS_STRINGS_AND_COMMENTS = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?(?:\*\/|$)/g
const CSS_BOUNDARIES = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\\[\s\S]|[()[\]{};]/g
const CSS_LIST_BOUNDARIES = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\\[\s\S]|[()[\],]/g
const SELECTOR_TOKENS =
  /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\\[\s\S]|\[\s*data-doop-island(?:\s*\]|\s*(?:[~|^$*]?=))|[[\]()~+]/gi
const ANIMATION_WORDS = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[-\w]+(?:\([^()]*\))?|[^\s]+/g
const NON_ANIMATION_NAME =
  /^(?:infinite|none|initial|inherit|unset|revert(?:-layer)?|normal|reverse|alternate(?:-reverse)?|forwards|backwards|both|running|paused|linear|ease(?:-in|-out|-in-out)?|step-start|step-end)$/i

type MotionPreference = 'any' | 'reduce' | 'no-preference'

type Rule = {
  target: string
  preference: MotionPreference
  shorthand?: string
  iterations?: string
  names?: string
  blur: number
  backdropBlur: boolean
}

interface Scan {
  result: HtmlExpense
  externalOutside: number
  animationExamples: Set<string>
  largestOutsideBlur?: { px: number; target: string }
  // Literal selector arms are enough to recognize a matching reduced-motion override.
  unguardedMotion: Set<string>
  reducedOverrides: Set<string>
  guardedMotion: boolean
  jsMotionGuard: boolean
}

function sample(text: string): string {
  const compact = text.slice(0, 81).replace(/\s+/g, ' ')
  return compact.length > 80 ? compact.slice(0, 79) + '…' : compact
}

/** Split CSS lists at top-level commas, leaving functions and selector attributes intact. */
function cssList(value: string): string[] {
  if (!value.includes(',')) return [value.trim()]
  const items: string[] = []
  let depth = 0
  let start = 0
  for (const match of value.matchAll(CSS_LIST_BOUNDARIES)) {
    const token = match[0]
    if (token === '(' || token === '[') depth++
    else if (token === ')' || token === ']') depth--
    else if (token === ',' && depth === 0) {
      items.push(value.slice(start, match.index).trim())
      start = match.index + 1
    }
  }
  items.push(value.slice(start).trim())
  return items
}

/** Only an affirmative island attribute on the element or a guaranteed ancestor qualifies. */
function islandSelector(selector: string): boolean {
  let depth = 0
  let scoped = false
  for (const [token] of selector.matchAll(SELECTOR_TOKENS)) {
    if (token === '(' || token === '[') depth++
    else if (token === ')' || token === ']') depth--
    else if (token[0] === '[') {
      if (depth === 0) scoped = true
      if (!token.endsWith(']')) depth++
    } else if (depth === 0 && (token === '+' || token === '~')) scoped = false
  }
  return scoped
}

function inspectDeclaration(rule: Rule, declaration: string) {
  const colon = declaration.indexOf(':')
  if (colon < 0) return
  const property = declaration
    .slice(0, colon)
    .trim()
    .toLowerCase()
    .replace(/^-(?:webkit|moz|o)-/, '')
  switch (property) {
    case 'animation':
    case 'animation-name':
    case 'animation-iteration-count': {
      const value = declaration
        .slice(colon + 1)
        .replace(/\s*!\s*important\s*$/i, '')
        .trim()
      if (property === 'animation-name') rule.names = value
      else if (property === 'animation-iteration-count') rule.iterations = value
      else {
        rule.shorthand = value
        rule.names = undefined
        rule.iterations = undefined
      }
      break
    }
    case 'filter':
    case 'backdrop-filter':
      // Strip CSS strings, so url("blur(99px)") does not count as a blur.
      for (const match of declaration
        .slice(colon + 1)
        .replace(CSS_STRINGS_AND_COMMENTS, '')
        .matchAll(/(?:^|[\s)])blur\(\s*(\+?(?:\d+(?:\.\d*)?|\.\d+))(?:px)\s*\)/gi)) {
        const radius = Number(match[1])
        if (!Number.isFinite(radius)) continue
        rule.blur = Math.max(rule.blur, radius)
        if (property === 'backdrop-filter' && radius > 0) rule.backdropBlur = true
      }
      break
  }
}

function summarizeRule(scan: Scan, rule: Rule, target = rule.target, inlineIsland?: boolean) {
  const { result } = scan
  result.maxBlurPx = Math.max(result.maxBlurPx, rule.blur)
  result.backdropBlur ||= rule.backdropBlur
  const hasAnimation = Boolean(rule.shorthand || rule.iterations || rule.names)
  const hasHeavyBlur = rule.blur > MAX_STATIC_BLUR_PX
  if (!hasAnimation && !hasHeavyBlur) return

  const selectors = inlineIsland === undefined ? cssList(target) : [target]
  const island = inlineIsland ?? (/data-doop-island/i.test(target) && selectors.every(islandSelector))
  if (hasHeavyBlur && !island) {
    result.heavyBlurOutsideIslands++
    if (!scan.largestOutsideBlur || rule.blur > scan.largestOutsideBlur.px) {
      scan.largestOutsideBlur = { px: rule.blur, target: sample(target) }
    }
  }
  if (!hasAnimation) return

  const shorthand = rule.shorthand ? cssList(rule.shorthand) : []
  const names = rule.names ? cssList(rule.names) : []
  const iterations = rule.iterations ? cssList(rule.iterations) : []
  const count = names.length || shorthand.length || iterations.length
  let motion = false
  for (let index = 0; index < count; index++) {
    const words = shorthand[index % shorthand.length]?.match(ANIMATION_WORDS) ?? []
    const name =
      names[index] ?? words.find((word) => !NON_ANIMATION_NAME.test(word) && !/^[+-]?(?:\d|\.\d)|\(/.test(word))
    const times = iterations[index % iterations.length]?.toLowerCase()
    const infinite = times ? times === 'infinite' : words.some((word) => /^infinite$/i.test(word))
    if (name?.toLowerCase() === 'none') continue
    if (infinite) {
      result.infiniteAnimations++
      if (!island) {
        result.infiniteOutsideIslands++
        if (name && scan.animationExamples.size < MAX_EXAMPLES) scan.animationExamples.add(sample(name))
      }
    }
    motion ||= infinite || Boolean(name && times !== '0' && !NON_ANIMATION_NAME.test(name))
  }
  if (rule.preference === 'reduce') {
    if (/^none$/i.test(rule.names ?? rule.shorthand ?? '') || /^0$/i.test(rule.iterations ?? '')) {
      for (const selector of selectors) scan.reducedOverrides.add(selector)
    }
  } else if (motion) {
    if (rule.preference === 'no-preference') scan.guardedMotion = true
    else for (const selector of selectors) scan.unguardedMotion.add(selector)
  }
}

function preferenceFor(prelude: string, inherited: MotionPreference): MotionPreference {
  if (!/^@media\b/i.test(prelude) || cssList(prelude).length !== 1 || /\bnot\s/i.test(prelude)) return inherited
  if (FULL_MOTION_PREFERENCE.test(prelude)) return 'no-preference'
  if (REDUCED_PREFERENCE.test(prelude)) return 'reduce'
  return inherited
}

function readCssRules(source: string, visit: (rule: Rule) => void, inline = false) {
  const css = source.includes('/*')
    ? source.replace(CSS_STRINGS_AND_COMMENTS, (token) => (token.startsWith('/*') ? ' ' : token))
    : source
  type Block = { rule?: Rule; preference: MotionPreference; skip?: boolean }
  const stack: Block[] = [
    {
      preference: 'any',
      rule: inline ? { target: '', preference: 'any', blur: 0, backdropBlur: false } : undefined,
    },
  ]
  let start = 0
  let depth = 0
  for (const match of css.matchAll(CSS_BOUNDARIES)) {
    const token = match[0]
    if (token === '(' || token === '[') depth++
    else if (token === ')' || token === ']') depth = Math.max(0, depth - 1)
    else if (depth === 0 && token.length === 1 && '{};'.includes(token)) {
      const block = stack[stack.length - 1]!
      const line = css.slice(start, match.index).trim()
      start = match.index + 1
      if (token === '{') {
        if (inline || block.skip || /^@(?:-\w+-)?keyframes\b/i.test(line)) {
          stack.push({ preference: block.preference, skip: true })
        } else if (line.startsWith('@')) {
          stack.push({ preference: preferenceFor(line, block.preference) })
        } else {
          stack.push({
            preference: block.preference,
            rule: {
              target: line,
              preference: block.preference,
              blur: 0,
              backdropBlur: false,
            },
          })
        }
      } else if (token === ';' || stack.length > 1) {
        if (block.rule) inspectDeclaration(block.rule, line)
        if (token === '}') {
          if (block.rule) visit(block.rule)
          stack.pop()
        }
      }
    }
  }
  const last = stack[stack.length - 1]!
  if (last.rule) inspectDeclaration(last.rule, css.slice(start).trim())
  for (const block of stack) {
    if (block.rule) visit(block.rule)
  }
}

function rawText(element: Tree.Element): string {
  return element.childNodes.map((child) => ('value' in child ? child.value : '')).join('')
}

function scanHtml(scan: Scan, source: string) {
  const tree = /<(?:!doctype\b|html[\s>]|body[\s>])/i.test(source) ? parse(source) : parseFragment(source)
  const inlineRules = new Map<string, Rule>()
  const stack: { children: Tree.ChildNode[]; island: boolean; next: number }[] = [
    { children: tree.childNodes, island: false, next: 0 },
  ]
  while (stack.length > 0) {
    const parent = stack[stack.length - 1]!
    if (parent.next >= parent.children.length) {
      stack.pop()
      continue
    }
    const node = parent.children[parent.next++]!
    if (!('tagName' in node) || node.tagName === 'template') continue
    const island = parent.island || node.attrs.some((attr) => attr.name === ISLAND)
    const style = node.attrs.find((attr) => attr.name === 'style')?.value
    if (style && /animation|filter/i.test(style)) {
      let rule = inlineRules.get(style)
      if (!rule) {
        readCssRules(
          style,
          (parsed) => {
            rule = parsed
          },
          true,
        )
        if (rule && inlineRules.size < MAX_INLINE_CACHE_ENTRIES) inlineRules.set(style, rule)
      }
      if (rule) {
        const id = node.attrs.find((attr) => attr.name === 'id')?.value
        summarizeRule(scan, rule, id ? '#' + id : '<' + node.tagName + ' style>', island)
      }
    }
    if (node.tagName === 'style') {
      readCssRules(rawText(node), (rule) => summarizeRule(scan, rule))
    } else if (node.tagName === 'script') {
      const type = node.attrs.find((attr) => attr.name === 'type')?.value.trim() ?? ''
      if (!EXECUTABLE_SCRIPT.test(type)) continue
      const src = node.attrs.find((attr) => attr.name === 'src' || (attr.prefix === 'xlink' && attr.name === 'href'))
      const external = Boolean(src?.value.trim())
      scan.result.scripts++
      if (external) scan.result.externalScripts++
      if (!island) {
        scan.result.scriptsOutsideIslands++
        if (external) scan.externalOutside++
      }
      if (!external) {
        scan.jsMotionGuard ||= /\bmatchMedia\s*\(\s*(['"])\s*\(\s*prefers-reduced-motion\b[^'"]*\1/i.test(rawText(node))
      }
    } else if (node.childNodes.length) {
      stack.push({ children: node.childNodes, island, next: 0 })
    }
  }
}

/** Static, advisory inspection for a frame source or incoming streaming fragment. */
export function classifyHtmlExpense(source: string): HtmlExpense {
  const result: HtmlExpense = {
    scripts: 0,
    scriptsOutsideIslands: 0,
    infiniteAnimations: 0,
    infiniteOutsideIslands: 0,
    maxBlurPx: 0,
    heavyBlurOutsideIslands: 0,
    backdropBlur: false,
    reducedMotionRespected: false,
    externalScripts: 0,
    level: 'ok',
    notes: [],
  }
  // Most static fragments have no declarations or script elements to inspect.
  if (!/<(?:style\b|script\b)|\bstyle\s*=/i.test(source)) return result
  const scan: Scan = {
    result,
    externalOutside: 0,
    animationExamples: new Set(),
    unguardedMotion: new Set(),
    reducedOverrides: new Set(),
    guardedMotion: false,
    jsMotionGuard: false,
  }
  scanHtml(scan, source)
  const uncoveredMotion = Array.from(scan.unguardedMotion).some(
    (selector) => !scan.reducedOverrides.has(selector) && !scan.reducedOverrides.has('*'),
  )
  result.reducedMotionRespected =
    !uncoveredMotion && (scan.guardedMotion || scan.unguardedMotion.size > 0 || scan.jsMotionGuard)

  const { scriptsOutsideIslands, infiniteOutsideIslands, notes } = result
  if (scriptsOutsideIslands) {
    const external = scan.externalOutside ? ' (' + scan.externalOutside + ' with src)' : ''
    notes.push(
      scriptsOutsideIslands +
        (scriptsOutsideIslands === 1 ? ' script' : ' scripts') +
        ' outside islands' +
        external +
        ': use static HTML/CSS or move JS into a data-doop-island.',
    )
  }
  if (infiniteOutsideIslands) {
    const examples = Array.from(scan.animationExamples)
    const names = examples.length
      ? ' (' + examples.join(', ') + (infiniteOutsideIslands > examples.length ? '…' : '') + ')'
      : ''
    notes.push(
      infiniteOutsideIslands +
        (infiniteOutsideIslands === 1 ? ' infinite animation' : ' infinite animations') +
        ' outside islands' +
        names +
        ': move them into a data-doop-island or make them finite.',
    )
  }
  if (scan.largestOutsideBlur) {
    const { px, target } = scan.largestOutsideBlur
    notes.push('blur ' + px + 'px on ' + target + ': keep blur ≤ ' + MAX_STATIC_BLUR_PX + 'px outside islands.')
  }
  if (uncoveredMotion)
    notes.push('Wrap CSS motion in @media (prefers-reduced-motion: no-preference) or disable it for reduced motion.')
  if (scan.largestOutsideBlur || scan.externalOutside || infiniteOutsideIslands >= HEAVY_ANIMATION_COUNT)
    result.level = 'heavy'
  else if (notes.length) result.level = 'warn'
  return result
}
