import { cheapFrameFilter, hasFrameBackdropFilter, isInfiniteAnimation } from '../lib/frameAnimationRuntime'
import type { FrameAnimationPolicy } from '../lib/frameAnimationPolicy'
import { clearTimeout, requestAnimationFrame, setTimeout } from './timers'

/* Canvas-directed playback. Present and the standalone preview never set a policy. */
let animationSheet: CSSStyleSheet | null = null
let staticMotionSheet: CSSStyleSheet | null = null
let filterSheet: CSSStyleSheet | null = null

export function isFrameAnimationSheet(sheet: CSSStyleSheet) {
  return sheet === animationSheet || sheet === staticMotionSheet || sheet === filterSheet
}

function adoptAnimationSheet(sheet: CSSStyleSheet | null, enabled: boolean) {
  if (!sheet) return
  const sheets = document.adoptedStyleSheets
  if (enabled && !sheets.includes(sheet)) document.adoptedStyleSheets = sheets.concat(sheet)
  if (!enabled && sheets.includes(sheet))
    document.adoptedStyleSheets = sheets.filter(function (item) {
      return item !== sheet
    })
}

let frameAnimationPolicy: FrameAnimationPolicy | null = null
let staticFrameMotion = false
let animationsPaused = false
let islandsResting = false
const heldAnimations = new Set<Animation>()
const nativeAnimate = Element.prototype.animate
const nativePlay = Animation.prototype.play
const nativePause = Animation.prototype.pause
const nativeReverse = Animation.prototype.reverse
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

function settleStaticAnimation(animation: Animation) {
  const effect = animation.effect
  if (!effect || animation.playState === 'idle') return
  const timing = effect.getComputedTiming()
  if (typeof timing.activeDuration !== 'number') return
  // A reveal can start from opacity:0 even in the underlying style. Keep
  // its last keyframe visible, including when the author omitted fill-mode.
  const delay = timing.delay ?? 0
  const endpoint =
    timing.activeDuration === Infinity || animation.playbackRate < 0
      ? Math.max(0, delay)
      : Math.max(0, delay + timing.activeDuration)
  if (!Number.isFinite(endpoint)) return
  try {
    if (animation.playState !== 'paused') nativePause.call(animation)
    if (timing.fill !== 'both') effect.updateTiming({ fill: 'both' })
    if (animation.currentTime !== endpoint) animation.currentTime = endpoint
  } catch {
    /* the document keeps its current animation state */
  }
}

let staticMotionPaint = 0
function queueStaticMotionPaint() {
  if (!staticFrameMotion || staticMotionPaint) return
  staticMotionPaint = requestAnimationFrame(function () {
    staticMotionPaint = 0
    document.getAnimations().forEach(settleStaticAnimation)
  })
}
export function startStaticFrameMotion() {
  if (staticFrameMotion) return
  try {
    staticMotionSheet = new CSSStyleSheet()
    staticMotionSheet.replaceSync(
      '@layer doop-canvas-motion{*,*::before,*::after{animation-play-state:paused!important;animation-timeline:auto!important;transition:none!important}}',
    )
    adoptAnimationSheet(staticMotionSheet, true)
  } catch {
    /* the document keeps its current animation state */
  }
  staticFrameMotion = true
  Element.prototype.animate = holdNewAnimation
  Animation.prototype.play = holdPlayedAnimation
  Animation.prototype.reverse = function () {
    nativeReverse.call(this)
    settleStaticAnimation(this)
  }
  // A delayed CSS animation waits even when paused. Check changes before
  // paint so they land in their static state without an animation event.
  new MutationObserver(queueStaticMotionPaint).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  })
  window.addEventListener('resize', queueStaticMotionPaint)
  reducedMotion.addEventListener('change', queueStaticMotionPaint)
  document.addEventListener(
    'load',
    function (event) {
      if (event.target instanceof HTMLLinkElement) queueStaticMotionPaint()
    },
    true,
  )
  for (const event of ['pointerover', 'pointerout', 'pointerdown', 'pointerup', 'focusin', 'focusout', 'change']) {
    document.addEventListener(event, queueStaticMotionPaint, true)
  }
}

function shouldHoldAnimation(animation: Animation) {
  return animationsPaused || (islandsResting && isInfiniteAnimation(animation.effect))
}
function forgetHeldAnimation(this: Animation) {
  heldAnimations.delete(this)
}
function holdAnimation(animation: Animation) {
  if (staticFrameMotion) return settleStaticAnimation(animation)
  if (animation.playState !== 'running' || !shouldHoldAnimation(animation)) return
  try {
    // WAAPI pauses at the current time, including when the budget changes.
    nativePause.call(animation)
    heldAnimations.add(animation)
    animation.addEventListener('cancel', forgetHeldAnimation, { once: true })
  } catch {
    /* the document keeps its current animation state */
  }
}
function holdNewAnimation(this: Element, ...args: Parameters<Element['animate']>): Animation {
  const animation = nativeAnimate.apply(this, args)
  holdAnimation(animation)
  return animation
}
function holdPlayedAnimation(this: Animation): void {
  nativePlay.call(this)
  holdAnimation(this)
}
function rememberAuthoredPause(this: Animation): void {
  nativePause.call(this)
  heldAnimations.delete(this)
  this.removeEventListener('cancel', forgetHeldAnimation)
}
function holdNewCssAnimations(event: AnimationEvent | TransitionEvent) {
  if (!staticFrameMotion && !animationsPaused && !islandsResting) return
  const target = event.target
  if (target instanceof Element) {
    target.getAnimations({ subtree: !!event.pseudoElement }).forEach(holdAnimation)
  }
}

