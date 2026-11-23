import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { rotatedBounds } from '../../shared/frameRotation'
import type { Frame } from '../../shared/types'
import { hasFrameDocument, onFrameDocument } from '../lib/frameBridge'
import { currentPageCanvas } from '../lib/pages'
import { useStore } from '../lib/store'

const EAGER_FRAME_LIMIT = 16
const EAGER_HTML_LIMIT = 256_000
const SMALL_PAGE_FRAME_LIMIT = 8
const SMALL_PAGE_HTML_LIMIT = 4_000_000
const STARTS_PER_BATCH = 3
const PREPARING_HTML_LIMIT = 800_000
const BOOT_TIMEOUT_MS = 2_000
const NEAR_PX = 180
const PAN_SETTLE_MS = 180

export function useFrameAdmission(
  frames: Frame[],
  stage: RefObject<HTMLDivElement | null>,
  layer: RefObject<HTMLDivElement | null>,
) {
  const signature = useMemo(() => {
    return JSON.stringify(frames.flatMap((frame) => (frame.hidden ? [] : [[frame.id, frame.html.length]])))
  }, [frames])
  const liveById = useMemo(() => new Map<string, number>(JSON.parse(signature)), [signature])
  const count = liveById.size
  const size = useMemo(() => [...liveById.values()].reduce((total, length) => total + length, 0), [liveById])
  const eager =
    count <= EAGER_FRAME_LIMIT &&
    size <= SMALL_PAGE_HTML_LIMIT &&
    (size <= EAGER_HTML_LIMIT || count <= SMALL_PAGE_FRAME_LIMIT)
  const [admitted, setAdmitted] = useState(new Set<string>())
  const started = useRef(new Set<string>())
  const booting = useRef(new Map<string, number>())
  const wake = useRef<((id: string) => void) | null>(null)
  const request = useCallback((id: string) => wake.current?.(id), [])

  useLayoutEffect(() => {
    // On the first commit the child layout effect can run before the
    // enclosing stage's host ref has been attached.
    const el = stage.current ?? layer.current?.closest<HTMLDivElement>('.stage')
    if (!el) return
    const ids = started.current
    const boots = booting.current
    let changed = false
    for (const id of ids) {
      if (liveById.has(id)) continue
      ids.delete(id)
      boots.delete(id)
      changed = true
    }
    if (eager) {
      // A frame already painted on a small page stays alive when new frames make it large.
      for (const id of liveById.keys()) {
        if (ids.has(id)) continue
        ids.add(id)
        changed = true
      }
      boots.clear()
      if (changed) setAdmitted(new Set(ids))
      return
    }
    if (changed) setAdmitted(new Set(ids))

    let width = el.clientWidth
    let height = el.clientHeight
    let raf = 0
    let idleTimer = 0
    let idle = false
    let cameraMoving = false
    let lastViewportChange = -Infinity
    const watches = new Map<string, () => void>()

    function schedule() {
      if (!raf) raf = requestAnimationFrame(drain)
    }

    function watch(id: string, since: number) {
      if (hasFrameDocument(id) || performance.now() - since >= BOOT_TIMEOUT_MS) {
        boots.delete(id)
        return
      }
      const finish = () => {
        watches.get(id)?.()
        watches.delete(id)
        boots.delete(id)
        schedule()
      }
      const off = onFrameDocument(id, () => {
        if (hasFrameDocument(id)) finish()
      })
      const timer = window.setTimeout(finish, BOOT_TIMEOUT_MS - (performance.now() - since))
      watches.set(id, () => {
        off()
        window.clearTimeout(timer)
      })
    }

    function start(id: string) {
      if (ids.has(id) || !liveById.has(id)) return false
      ids.add(id)
      const since = performance.now()
      boots.set(id, since)
      watch(id, since)
      return true
    }

    function drain() {
      raf = 0
      const { viewport, selectedId, ctxMenu, prototypeMode } = useStore.getState()
      // A deliberate selection can jump the queue. The rest of the work is
      // bounded so independent sandbox bootstraps don't all land in one paint.
      let added = selectedId ? start(selectedId) : false
      if (ctxMenu?.frameId) added = start(ctxMenu.frameId) || added
      const slots = STARTS_PER_BATCH - boots.size
      if (!cameraMoving && slots > 0 && width > 0 && height > 0) {
        const margin = idle ? NEAR_PX : 0
        const { x, y, zoom } = viewport
        const candidates = (currentPageCanvas()?.frames ?? [])
          .flatMap((frame) => {
            if (ids.has(frame.id) || frame.hidden || !liveById.has(frame.id)) return []
            const box = rotatedBounds(frame, frame.rotation ?? 0)
            const left = box.x * zoom + x
            const top = box.y * zoom + y
            const right = left + box.width * zoom
            const bottom = top + box.height * zoom
            const near = right >= -margin && bottom >= -margin && left <= width + margin && top <= height + margin
            if (!near && !(idle && prototypeMode)) return []
            const visibleArea =
              Math.max(0, Math.min(width, right) - Math.max(0, left)) *
              Math.max(0, Math.min(height, bottom) - Math.max(0, top))
            const distance = Math.hypot((left + right - width) / 2, (top + bottom - height) / 2)
            return [{ id: frame.id, htmlSize: frame.html.length, visibleArea, distance }]
          })
          .sort((a, b) => b.visibleArea - a.visibleArea || a.distance - b.distance)
        // One large document can fill the budget on its own. Let it finish
        // before posting another large HTML parse to the renderer.
        let preparing = 0
        for (const id of boots.keys()) preparing += liveById.get(id) ?? 0
        for (const frame of candidates.slice(0, slots)) {
          if (preparing > 0 && preparing + frame.htmlSize > PREPARING_HTML_LIMIT) break
          if (start(frame.id)) {
            preparing += frame.htmlSize
            added = true
          }
        }
      }
      if (added) setAdmitted(new Set(ids))
    }

    function settle() {
      idle = false
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => {
        idle = true
        cameraMoving = false
        schedule()
      }, PAN_SETTLE_MS)
    }

    wake.current = (id) => {
      if (start(id)) setAdmitted(new Set(ids))
    }
    for (const [id, since] of boots) watch(id, since)
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.viewport !== previous.viewport) {
        const now = performance.now()
        cameraMoving = now - lastViewportChange < PAN_SETTLE_MS
        lastViewportChange = now
        settle()
      } else if (
        state.selectedId === previous.selectedId &&
        state.ctxMenu === previous.ctxMenu &&
        state.prototypeMode === previous.prototypeMode &&
        state.canvas?.frames === previous.canvas?.frames
      )
        return
      if (ids.size < count) schedule()
    })
    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return
      width = entry.contentRect.width
      height = entry.contentRect.height
      if (ids.size < count) schedule()
    })
    resize.observe(el)
    settle()
    schedule()
    return () => {
      wake.current = null
      unsubscribe()
      resize.disconnect()
      cancelAnimationFrame(raf)
      window.clearTimeout(idleTimer)
      for (const off of watches.values()) off()
    }
  }, [liveById, count, stage, layer, eager])

  return { eager, admitted, request }
}
