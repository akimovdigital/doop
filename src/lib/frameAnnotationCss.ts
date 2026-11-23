/** Reversible inline previews live in the sandbox, outside the authored HTML. */
export const FRAME_ANNOTATION_CSS_RUNTIME = `
  var annotationCssPreviews = new Map()

  function annotationCssProperties(el, prop) {
    var style = getComputedStyle(el)
    var properties = Object.create(null)
    if (prop) properties[prop] = style.getPropertyValue(prop)
    else Array.from(style).forEach(function (name) { properties[name] = style.getPropertyValue(name) })
    return properties
  }

  function restoreAnnotationCss(el, preview) {
    if (el.getAttribute('style') === preview.applied) {
      if (preview.original === null) el.removeAttribute('style')
      else el.setAttribute('style', preview.original)
      return
    }
    // Page scripts may have touched the inline style while we held a preview.
    // Restore only declarations still matching the values the preview wrote.
    var original = document.createElement('div').style
    var applied = document.createElement('div').style
    original.cssText = preview.original || ''
    applied.cssText = preview.applied || ''
    new Set(Array.from(original).concat(Array.from(applied), preview.names)).forEach(function (name) {
      var source = original.getPropertyValue(name)
      var sourcePriority = original.getPropertyPriority(name)
      var value = applied.getPropertyValue(name)
      var priority = applied.getPropertyPriority(name)
      if (source === value && sourcePriority === priority) return
      if (el.style.getPropertyValue(name) !== value || el.style.getPropertyPriority(name) !== priority) return
      if (source) el.style.setProperty(name, source, sourcePriority)
      else el.style.removeProperty(name)
    })
  }

  function syncAnnotationCss(targets) {
    var desired = new Map()
    targets.forEach(function (target) {
      var el = styleTarget(target.selector)
      if (el?.style) desired.set(el, target.properties)
    })
    var changed = false
    annotationCssPreviews.forEach(function (preview, el) {
      var signature = JSON.stringify(desired.get(el))
      if (signature === preview.signature) {
        desired.delete(el)
        return
      }
      restoreAnnotationCss(el, preview)
      annotationCssPreviews.delete(el)
      changed = true
    })
    desired.forEach(function (properties, el) {
      var original = el.getAttribute('style')
      var names = Object.keys(properties)
      names.forEach(function (name) {
        var value = properties[name]
        if (CSS.supports(name, value)) el.style.setProperty(name, value, 'important')
      })
      var applied = el.getAttribute('style')
      if (applied === original) return
      annotationCssPreviews.set(el, { original: original, applied: applied, signature: JSON.stringify(properties), names: names })
      changed = true
    })
    if (changed) annotationChanged()
  }
`
