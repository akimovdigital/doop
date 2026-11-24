import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Frame } from '../../shared/types'
import {
  forgetFrameAnimationPolicy,
  hasFrameDocument,
  onFrameDocument,
  setFrameAnimationPolicy,
} from '../lib/frameBridge'
import { frameAnimationPolicy } from '../lib/frameAnimationPolicy'
import { FRAME_CAMERA_SETTLE_MS, FRAME_OVERVIEW_MAX_ZOOM } from '../lib/frameSnapshots'
import { currentPageSpatialIndex } from '../lib/pages'
import { presentStartFrame } from '../lib/present'
import { useStore } from '../lib/store'
import {
  ANIMATING_FRAME_BUDGET,
  EVICTION_DELAY_MS,
  frameCandidate,
  FRAME_NEAR_PX,
  LIVE_FRAME_BUDGET,
  planFrameAdmission,
  rankFrameCandidates,
  reserveFrameSlots,
  UNSEEN_MS,
} from './frameBudget'

const EAGER_FRAME_LIMIT = 16
const EAGER_HTML_LIMIT = 256_000
const SMALL_PAGE_FRAME_LIMIT = 8
const SMALL_PAGE_HTML_LIMIT = 4_000_000
const STARTS_PER_BATCH = 3
const PREPARING_HTML_LIMIT = 800_000
const LIVE_OVERVIEW_STARTS_PER_BATCH = 6
const LIVE_OVERVIEW_PREPARING_HTML_LIMIT = 1_600_000
const WIDE_OVERVIEW_STARTS_PER_BATCH = 12
const WIDE_OVERVIEW_PREPARING_HTML_LIMIT = 3_200_000
const WIDE_OVERVIEW_INITIAL_STARTS_PER_TICK = 2
const WIDE_OVERVIEW_STARTS_PER_TICK = 3
const BOOT_TIMEOUT_MS = 2_000
const REQUEST_LEASE_MS = 5_000
const RETAINED_OVERVIEW_LIMIT = 48

