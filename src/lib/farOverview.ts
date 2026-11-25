export const FAR_OVERVIEW_FLAG = 'doop:far-overview'
export const FAR_OVERVIEW_FLAG_EVENT = 'doop:far-overview-change'

export function farOverviewAtZoom(active: boolean, zoom: number): boolean {
  return active ? zoom < 0.08 : zoom <= 0.06
}

export function protectFarOverviewFocus(stage: HTMLElement): () => void {
  let protectedSurface: Element | null = null
  const sync = () => {
    // A focused sandbox reports its owner as activeElement without matching :focus-within.
    const owner = document.activeElement
    const surface =
      owner?.matches('iframe[data-doop-frame]') && stage.contains(owner) ? owner.closest('[data-frame-surface]') : null
    if (surface === protectedSurface) return
    protectedSurface?.removeAttribute('data-far-overview-focused')
    protectedSurface = surface
    protectedSurface?.setAttribute('data-far-overview-focused', '')
  }
  window.addEventListener('focus', sync, true)
  window.addEventListener('blur', sync, true)
  sync()
  return () => {
    window.removeEventListener('focus', sync, true)
    window.removeEventListener('blur', sync, true)
    protectedSurface?.removeAttribute('data-far-overview-focused')
  }
}

export interface FarOverviewBlock {
  // Fractions of the document viewport, clipped to the visible artboard.
  x: number
  y: number
  width: number
  height: number
  kind: 'group' | 'line' | 'media'
}
