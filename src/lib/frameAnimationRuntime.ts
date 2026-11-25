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