export function useFrameAdmission(
  frames: Frame[],
  stage: RefObject<HTMLDivElement | null>,
  layer: RefObject<HTMLDivElement | null>,
  presenting: boolean,
  limitOverview = false,
  liveOverview = false,
) {
  const signature = useMemo(
    () =>
      JSON.stringify(frames.flatMap((frame) => (frame.hidden || frame.browser ? [] : [[frame.id, frame.html.length]]))),
    [frames],
  )
  const htmlSizes = useMemo(() => new Map<string, number>(JSON.parse(signature)), [signature])
  const browserSignature = useMemo(
    () => JSON.stringify(frames.flatMap((frame) => (!frame.hidden && frame.browser ? [frame.id] : []))),
    [frames],
  )
  const browserIds = useMemo(() => new Set<string>(JSON.parse(browserSignature)), [browserSignature])
  const [admitted, setAdmitted] = useState<ReadonlySet<string>>(new Set())
  const started = useRef(new Set<string>())
  const startedBrowsers = useRef(new Set<string>())
  const overviewResidents = useRef(new Set<string>())
  const booting = useRef(new Map<string, number>())
  const lastSeen = useRef(new Map<string, number>())
  const outsideBudget = useRef(new Map<string, number>())
  const requests = useRef(new Map<string, number>())
  const localActivity = useRef(new Set<string>())
  const scheduler = useRef<(() => void) | null>(null)
  const fillAfterCommit = useRef(false)
  const initialAdmission = useRef(true)

  useLayoutEffect(() => {
    if (!fillAfterCommit.current) return
    fillAfterCommit.current = false
    scheduler.current?.()
  }, [admitted])

  const request = useCallback((id: string) => {
    requests.current.set(id, performance.now() + REQUEST_LEASE_MS)
    scheduler.current?.()
  }, [])
  const protect = useCallback((id: string, active: boolean) => {
    if (active) localActivity.current.add(id)
    else localActivity.current.delete(id)
    scheduler.current?.()
  }, [])

  useLayoutEffect(() => {
    const ids = started.current
    return () => {
      for (const id of ids) setFrameAnimationPolicy(id, null)
    }
  }, [])

  useLayoutEffect(() => {
    const el = stage.current ?? layer.current?.closest<HTMLDivElement>('.stage')
    if (!el) return
    const ids = started.current
    const browsers = startedBrowsers.current
    const residents = overviewResidents.current
    const boots = booting.current
    const seen = lastSeen.current
    const outside = outsideBudget.current
    const leases = requests.current
    const active = localActivity.current
    const size = [...htmlSizes.values()].reduce((total, length) => total + length, 0)
    const count = htmlSizes.size + browserIds.size
    const warmSmallPage =
      !limitOverview &&
      count <= EAGER_FRAME_LIMIT &&
      size <= SMALL_PAGE_HTML_LIMIT &&
      (size <= EAGER_HTML_LIMIT || count <= SMALL_PAGE_FRAME_LIMIT)

    let width = el.clientWidth
    let height = el.clientHeight
    let raf = 0
    let settleTimer = 0
    let expiryTimer = 0
    let moving = !initialAdmission.current && el.hasAttribute('data-frame-camera-moving')
    const watches = new Map<string, () => void>()
    const nearBrowsers = new Set<string>()
    for (const id of seen.keys()) if (!htmlSizes.has(id)) seen.delete(id)
    for (const id of residents) if (!htmlSizes.has(id)) residents.delete(id)
    let ranked: ReturnType<typeof rankFrameCandidates> = []
    let visiblePixels = new Map<string, number>()
    let dirty = true

    function measure(warming: boolean) {
      const now = performance.now()
      const page = currentPageSpatialIndex()
      const { viewport } = useStore.getState()
      const { x, y, zoom } = viewport
      nearBrowsers.clear()
      if (!page) return []

      const { index, pageId } = page
      const nearby = warming
        ? index.all(pageId)
        : index.intersect(pageId, {
            x: (-FRAME_NEAR_PX - x) / zoom,
            y: (-FRAME_NEAR_PX - y) / zoom,
            width: (width + 2 * FRAME_NEAR_PX) / zoom,
            height: (height + 2 * FRAME_NEAR_PX) / zoom,
          })
      const candidates = new Map<string, ReturnType<typeof frameCandidate>>()
      for (const frame of nearby) {
        const candidate = frameCandidate(frame, viewport, width, height)
        if (browserIds.has(frame.id)) {
          if (candidate.near) nearBrowsers.add(frame.id)
        } else if (htmlSizes.has(frame.id) && (candidate.near || warming)) {
          candidates.set(frame.id, candidate)
        }
      }
      // Live far frames still compete for space and must expire after leaving the query.
      for (const id of ids) {
        if (candidates.has(id)) continue
        const frame = index.get(pageId, id)
        if (frame && htmlSizes.has(id)) candidates.set(id, frameCandidate(frame, viewport, width, height))
      }
      return rankFrameCandidates(
        [...candidates.values()].map((candidate) => {
          if (candidate.visible && !moving) seen.set(candidate.id, now)
          return { ...candidate, lastSeen: seen.get(candidate.id) ?? -Infinity }
        }),
      )
    }

    function schedule() {
      if (raf || fillAfterCommit.current) return
      raf = requestAnimationFrame(() => {
        initialAdmission.current = false
        drain()
      })
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

    function start(id: string, trackBoot: boolean) {
      if (ids.has(id)) return false
      ids.add(id)
      if (!seen.has(id)) seen.set(id, performance.now())
      if (trackBoot) {
        const since = performance.now()
        boots.set(id, since)
        watch(id, since)
      }
      return true
    }

    function stop(id: string) {
      forgetFrameAnimationPolicy(id)
      ids.delete(id)
      boots.delete(id)
      outside.delete(id)
      watches.get(id)?.()
      watches.delete(id)
    }

    function protectedFrames(now: number) {
      const {
        canvas,
        activePageId,
        selectedId,
        selectedIds,
        selectedElement,
        ctxMenu,
        prototypeMode,
        streams,
        presences,
      } = useStore.getState()
      const flowStart = prototypeMode ? presentStartFrame(canvas, null, activePageId) : null
      const protectedIds = new Set<string>()
      for (const id of [
        ...active,
        selectedId,
        ctxMenu?.frameId,
        selectedElement?.frameId,
        flowStart,
        ...Object.keys(streams),
        ...Object.values(presences).map((presence) => presence.activeFrameId),
        ...selectedIds,
      ]) {
        if (id && htmlSizes.has(id)) protectedIds.add(id)
      }
      const retained = liveOverview ? [...ids].filter((id) => residents.has(id)) : []
      const required = new Set([...protectedIds, ...retained])
      if (liveOverview) {
        for (const frame of ranked) if (frame.visible) required.add(frame.id)
      }
      const budget = liveOverview ? Math.max(LIVE_FRAME_BUDGET, required.size) : LIVE_FRAME_BUDGET
      const forced = reserveFrameSlots(new Set([...protectedIds, ...retained]), ids, presenting, budget)
      for (const [id, until] of leases) {
        if (until <= now || !htmlSizes.has(id)) leases.delete(id)
        else if (forced.size < budget) forced.add(id)
      }
      return { protectedIds, forced, budget }
    }

    function applyAnimations(protectedIds: ReadonlySet<string>) {
      // CEF canvas documents stay static even when protected or in Prototype mode.
      const allowAll = !liveOverview && (presenting || useStore.getState().prototypeMode)
      const focused =
        liveOverview || moving || allowAll
          ? []
          : ranked
              .filter((frame) => frame.visible && frame.large && ids.has(frame.id) && !protectedIds.has(frame.id))
              .slice(0, Math.max(0, ANIMATING_FRAME_BUDGET - protectedIds.size))
      const allowed = new Set(focused.map(({ id }) => id))
      const canAnimate = (id: string) => !liveOverview && (allowAll || allowed.has(id) || protectedIds.has(id))
      const publishPolicy = (id: string, documentAllowed: boolean) =>
        setFrameAnimationPolicy(
          id,
          frameAnimationPolicy({
            playback: allowAll,
            active: protectedIds.has(id),
            documentAllowed,
            moving,
            visiblePixelRatio: visiblePixels.get(id) ?? 0,
          }),
        )
      // Pause losers before waking any winners.
      for (const id of ids) {
        if (canAnimate(id)) continue
        publishPolicy(id, false)
      }
      for (const id of ids) {
        if (canAnimate(id)) {
          publishPolicy(id, true)
        }
      }
    }

    function admitBrowsers() {
      if (!browsers.size && !browserIds.size) return false
      const { selectedId, selectedIds, ctxMenu, prototypeMode } = useStore.getState()
      let changed = false
      for (const id of browsers) if (!browserIds.has(id)) changed = browsers.delete(id) || changed
      const requested = new Set([...selectedIds, selectedId, ctxMenu?.frameId])
      const candidates = moving
        ? requested
        : warmSmallPage || prototypeMode
          ? browserIds
          : new Set([...nearBrowsers, ...requested])
      // Browser surfaces manage their own live site and retain it after first use.
      for (const id of candidates) {
        if (!id || !browserIds.has(id) || browsers.has(id)) continue
        browsers.add(id)
        changed = true
      }
      return changed
    }

    function publish() {
      setAdmitted(new Set([...ids, ...browsers]))
    }

    function drain() {
      raf = 0
      window.clearTimeout(expiryTimer)
      if (presenting) {
        // Present owns its own document. Keep the canvas iframes mounted
        // for return, without starting or animating the covered documents.
        for (const id of ids) {
          setFrameAnimationPolicy(
            id,
            frameAnimationPolicy({
              playback: false,
              active: false,
              documentAllowed: false,
              moving: false,
              visiblePixelRatio: 0,
            }),
          )
        }
        return
      }
      const now = performance.now()
      const warming = warmSmallPage && seen.size < htmlSizes.size
      if (dirty && !moving) {
        ranked = measure(warming)
        visiblePixels = new Map(ranked.map(({ id, visiblePixelRatio }) => [id, visiblePixelRatio]))
        if (liveOverview && useStore.getState().viewport.zoom <= FRAME_OVERVIEW_MAX_ZOOM) {
          // Preserve documents seen in a wide overview through a close-up.
          // Admit visible documents in batches, keeping offscreen retention bounded.
          for (const { id, visible } of ranked) {
            if (!visible) break
            residents.delete(id)
            residents.add(id)
          }
          for (const id of residents) {
            if (residents.size <= RETAINED_OVERVIEW_LIMIT) break
            residents.delete(id)
          }
        }
        dirty = false
      }
      let changed = false
      for (const id of ids) {
        if (htmlSizes.has(id)) continue
        stop(id)
        seen.delete(id)
        changed = true
      }
      const { protectedIds, forced, budget } = protectedFrames(now)
      let expiry = Math.min(Infinity, ...leases.values())
      const browserChanged = admitBrowsers()
      const overview = limitOverview && useStore.getState().viewport.zoom <= FRAME_OVERVIEW_MAX_ZOOM
      // Keep mounted documents in overview to preserve their state, but
      // reserve new live slots for active work and explicit requests only.
      const admitIdleFrames = !moving && !overview
      const desired = admitIdleFrames ? planFrameAdmission(ranked, ids, forced, warming, now, budget) : forced
      if (admitIdleFrames) {
        for (const frame of ranked) {
          const { id, visible } = frame
          if (!ids.has(id)) continue
          if (desired.has(id)) {
            outside.delete(id)
            if (!visible && !forced.has(id)) {
              expiry = Math.min(expiry, (seen.get(id) ?? now) + UNSEEN_MS)
            }
            continue
          }
          const until = (outside.get(id) ?? now) + EVICTION_DELAY_MS
          if (until <= now) {
            stop(id)
            changed = true
          } else {
            if (!outside.has(id)) outside.set(id, now)
            expiry = Math.min(expiry, until)
          }
        }
      }
      const required = [...forced].filter((id) => !ids.has(id)).length
      if (ids.size + required > budget) {
        const priority = new Map(ranked.map(({ id }, rank) => [id, rank]))
        const evictable = [...ids]
          .filter((id) => !forced.has(id))
          .sort(
            (a, b) =>
              (priority.get(b) ?? Infinity) - (priority.get(a) ?? Infinity) ||
              (seen.get(a) ?? -Infinity) - (seen.get(b) ?? -Infinity),
          )
        for (const id of evictable.slice(0, ids.size + required - budget)) {
          stop(id)
          changed = true
        }
      }
      // Commit removals before adding replacement iframes. React can visit
      // siblings in either order, and even a transient mount costs a document.
      if (changed) {
        fillAfterCommit.current = true
        applyAnimations(protectedIds)
        publish()
        return
      }
      for (const id of forced) changed = start(id, !warming) || changed
      if (admitIdleFrames) {
        const fillLiveOverview = liveOverview && useStore.getState().viewport.zoom <= FRAME_OVERVIEW_MAX_ZOOM
        // A dense overview has enough visible work to use more boot slots.
        // Keep the smaller limits for nearby offscreen documents.
        const wideOverview = fillLiveOverview && ranked[WIDE_OVERVIEW_STARTS_PER_BATCH - 1]?.visible
        const overviewBootLimit = fillLiveOverview ? LIVE_OVERVIEW_STARTS_PER_BATCH : STARTS_PER_BATCH
        const overviewHtmlLimit = fillLiveOverview ? LIVE_OVERVIEW_PREPARING_HTML_LIMIT : PREPARING_HTML_LIMIT
        // Give the first visible documents a smaller batch before filling the boot queue.
        const wideStartsPerTick =
          ids.size > boots.size ? WIDE_OVERVIEW_STARTS_PER_TICK : WIDE_OVERVIEW_INITIAL_STARTS_PER_TICK
        let startsThisTick = 0
        let preparing = 0
        for (const id of boots.keys()) preparing += htmlSizes.get(id) ?? 0
        for (const id of desired) {
          if (ids.has(id)) continue
          const visibleInWideOverview = wideOverview && (visiblePixels.get(id) ?? 0) > 0
          const bootLimit = visibleInWideOverview ? WIDE_OVERVIEW_STARTS_PER_BATCH : overviewBootLimit
          const htmlLimit = visibleInWideOverview ? WIDE_OVERVIEW_PREPARING_HTML_LIMIT : overviewHtmlLimit
          if (ids.size >= budget || (!warming && boots.size >= bootLimit)) break
          const htmlSize = htmlSizes.get(id) ?? 0
          if (!warming && preparing > 0 && preparing + htmlSize > htmlLimit) break
          if (visibleInWideOverview && !warming && startsThisTick >= wideStartsPerTick) {
            // Fill spare boot slots across ticks so mounting iframes leaves room for paint and input.
            schedule()
            break
          }
          changed = start(id, !warming) || changed
          if (visibleInWideOverview) startsThisTick += 1
          preparing += htmlSize
        }
      }
      applyAnimations(protectedIds)
      if (changed) {
        dirty = true
        if (warming) expiry = Math.min(expiry, now + UNSEEN_MS)
      }
      if (changed || browserChanged) publish()
      if (Number.isFinite(expiry)) {
        expiryTimer = window.setTimeout(schedule, Math.max(1, expiry - now))
      }
    }

    scheduler.current = schedule
    for (const [id, since] of boots) watch(id, since)
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (presenting) return
      if (
        state.viewport !== previous.viewport &&
        (state.viewport.x !== previous.viewport.x ||
          state.viewport.y !== previous.viewport.y ||
          state.viewport.zoom !== previous.viewport.zoom)
      ) {
        // The parent Stage fits the opening page in a layout effect. Use
        // that camera for the first ranking without waiting for gesture settle.
        if (initialAdmission.current) {
          dirty = true
          schedule()
          return
        }
        if (!moving) {
          const now = performance.now()
          for (const frame of ranked) if (frame.visible) seen.set(frame.id, now)
          moving = true
          applyAnimations(protectedFrames(performance.now()).protectedIds)
        }
        window.clearTimeout(settleTimer)
        settleTimer = window.setTimeout(() => {
          moving = false
          dirty = true
          schedule()
        }, FRAME_CAMERA_SETTLE_MS)
        return
      }
      if (state.canvas?.frames !== previous.canvas?.frames || state.activePageId !== previous.activePageId) {
        dirty = true
        if (!moving) schedule()
      }
      if (
        state.selectedId !== previous.selectedId ||
        state.selectedIds !== previous.selectedIds ||
        state.selectedElement !== previous.selectedElement ||
        state.ctxMenu !== previous.ctxMenu ||
        state.prototypeMode !== previous.prototypeMode ||
        state.streams !== previous.streams ||
        state.presences !== previous.presences
      ) {
        schedule()
      }
    })
    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return
      width = entry.contentRect.width
      height = entry.contentRect.height
      dirty = true
      if (!moving) schedule()
    })
    // Stage may already be in its settle window when this effect reconnects.
    if (moving) {
      settleTimer = window.setTimeout(() => {
        moving = false
        dirty = true
        schedule()
      }, FRAME_CAMERA_SETTLE_MS)
    }
    resize.observe(el)
    // Small pages can mount their bounded set of documents before first paint.
    // Larger pages wait for the final opening camera and use the boot queue.
    if (initialAdmission.current && warmSmallPage) drain()
    schedule()
    return () => {
      scheduler.current = null
      unsubscribe()
      resize.disconnect()
      cancelAnimationFrame(raf)
      window.clearTimeout(settleTimer)
      window.clearTimeout(expiryTimer)
      for (const off of watches.values()) off()
    }
  }, [htmlSizes, browserIds, presenting, limitOverview, liveOverview, stage, layer])

  return { admitted, request, protect }
}