function refreshAnimationHolds() {
  if (staticFrameMotion) return
  const paused = frameAnimationPolicy?.paused === true
  const rest = !!frameAnimationPolicy && (frameAnimationPolicy.restIslands || reducedMotion.matches)
  if (paused === animationsPaused && rest === islandsResting) return
  const wasHolding = animationsPaused || islandsResting
  const holding = paused || rest
  animationsPaused = paused
  islandsResting = rest
  adoptAnimationSheet(animationSheet, paused)
  if (wasHolding !== holding) {
    try {
      if (holding) {
        Element.prototype.animate = holdNewAnimation
        Animation.prototype.play = holdPlayedAnimation
        Animation.prototype.pause = rememberAuthoredPause
      } else {
        if (Element.prototype.animate === holdNewAnimation) Element.prototype.animate = nativeAnimate
        if (Animation.prototype.play === holdPlayedAnimation) Animation.prototype.play = nativePlay
        if (Animation.prototype.pause === rememberAuthoredPause) Animation.prototype.pause = nativePause
      }
    } catch {
      /* the document keeps its current animation state */
    }
  }
  reconcileAnimationHolds(holding)
}

function reconcileAnimationHolds(holding: boolean) {
  // After removing the budget sheet, synchronously catch any infinite CSS
  // animations that it had paused. Otherwise the time advances between policies.
  if (holding) document.getAnimations().forEach(holdAnimation)
  heldAnimations.forEach(function (animation) {
    if (shouldHoldAnimation(animation)) return
    heldAnimations.delete(animation)
    animation.removeEventListener('cancel', forgetHeldAnimation)
    if (animation.playState === 'paused') {
      try {
        nativePlay.call(animation)
      } catch {
        /* A detached animation can no longer play. */
      }
    }
  })
}

// Structural selectors target the live element without adding attributes
// to the design. The adopted sheet never becomes part of the authored HTML.
function filterSelector(element: Element, selectors: Map<Element, string>): string {
  const cached = selectors.get(element)
  if (cached) return cached
  const parent = element.parentElement
  const selector = parent
    ? filterSelector(parent, selectors) +
      '>:nth-child(' +
      (Array.prototype.indexOf.call(parent.children, element) + 1) +
      ')'
    : ':root'
  selectors.set(element, selector)
  return selector
}

function refreshFrameFilters() {
  if (!frameAnimationPolicy?.simplifyFilters || !filterSheet) return
  // Measure the authored CSS. Batch all style reads before applying overrides.
  filterSheet.disabled = true
  const selectors = new Map<Element, string>()
  const rules: string[] = []
  document.querySelectorAll('*').forEach(function (element) {
    const style = getComputedStyle(element)
    const filter = cheapFrameFilter(style.filter)
    const backdrop = hasFrameBackdropFilter(style.backdropFilter, style.getPropertyValue('-webkit-backdrop-filter'))
    if (filter === null && !backdrop) return
    rules.push(
      filterSelector(element, selectors) +
        '{' +
        (filter !== null ? 'filter:' + filter + '!important;' : '') +
        (backdrop ? '-webkit-backdrop-filter:none!important;backdrop-filter:none!important;' : '') +
        '}',
    )
  })
  filterSheet.replaceSync('@layer doop-motion-islands{' + rules.join('') + '}')
  filterSheet.disabled = false
  adoptAnimationSheet(filterSheet, rules.length > 0)
}

let filterRefresh = 0
function queueFilterRefresh() {
  if (!frameAnimationPolicy?.simplifyFilters || filterRefresh) return
  filterRefresh = setTimeout(function () {
    filterRefresh = 0
    refreshFrameFilters()
  }, 100)
}
const filterObserver = new MutationObserver(queueFilterRefresh)
export function refreshFrameAnimationContent() {
  // CSS added by a morph may not have dispatched animationstart yet.
  if (islandsResting && !animationsPaused) reconcileAnimationHolds(true)
  queueStaticMotionPaint()
  queueFilterRefresh()
}
export function setFrameAnimationPolicy(policy: FrameAnimationPolicy | null) {
  const wasSimplifying = frameAnimationPolicy?.simplifyFilters === true
  frameAnimationPolicy = policy
  refreshAnimationHolds()
  const simplify = frameAnimationPolicy?.simplifyFilters === true
  if (simplify === wasSimplifying || !filterSheet) return
  if (simplify) {
    refreshFrameFilters()
    filterObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'id', 'style', 'hidden', 'media', 'rel', 'href'],
    })
    window.addEventListener('resize', queueFilterRefresh)
    document.addEventListener('load', refreshFiltersOnLoad, true)
  } else {
    filterObserver.disconnect()
    window.removeEventListener('resize', queueFilterRefresh)
    document.removeEventListener('load', refreshFiltersOnLoad, true)
    clearTimeout(filterRefresh)
    filterRefresh = 0
    adoptAnimationSheet(filterSheet, false)
  }
}
function refreshFiltersOnLoad(event: Event) {
  if (event.target instanceof HTMLLinkElement) queueFilterRefresh()
}

export function installAnimation(): void {
  try {
    animationSheet = new CSSStyleSheet()
    animationSheet.replaceSync(
      '@layer doop-animation-budget{*,*::before,*::after{animation-play-state:paused!important}}',
    )
    filterSheet = new CSSStyleSheet()
  } catch {
    /* Use WAAPI holds when the engine has no constructable sheets. */
  }
  window.addEventListener('animationstart', holdNewCssAnimations, true)
  window.addEventListener('transitionrun', holdNewCssAnimations, true)
  reducedMotion.addEventListener('change', refreshAnimationHolds)
}
