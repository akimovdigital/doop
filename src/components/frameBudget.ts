import { rotatedBounds } from '../../shared/frameRotation'
import type { Frame } from '../../shared/types'
import { FRAME_SNAPSHOT_TINY_PX } from '../lib/frameSnapshots'
import type { Viewport } from '../lib/store'

export const LIVE_FRAME_BUDGET = 20
export const ANIMATING_FRAME_BUDGET = 4
export const UNSEEN_MS = 10_000
export const EVICTION_DELAY_MS = 2_000
export const FRAME_NEAR_PX = 180

export interface FrameCandidate {
  id: string
  distance: number
  visible: boolean
  near: boolean
  large: boolean
  visiblePixelRatio: number
  lastSeen: number
}

export function frameCandidate(frame: Frame, camera: Viewport, width: number, height: number) {
  const { x, y, zoom } = camera
  const box = rotatedBounds(frame, frame.rotation ?? 0)
  const left = box.x * zoom + x
  const top = box.y * zoom + y
  const right = left + box.width * zoom
  const bottom = top + box.height * zoom
  const visibleWidth = Math.max(0, Math.min(width, right) - Math.max(0, left))
  const visibleHeight = Math.max(0, Math.min(height, bottom) - Math.max(0, top))
  return {
    id: frame.id,
    distance: Math.hypot((left + right - width) / 2, (top + bottom - height) / 2),
    visible: right > 0 && bottom > 0 && left < width && top < height,
    near:
      right >= -FRAME_NEAR_PX &&
      bottom >= -FRAME_NEAR_PX &&
      left <= width + FRAME_NEAR_PX &&
      top <= height + FRAME_NEAR_PX,
    large: frame.width * zoom >= FRAME_SNAPSHOT_TINY_PX,
    // Use the rotated box for clipping and the native size for scale.
    visiblePixelRatio: (visibleWidth * visibleHeight) / (box.width * box.height || 1),
  }
}

export function rankFrameCandidates(frames: FrameCandidate[]) {
  return [...frames].sort(
    (a, b) =>
      Number(b.visible) - Number(a.visible) ||
      (a.visible ? 0 : Number(b.near) - Number(a.near) || b.lastSeen - a.lastSeen) ||
      a.distance - b.distance,
  )
}

/** Preserve mounted active work, then reserve space for new active frames in priority order. */
export function reserveFrameSlots(protectedIds: ReadonlySet<string>, live: ReadonlySet<string>, freeze: boolean) {
  const reserved = new Set([...live].filter((id) => freeze || protectedIds.has(id)))
  for (const id of protectedIds) {
    if (reserved.size >= LIVE_FRAME_BUDGET) break
    reserved.add(id)
  }
  return reserved
}

export function planFrameAdmission(
  ranked: FrameCandidate[],
  live: ReadonlySet<string>,
  protectedIds: ReadonlySet<string>,
  warmSmallPage: boolean,
  now: number,
) {
  const desired = new Set(protectedIds)
  for (const frame of ranked) {
    if (desired.size >= LIVE_FRAME_BUDGET) break
    const recentlySeen = now - frame.lastSeen < UNSEEN_MS
    if (
      frame.visible ||
      warmSmallPage ||
      (frame.near && frame.lastSeen === -Infinity) ||
      (recentlySeen && (frame.near || live.has(frame.id)))
    ) {
      desired.add(frame.id)
    }
  }
  return desired
}
