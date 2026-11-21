import { parse as parseYaml } from 'yaml'
import {
  aliasOf,
  isThemeName,
  isTokenName,
  isTokenType,
  MAX_TOKEN_DESCRIPTION,
  MAX_TOKENS,
  normalizeTokenName,
  normalizeTokenValue,
  referencedTokens,
  type DesignTokenInput,
  type TokenType,
} from '../../shared/designTokens'

export const FRAMEWORK_FILE_LIMIT = 5_000_000

const prefix: Record<TokenType, string> = {
  color: 'color',
  opacity: 'opacity',
  radius: 'radius',
  spacing: 'space',
  container: 'container',
  breakpoint: 'breakpoint',
  fontFamily: 'font',
  fontWeight: 'font-weight',
  fontSize: 'text',
  lineHeight: 'leading',
  letterSpacing: 'tracking',
}

const typeAliases: Record<string, TokenType> = {
  dimension: 'spacing',
  fontFamilies: 'fontFamily',
  fontWeights: 'fontWeight',
  fontSizes: 'fontSize',
  lineHeights: 'lineHeight',
  borderRadius: 'radius',
  sizing: 'spacing',
}

const typePatterns: [TokenType, RegExp][] = [
  ['fontWeight', /^(font-weight|weight)(-|$)/],
  ['color', /^text-color(-|$)/],
  ['fontSize', /^(text|type|font-size)(-|$)/],
  ['fontFamily', /^(font|family)(-|$)/],
  ['lineHeight', /^(leading|line-height)(-|$)/],
  ['letterSpacing', /^(tracking|letter-spacing)(-|$)/],
  ['spacing', /^(space|spacing|size|gap|pad|padding|margin)(-|$)/],
  ['radius', /^(radius|round|rounded)(-|$)/],
  ['opacity', /^(alpha|opacity)(-|$)/],
  ['container', /^container(-|$)/],
  ['breakpoint', /^(screen|breakpoint)(-|$)/],
  ['color', /^(color|ink|surface|brand|primary|secondary|accent|bg|border|text-color)(-|$)/],
]

const dimensions = new Set<TokenType>(['radius', 'spacing', 'container', 'breakpoint', 'fontSize', 'letterSpacing'])
const typography = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing'] as const

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function tokenType(type: unknown): TokenType | undefined {
  return isTokenType(type)
    ? type
    : typeof type === 'string' && Object.hasOwn(typeAliases, type)
      ? typeAliases[type]
      : undefined
}

