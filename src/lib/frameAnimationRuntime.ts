/** Canvas-directed playback inside the existing opaque-origin frame sandbox. */
export const FRAME_ANIMATION_RUNTIME = `
  var animationSheet = null
  try {
    animationSheet = new CSSStyleSheet()
    animationSheet.replaceSync('@layer doop-animation-budget{*,*::before,*::after{animation-play-state:paused!important}}')
  } catch (e) {}
  var animationsPaused = false
  var heldAnimations = new Set()
  var nativeAnimate = Element.prototype.animate
  var nativePlay = Animation.prototype.play
  var nativePause = Animation.prototype.pause

  function holdAnimation(animation) {
    if (animation.playState !== 'running') return
    try {
      nativePause.call(animation)
      heldAnimations.add(animation)
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
  function holdNewCssAnimations(event) {
    var target = event.target
    if (animationsPaused && target && typeof target.getAnimations === 'function') {
      target.getAnimations().forEach(holdAnimation)
    }
  }
  window.addEventListener('animationstart', holdNewCssAnimations, true)
  window.addEventListener('transitionrun', holdNewCssAnimations, true)

  function setAnimationsPaused(paused) {
    if (animationsPaused === paused) return
    animationsPaused = paused
    var sheets = document.adoptedStyleSheets
    if (paused) {
      if (animationSheet) document.adoptedStyleSheets = sheets.concat(animationSheet)
      // CSS playback is governed by the sheet, keeping authored pauses.
      // WAAPI and any running CSS animations outside the sheet's scope are held explicitly.
      try {
        Element.prototype.animate = holdNewAnimation
        Animation.prototype.play = holdPlayedAnimation
      } catch (e) {}
      document.getAnimations().forEach(holdAnimation)
    } else {
      if (animationSheet) document.adoptedStyleSheets = sheets.filter(function (sheet) { return sheet !== animationSheet })
      try {
        if (Element.prototype.animate === holdNewAnimation) Element.prototype.animate = nativeAnimate
        if (Animation.prototype.play === holdPlayedAnimation) Animation.prototype.play = nativePlay
      } catch (e) {}
      heldAnimations.forEach(function (animation) {
        if (animation.playState === 'paused') {
          try { nativePlay.call(animation) } catch (e) {}
        }
      })
      heldAnimations.clear()
    }
  }
`
