export function isInfiniteAnimation(effect: Pick<AnimationEffect, 'getTiming'> | null): boolean {
  return effect?.getTiming().iterations === Infinity
}

/** Computed blur lengths are in px. Preserve other functions and quoted URLs. */
export function cheapFrameFilter(filter: string): string | null {
  const cheaper = filter.replace(
    /url\("(?:\\.|[^"\\])*"\)|\bblur\(\s*(\d*\.?\d+)px\s*\)/g,
    (part, radius: string | undefined) => (radius !== undefined && Number(radius) >= 8 ? '' : part),
  )
  return cheaper === filter ? null : cheaper.trim() || 'none'
}

export function hasFrameBackdropFilter(backdrop: string, webkitBackdrop: string): boolean {
  return Boolean((backdrop && backdrop !== 'none') || (webkitBackdrop && webkitBackdrop !== 'none'))
}

/** Canvas-directed playback inside the existing opaque-origin frame sandbox. */
export const FRAME_ANIMATION_RUNTIME = `
  var isInfiniteAnimation = (${isInfiniteAnimation.toString()})
  var cheapFrameFilter = (${cheapFrameFilter.toString()})
  var hasFrameBackdropFilter = (${hasFrameBackdropFilter.toString()})
  var animationSheet = null
  var filterSheet = null
  try {
    animationSheet = new CSSStyleSheet()
    animationSheet.replaceSync('@layer doop-animation-budget{*,*::before,*::after{animation-play-state:paused!important}}')
    filterSheet = new CSSStyleSheet()
  } catch (e) {}

  function isFrameAnimationSheet(sheet) {
    return sheet === animationSheet || sheet === filterSheet
  }

  function adoptAnimationSheet(sheet, enabled) {
    if (!sheet) return
    var sheets = document.adoptedStyleSheets
    if (enabled && !sheets.includes(sheet)) document.adoptedStyleSheets = sheets.concat(sheet)
    if (!enabled && sheets.includes(sheet)) document.adoptedStyleSheets = sheets.filter(function (item) { return item !== sheet })
  }

  var frameAnimationPolicy = null
  var animationsPaused = false
  var islandsResting = false
  var heldAnimations = new Set()
  var nativeAnimate = Element.prototype.animate
  var nativePlay = Animation.prototype.play
  var nativePause = Animation.prototype.pause
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  function shouldHoldAnimation(animation) {
    return animationsPaused || (islandsResting && isInfiniteAnimation(animation.effect))
  }
  function forgetHeldAnimation() {
    heldAnimations.delete(this)
  }
  function holdAnimation(animation) {
    if (animation.playState !== 'running' || !shouldHoldAnimation(animation)) return
    try {
      // WAAPI pauses at the current time, including when the budget changes.
      nativePause.call(animation)
      heldAnimations.add(animation)
      animation.addEventListener('cancel', forgetHeldAnimation, { once: true })
    } catch (e) {}
  }
  function holdNewAnimation() {
    var animation = nativeAnimate.apply(this, arguments)
    holdAnimation(animation)
    return animation
  }
  function holdPlayedAnimation() {
    nativePlay.apply(this, arguments)
    holdAnimation(this)
  }
  function rememberAuthoredPause() {
    nativePause.apply(this, arguments)
    heldAnimations.delete(this)
    this.removeEventListener('cancel', forgetHeldAnimation)
  }
  function holdNewCssAnimations(event) {
    if (!animationsPaused && !islandsResting) return
    var target = event.target
    if (target && typeof target.getAnimations === 'function') {
      target.getAnimations({ subtree: !!event.pseudoElement }).forEach(holdAnimation)
    }
  }
  window.addEventListener('animationstart', holdNewCssAnimations, true)
  window.addEventListener('transitionrun', holdNewCssAnimations, true)

  function refreshAnimationHolds() {
    var paused = frameAnimationPolicy?.paused === true
    var rest = !!frameAnimationPolicy && (frameAnimationPolicy.restIslands || reducedMotion.matches)
    if (paused === animationsPaused && rest === islandsResting) return
    var wasHolding = animationsPaused || islandsResting
    var holding = paused || rest
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
      } catch (e) {}
    }
    reconcileAnimationHolds(holding)
  }

  function reconcileAnimationHolds(holding) {
    // After removing the budget sheet, synchronously catch any infinite CSS
    // animations that it had paused. Otherwise the time advances between policies.
    if (holding) document.getAnimations().forEach(holdAnimation)
    heldAnimations.forEach(function (animation) {
      if (shouldHoldAnimation(animation)) return
      heldAnimations.delete(animation)
      animation.removeEventListener('cancel', forgetHeldAnimation)
      if (animation.playState === 'paused') {
        try { nativePlay.call(animation) } catch (e) {}
      }
    })
  }
  reducedMotion.addEventListener('change', refreshAnimationHolds)

  // Structural selectors target the live element without adding attributes
  // to the design. The adopted sheet never becomes part of the authored HTML.
  function filterSelector(element, selectors) {
    if (selectors.has(element)) return selectors.get(element)
    var parent = element.parentElement
    var selector = parent
      ? filterSelector(parent, selectors) + '>:nth-child(' + (Array.prototype.indexOf.call(parent.children, element) + 1) + ')'
      : ':root'
    selectors.set(element, selector)
    return selector
  }

  function refreshFrameFilters() {
    if (!frameAnimationPolicy?.simplifyFilters || !filterSheet) return
    // Measure the authored CSS. Batch all style reads before applying overrides.
    filterSheet.disabled = true
    var selectors = new Map()
    var rules = []
    document.querySelectorAll('*').forEach(function (element) {
      var style = getComputedStyle(element)
      var filter = cheapFrameFilter(style.filter)
      var backdrop = hasFrameBackdropFilter(style.backdropFilter, style.webkitBackdropFilter)
      if (filter === null && !backdrop) return
      rules.push(filterSelector(element, selectors) + '{' +
        (filter !== null ? 'filter:' + filter + '!important;' : '') +
        (backdrop ? '-webkit-backdrop-filter:none!important;backdrop-filter:none!important;' : '') + '}')
    })
    filterSheet.replaceSync('@layer doop-motion-islands{' + rules.join('') + '}')
    filterSheet.disabled = false
    adoptAnimationSheet(filterSheet, rules.length > 0)
  }

  var filterRefresh = 0
  function queueFilterRefresh() {
    if (!frameAnimationPolicy?.simplifyFilters || filterRefresh) return
    filterRefresh = setTimeout(function () {
      filterRefresh = 0
      refreshFrameFilters()
    }, 100)
  }
  var filterObserver = new MutationObserver(queueFilterRefresh)
  function refreshFrameAnimationContent() {
    // CSS added by a morph may not have dispatched animationstart yet.
    if (islandsResting && !animationsPaused) reconcileAnimationHolds(true)
    queueFilterRefresh()
  }
  function setFrameAnimationPolicy(policy) {
    var wasSimplifying = frameAnimationPolicy?.simplifyFilters === true
    frameAnimationPolicy = policy
    refreshAnimationHolds()
    var simplify = frameAnimationPolicy?.simplifyFilters === true
    if (simplify === wasSimplifying || !filterSheet) return
    if (simplify) {
      refreshFrameFilters()
      filterObserver.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'id', 'style', 'hidden', 'media', 'rel', 'href']
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
  function refreshFiltersOnLoad(event) {
    if (event.target?.tagName === 'LINK') queueFilterRefresh()
  }
`
