/** The document budget and the canvas's per-effect decisions travel together. */
export interface FrameAnimationPolicy {
  paused: boolean
  restIslands: boolean
  simplifyFilters: boolean
}

export function frameAnimationPolicy({
  playback,
  active,
  documentAllowed,
  moving,
  visiblePixelRatio,
}: {
  playback: boolean
  active: boolean
  documentAllowed: boolean
  moving: boolean
  visiblePixelRatio: number
}): FrameAnimationPolicy | null {
  if (playback) return null
  return {
    paused: !documentAllowed,
    restIslands: !active,
    simplifyFilters: !active && (moving || visiblePixelRatio < 0.25),
  }
}
