import { PREVIEW_MAX_HEIGHT, type Frame } from '../shared/types.ts'
import * as storage from './storage.ts'
import { store } from './store.ts'

/**
 * Persisted dashboard previews: `thumb/<frameId>.jpg` in byte storage,
 * stale-while-revalidate on top.
 *
 * The stored object survives redeploys — which wipe the in-process image
 * cache — so a dashboard never shows blank tiles waiting on Chromium: a
 * possibly-stale thumbnail is served instantly and refreshed in the
 * background. The key is deliberately unversioned; freshness lives in the
 * in-memory `written` map (frameId → the frame.updatedAt the stored thumb
 * was rendered from). After a restart freshness is simply unknown, which
 * degrades to one background re-render per previewed frame — never to a
 * blank tile.
 */

/** frame.updatedAt the stored thumb was rendered from; absent = unknown */
const written = new Map<string, number>()
/** in-flight render+persist per frame — concurrent callers share it */
const pending = new Map<string, Promise<Buffer>>()
/** background revalidation throttle: an agent saving every few seconds
 *  must not turn each dashboard poll into a Chromium render */
const lastAttempt = new Map<string, number>()
const MIN_REVALIDATE_MS = 30_000
/** frames purged mid-render — a pending create must not re-persist them */
const dead = new Set<string>()

export type ThumbKind = 'card' | 'canvas'

const keyFor = (frameId: string, kind: ThumbKind) =>
  kind === 'canvas' ? `thumb/${frameId}-canvas-v1.bin` : `thumb/${frameId}.jpg`

/* Reduce density before capture so long pages keep their bottom edge. */
function canvasDensity({ width, height }: Frame) {
  return Math.min(1, 960 / width, 5600 / height, Math.sqrt(2_400_000 / (width * height)))
}

/* Global bound on concurrent preview renders. Per-frame dedupe caps repeat
   requests but not breadth: a post-restart dashboard of 50 stale canvases
   (or an anonymous crawler walking known frame URLs) would otherwise launch
   50 Chromium pages at once. Excess renders queue, they are not dropped. */
const MAX_CONCURRENT_RENDERS = 3
let active = 0
const waiting: Array<() => void> = []

/* lazy like every other screenshot.ts consumer (dev never pays for
   puppeteer-core until the first render), but single-flight */
let screenshot: Promise<typeof import('./screenshot.ts')> | undefined
const loadScreenshot = () => (screenshot ??= import('./screenshot.ts'))

/** The preview render: card-sized, clipped, cheap — matches what /i/?preview
 *  serves, because this IS what /i/?preview serves. */
async function render(frame: Frame, kind: ThumbKind) {
  if (active >= MAX_CONCURRENT_RENDERS) await new Promise<void>((r) => waiting.push(r))
  active++
  try {
    const { renderFrame } = await loadScreenshot()
    /* Read the latest visual state only when the render starts. */
    const source = await store.renderSource(frame)
    const canvas = kind === 'canvas'
    const buf = await renderFrame(source, canvas ? canvasDensity(source) : Math.min(1, 640 / source.width), {
      type: 'jpeg',
      quality: canvas ? 76 : 70,
      ...(canvas ? { canvasSnapshot: true } : { maxHeight: PREVIEW_MAX_HEIGHT }),
      priority: 'background',
    })
    return { buf, updatedAt: source.updatedAt }
  } finally {
    active--
    waiting.shift()?.()
  }
}

/** Render now, persist, and return the bytes. Deduped per frame; rejects on
 *  render failure (the caller decides what a failed render means). */
export function create(frame: Frame, kind: ThumbKind = 'card'): Promise<Buffer> {
  const key = keyFor(frame.id, kind)
  const inflight = pending.get(key)
  if (inflight) return inflight
  lastAttempt.set(key, Date.now())
  const p = render(frame, kind).then(async ({ buf, updatedAt }) => {
    /* persist is best-effort: a bucket hiccup must not fail the response
       that only needed the bytes */
    try {
      if (!dead.has(frame.id)) {
        if (kind === 'canvas') {
          // Keep the revision and image in one atomic object across restarts.
          const snapshot = Buffer.concat([Buffer.from(`${updatedAt}\n`), buf])
          await storage.putObject(key, snapshot, 'application/octet-stream')
        } else {
          await storage.putObject(key, buf, 'image/jpeg')
          written.set(key, updatedAt)
        }
        /* purge may have run during the put — its delete can land before
           our write finishes, so re-check and clean up our own orphan */
        if (dead.has(frame.id)) await storage.deleteObject(key)
      }
    } catch (e) {
      console.error(`thumb persist failed for ${frame.id}:`, e)
    }
    return buf
  })
  pending.set(key, p)
  p.catch(() => {}).finally(() => pending.delete(key))
  return p
}

/** The stored thumbnail, if there is one. When it is stale — or its
 *  freshness is unknown after a restart — a background re-render is kicked
 *  off (throttled, deduped, errors logged and swallowed) and the stored
 *  bytes are returned anyway: stale beats blank. Returns null when nothing
 *  is stored yet. */
export async function getStored(frame: Frame, kind: ThumbKind = 'card'): Promise<Buffer | null> {
  const key = keyFor(frame.id, kind)
  let buf: Buffer | null
  try {
    buf = await storage.getObject(key)
  } catch (e) {
    console.error(`thumb read failed for ${frame.id}:`, e)
    return null
  }
  if (!buf) {
    /* the map claimed fresh but the object is gone (manual purge, new
       bucket) — forget, so the caller falls through to a live render */
    written.delete(key)
    return null
  }
  if (kind === 'canvas') {
    const header = Buffer.from(`${frame.updatedAt}\n`)
    return buf.length > header.length && buf.subarray(0, header.length).equals(header)
      ? buf.subarray(header.length)
      : null
  }
  const fresh = written.get(key) === frame.updatedAt
  const throttled = Date.now() - (lastAttempt.get(key) ?? 0) < MIN_REVALIDATE_MS
  if (!fresh && !throttled && !pending.has(key))
    create(frame).catch((e) => console.error(`thumb revalidate failed for ${frame.id}:`, e))
  return buf
}

/** Frame (or its whole canvas) is gone — drop the derived object too, so the
 *  thumb folder holds only live frames. Best-effort fire-and-forget. */
export function purge(frameId: string): void {
  dead.add(frameId)
  for (const kind of ['card', 'canvas'] as const) {
    const key = keyFor(frameId, kind)
    written.delete(key)
    lastAttempt.delete(key)
    void storage.deleteObject(key).catch(() => {})
  }
}