function inferType(name: string, value: string): TokenType | undefined {
  if (typeof CSS !== 'undefined' && !/^var\(/i.test(value) && CSS.supports('color', value)) return 'color'
  return (
    typePatterns.find(([, pattern]) => pattern.test(name.replace(/^--/, '').toLowerCase()))?.[0] ??
    (name.includes('spacing') ? 'spacing' : undefined)
  )
}

function safeValue(value: unknown): string | null {
  const css = normalizeTokenValue(value)
  return css && !/\burl\s*\(/i.test(css) ? css : null
}

function token(
  name: string,
  type: TokenType,
  value: unknown,
  options?: Record<string, unknown>,
): DesignTokenInput | null {
  const css = safeValue(value)
  if (!css || !isTokenName(name)) return null
  const themes = Object.fromEntries(
    Object.entries(record(options?.themes) ?? {}).flatMap(([key, raw]) => {
      const value = safeValue(raw)
      return isThemeName(key) && value ? [[key, value]] : []
    }),
  )
  return {
    name,
    type,
    value: css,
    ...(Object.keys(themes).length ? { themes } : {}),
    ...(typeof options?.description === 'string'
      ? { description: options.description.slice(0, MAX_TOKEN_DESCRIPTION) }
      : {}),
  }
}

function portableValue(value: unknown, type: TokenType): unknown {
  if (typeof value === 'number' && dimensions.has(type)) return `${value}px`
  if (type === 'fontFamily' && Array.isArray(value) && value.every((x) => typeof x === 'string'))
    return value.join(', ')
  const object = record(value)
  if (!object) return value
  if (typeof object.value === 'number' && typeof object.unit === 'string') return `${object.value}${object.unit}`
  if (typeof object.hex === 'string' && object.alpha === undefined) return object.hex
  if (type === 'color' && typeof object.colorSpace === 'string' && Array.isArray(object.components)) {
    const components = object.components
    const alpha = typeof object.alpha === 'number' ? object.alpha : 1
    if (components.length !== 3 || components.some((x) => typeof x !== 'number' && x !== 'none')) return null
    const space = object.colorSpace
    const args = `${components.join(' ')}${alpha === 1 ? '' : ` / ${alpha}`}`
    if (['hsl', 'hwb', 'lab', 'lch', 'oklab', 'oklch'].includes(space)) {
      const channels = components.map((channel, index) =>
        typeof channel === 'number' && (space === 'hsl' || space === 'hwb') && index > 0 ? `${channel}%` : channel,
      )
      return `${space}(${channels.join(' ')}${alpha === 1 ? '' : ` / ${alpha}`})`
    }
    if (
      ['srgb', 'srgb-linear', 'display-p3', 'a98-rgb', 'prophoto-rgb', 'rec2020', 'xyz', 'xyz-d50', 'xyz-d65'].includes(
        space,
      )
    )
      return `color(${space} ${args})`
  }
  return null
}

type Candidate = { path: string; name: string; type: TokenType; value: unknown; options?: Record<string, unknown> }

function structuredTokens(candidates: Candidate[]): DesignTokenInput[] {
  const byPath = new Map(candidates.map(({ path, name }) => [path, name]))
  return candidates.flatMap(({ name, type, value, options }) => {
    const reference = typeof value === 'string' ? /^\{([^{}]+)\}$/.exec(value.trim())?.[1] : undefined
    const cssName = reference && byPath.get(reference)
    const result = token(
      name,
      type,
      reference ? (cssName ? `var(${cssName})` : null) : portableValue(value, type),
      options,
    )
    return result ? [result] : []
  })
}

function cssName(path: string[], type: TokenType): string {
  const namespace = prefix[type]
  const custom = path.length === 1 && path[0]?.startsWith('--')
  if (custom) return normalizeTokenName(path[0])
  const name = path
    .join('-')
    .replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `--${name.startsWith(`${namespace}-`) ? name : `${namespace}-${name}`}`
}

/** Structured DESIGN.md, Doop exchange JSON and common DTCG / Tokens Studio tokens. */
export function readFrameworkData(value: unknown): DesignTokenInput[] {
  const root = record(value)
  const rows = Array.isArray(value) ? value : root?.tokens
  if (Array.isArray(rows)) {
    return rows.slice(0, MAX_TOKENS).flatMap((raw) => {
      const row = record(raw)
      const type = tokenType(row?.type)
      const item = type ? token(normalizeTokenName(row?.name), type, row?.value, row ?? undefined) : null
      return item ? [item] : []
    })
  }

  const candidates: Candidate[] = []
  function visit(value: unknown, path: string[], namePath: string[], inherited?: TokenType, stitchType?: TokenType) {
    if (path.length > 12 || candidates.length >= MAX_TOKENS) return
    const obj = record(value)
    const type = tokenType(obj?.$type ?? obj?.type) ?? inherited ?? stitchType
    const add = (path: string[], name: string, type: TokenType, value: unknown, options?: Record<string, unknown>) => {
      if (candidates.length < MAX_TOKENS) candidates.push({ path: path.join('.'), name, type, value, options })
    }
    if (obj && ('$value' in obj || ('value' in obj && type))) {
      if (!type) return
      const raw = obj.$value ?? obj.value
      add(path, cssName(namePath, type), type, raw, { description: obj.$description ?? obj.description })
    } else if (obj) {
      for (const [key, child] of Object.entries(obj)) {
        if (!key.startsWith('$')) visit(child, [...path, key], [...namePath, key], type, stitchType)
      }
    } else if (stitchType && (typeof value === 'string' || typeof value === 'number')) {
      add(path, cssName(namePath, stitchType), stitchType, value)
    }
  }

  function visitTypography(value: unknown, path: string[]) {
    if (path.length > 12 || candidates.length >= MAX_TOKENS) return
    for (const [key, child] of Object.entries(record(value) ?? {})) {
      const type = typography.find((name) => name === key)
      if (type && (typeof child === 'number' || typeof child === 'string')) {
        candidates.push({ path: ['typography', ...path, key].join('.'), name: cssName(path, type), type, value: child })
      } else if (record(child)) visitTypography(child, [...path, key])
    }
  }

  for (const [name, child] of Object.entries(root ?? {})) {
    if (name === 'typography' && !record(child)?.$type) visitTypography(child, [])
    else if (name === 'colors' || name === 'spacing' || name === 'rounded') {
      const type = name === 'colors' ? 'color' : name === 'spacing' ? 'spacing' : 'radius'
      visit(child, [name], [], type, type)
    } else if (!name.startsWith('$')) visit(child, [name], [name], tokenType(root?.$type))
  }
  return structuredTokens(candidates)
}

/** CSSOM parses declarations without applying the sheet or resolving @imports. */
export function readFrameworkCss(css: string): DesignTokenInput[] {
  const sheet = new CSSStyleSheet()
  const defaultVariables = new Map<string, string>()
  const overrides = new Map<string, Record<string, string>>()
  if (css.length > FRAMEWORK_FILE_LIMIT) return []
  sheet.replaceSync(css.replace(/@theme(?:\s+[\w-]+)*\s*\{/g, ':root {'))
  function visit(rules: CSSRuleList, theme?: string) {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule && /^\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/i.test(rule.conditionText)) {
        visit(rule.cssRules, 'dark')
      } else if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) {
        visit(rule.cssRules, theme)
      } else if (rule instanceof CSSStyleRule) {
        const mode = rule.selectorText
          .split(',')
          .flatMap(
            (selector) =>
              /^(?::root|html|body)?\[data-(?:doop-)?theme=["']?([a-z0-9-]+)["']?\]$/.exec(selector.trim())?.[1] ?? [],
          )[0]
        const root = rule.selectorText.split(',').some((selector) => /^(:root|html|body)$/i.test(selector.trim()))
        const themeName = mode ?? theme
        if (!root && !mode) continue
        for (const prop of rule.style) {
          if (!isTokenName(prop)) continue
          const value = safeValue(rule.style.getPropertyValue(prop))
          if (!value) continue
          if (isThemeName(themeName)) overrides.set(prop, { ...overrides.get(prop), [themeName]: value })
          else if (root) defaultVariables.set(prop, value)
        }
      }
    }
  }
  visit(sheet.cssRules)
  function infer(name: string, value: string, seen = new Set<string>()): TokenType | undefined {
    if (seen.has(name)) return
    seen.add(name)
    const target = aliasOf(value)
    const targetValue = target ? defaultVariables.get(target) : undefined
    return inferType(name, value) ?? (target && targetValue ? infer(target, targetValue, seen) : undefined)
  }
  return [...defaultVariables].slice(0, MAX_TOKENS).flatMap(([name, value]) => {
    const type = infer(name, value)
    const item = type ? token(name, type, value, { themes: overrides.get(name) }) : null
    return item ? [item] : []
  })
}

const frameProperties: [TokenType, readonly string[]][] = [
  ['color', ['color', 'background-color', 'border-top-color', 'fill', 'stroke']],
  ['fontFamily', ['font-family']],
  ['fontSize', ['font-size']],
  ['fontWeight', ['font-weight']],
  ['lineHeight', ['line-height']],
  ['letterSpacing', ['letter-spacing']],
  ['spacing', ['gap', 'row-gap', 'column-gap', 'padding-top', 'padding-left', 'margin-top', 'margin-left']],
  ['radius', ['border-top-left-radius']],
]

/** Fall back to declared style values on frames that do not carry any named variables.
 * Counts favour values repeated in the design and keep the preview bounded. */
function observeFrameStyles(root: DocumentFragment, css: string): DesignTokenInput[] {
  const counts = new Map<TokenType, Map<string, number>>()
  function observe(style: CSSStyleDeclaration) {
    for (const [type, props] of frameProperties) {
      for (const prop of props) {
        const value = safeValue(style.getPropertyValue(prop))
        if (!value || /^var\(|^(inherit|initial|unset|currentcolor|transparent|none|normal|auto|0|0px)$/i.test(value))
          continue
        if (type === 'color' && !CSS.supports('color', value)) continue
        const values = counts.get(type) ?? new Map<string, number>()
        values.set(value, (values.get(value) ?? 0) + 1)
        counts.set(type, values)
      }
    }
  }
  const style = new CSSStyleSheet()
  style.replaceSync(css)
  for (const rule of style.cssRules) if (rule instanceof CSSStyleRule) observe(rule.style)
  for (const node of root.querySelectorAll<HTMLElement | SVGElement>('[style]')) {
    if (node.style) observe(node.style)
  }
  return [...counts].flatMap(([type, values]) =>
    [...values]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([value]) => {
        const slug =
          value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 64) || 'value'
        let hash = 0
        for (let index = 0; index < value.length; index++) hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0
        return { name: `--${prefix[type]}-frame-${slug}-${(hash >>> 0).toString(36)}`, type, value }
      }),
  )
}

export function readFrameFramework(html: string): DesignTokenInput[] {
  if (!html || html.length > FRAMEWORK_FILE_LIMIT) return []
  const inert = document.createElement('template')
  inert.innerHTML = html
  const css = [...inert.content.querySelectorAll('style:not([data-doop-tokens])')]
    .map((style) => style.textContent)
    .join('\n')
  const variables = readFrameworkCss(css)
  return variables.length ? variables : observeFrameStyles(inert.content, css)
}

export function readFrameworkMarkdown(markdown: string): DesignTokenInput[] {
  const sections: DesignTokenInput[][] = []
  const yamlHeader = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?$/m.exec(markdown)
  if (yamlHeader?.index === 0 && yamlHeader[1]) {
    sections.push(readFrameworkData(parseYaml(yamlHeader[1], { maxAliasCount: 0 })))
  }
  for (const [, language, body] of markdown.matchAll(/^```(css|json|ya?ml)[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gim)) {
    if (!body) continue
    const kind = language?.toLowerCase()
    sections.push(
      kind === 'css'
        ? readFrameworkCss(body)
        : readFrameworkData(kind === 'json' ? JSON.parse(body) : parseYaml(body, { maxAliasCount: 0 })),
    )
  }
  return [...new Map(sections.flat().map((item) => [item.name, item])).values()].slice(0, MAX_TOKENS)
}

export function readFrameworkFile(name: string, data: string): DesignTokenInput[] {
  const suffix = name.toLowerCase().split('.').at(-1)
  if (suffix === 'html' || suffix === 'htm') return readFrameFramework(data)
  if (suffix === 'css') return readFrameworkCss(data)
  if (suffix === 'md' || suffix === 'markdown') return readFrameworkMarkdown(data)
  if (suffix === 'yaml' || suffix === 'yml') return readFrameworkData(parseYaml(data, { maxAliasCount: 0 }))
  if (suffix === 'json') return readFrameworkData(JSON.parse(data))
  return []
}

/** The write API validates each entry against the preceding entries. Put alias targets first. */
export function orderFrameworkImports(inputs: DesignTokenInput[], existing: ReadonlySet<string>): DesignTokenInput[] {
  const waiting = new Map(inputs.filter((item) => !existing.has(item.name)).map((item) => [item.name, item]))
  const ordered: DesignTokenInput[] = []
  const walking = new Set<string>()
  function walk(name: string) {
    const entry = waiting.get(name)
    if (!entry || walking.has(name)) return
    walking.add(name)
    for (const value of [entry.value, ...Object.values(entry.themes ?? {})]) {
      for (const reference of referencedTokens(value)) walk(reference)
    }
    walking.delete(name)
    waiting.delete(name)
    ordered.push(entry)
  }
  for (const name of waiting.keys()) walk(name)
  return ordered
}
