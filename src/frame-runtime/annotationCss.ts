export interface PreviewTarget {
  selector: string
  properties: Record<string, string>
}

interface CssPreview {
  original: string | null
  applied: string | null
  signature: string
  names: string[]
}

type StyledElement = HTMLElement | SVGElement

/** Holds reversible preview declarations for one document. */
export function annotationCss(
  targetFor: (selector: string) => StyledElement | null,
  newStyle: () => CSSStyleDeclaration,
  supports: (name: string, value: string) => boolean,
  changed: () => void,
) {
  const previews = new Map<StyledElement, CssPreview>()

  function restore(el: StyledElement, preview: CssPreview): void {
    if (el.getAttribute('style') === preview.applied) {
      if (preview.original === null) el.removeAttribute('style')
      else el.setAttribute('style', preview.original)
      return
    }
    // Page scripts may change inline styles during a preview. Restore only
    // declarations that still match the values we wrote.
    const original = newStyle()
    const applied = newStyle()
    original.cssText = preview.original || ''
    applied.cssText = preview.applied || ''
    for (const name of new Set([...Array.from(original), ...Array.from(applied), ...preview.names])) {
      const source = original.getPropertyValue(name)
      const sourcePriority = original.getPropertyPriority(name)
      const value = applied.getPropertyValue(name)
      const priority = applied.getPropertyPriority(name)
      if (source === value && sourcePriority === priority) continue
      if (el.style.getPropertyValue(name) !== value || el.style.getPropertyPriority(name) !== priority) continue
      if (source) el.style.setProperty(name, source, sourcePriority)
      else el.style.removeProperty(name)
    }
  }

  return function sync(targets: PreviewTarget[]): void {
    const desired = new Map<StyledElement, Record<string, string>>()
    for (const target of targets) {
      const el = targetFor(target.selector)
      if (el?.style) desired.set(el, target.properties)
    }
    let updated = false
    for (const [el, preview] of previews) {
      if (JSON.stringify(desired.get(el)) === preview.signature) {
        desired.delete(el)
        continue
      }
      restore(el, preview)
      previews.delete(el)
      updated = true
    }
    for (const [el, properties] of desired) {
      const original = el.getAttribute('style')
      const names = Object.keys(properties)
      for (const name of names) {
        const value = properties[name]!
        if (supports(name, value)) el.style.setProperty(name, value, 'important')
      }
      const applied = el.getAttribute('style')
      if (applied === original) continue
      previews.set(el, { original, applied, signature: JSON.stringify(properties), names })
      updated = true
    }
    if (updated) changed()
  }
}
