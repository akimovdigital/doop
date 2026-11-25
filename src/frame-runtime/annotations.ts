import { paintFrameCrop, planDesignCrop, type FrameCropRequest } from '../lib/frameCropRuntime'
import { shortcutKey } from '../lib/keys'
import { annotationCss, type PreviewTarget } from './annotationCss'
import { bleed, frameHeight, frameWidth, viewX } from './bleed'
import { browse, isTrusted, postToParent } from './channel'
import { styleTarget } from './dom'
import { selectAllIn } from './edit'
import { cssPath, designRect } from './geometry'
import { clearTimeout, requestAnimationFrame, setTimeout } from './timers'

interface TextPreview {
  id: unknown
  selector: string
  before: string
  after: string
  pending: boolean
}

export interface AnnotationCommand extends Partial<Omit<FrameCropRequest, 'selectors'>> {
  type: unknown
  reqId?: unknown
  action?: unknown
  id?: unknown
  prop?: unknown
  selector?: unknown
  selectors?: unknown
  on?: unknown
  edits?: unknown
  targets?: unknown
  blob?: unknown
  resourceSession?: unknown
  x: number
  y: number
  dx?: number
  dy?: number
}

let watching = false
let changeFrame = 0
let resize: ResizeObserver | undefined

function annotationChanged(): void {
  if (!watching || changeFrame) return
  changeFrame = requestAnimationFrame(() => {
    changeFrame = 0
    if (watching) postToParent({ type: 'doop:annotation-layout', scrollX, scrollY })
  })
}

function watchAnnotations(on: boolean, selectors: unknown[]): void {
  watching = on
  resize?.disconnect()
  if (!on) return
  if (resize) {
    const targets = new Set<Element>([document.documentElement])
    for (const selector of selectors) {
      const el = styleTarget(selector)
      if (!el) continue
      targets.add(el)
      if (el.parentElement) targets.add(el.parentElement)
    }
    for (const el of targets) resize.observe(el)
  }
  annotationChanged()
}

export function annotationTarget(el: Element | null, x?: number, y?: number) {
  if (!el || el === document.body || el === document.documentElement) return null
  const component = el.closest('[data-doop-component], [data-doop-instance]')
  const child =
    x === undefined || y === undefined
      ? el.firstElementChild
      : (document.elementsFromPoint(viewX(x), viewX(y)).find((hit) => hit.parentElement === el) ?? el.firstElementChild)
  return {
    selector: cssPath(el),
    rect: designRect(el),
    tag: el.tagName.toLowerCase(),
    componentId:
      component?.getAttribute('data-doop-component') || component?.getAttribute('data-doop-instance') || null,
    parent: el.parentElement === document.body ? null : cssPath(el.parentElement),
    child: child ? cssPath(child) : null,
  }
}

export function annotationDetails(el: Element | null, x?: number, y?: number) {
  const target = annotationTarget(el, x, y)
  if (!el || !target) return null
  const cs = getComputedStyle(el)
  return {
    ...target,
    id: el.id,
    textEditable: textEditable(el) && !!el.textContent?.trim(),
    doopId: el.getAttribute('data-doop-id') || undefined,
    classes: Array.from(el.classList),
    text: ((el instanceof HTMLElement ? el.innerText : el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    attributes: Array.from(el.attributes, (attr) => [attr.name, attr.value.slice(0, 200)]),
    styles: Object.fromEntries(
      ['color', 'background-color', 'font-size', 'font-family', 'display', 'position'].map((name) => [
        name,
        cs.getPropertyValue(name),
      ]),
    ),
  }
}

let text: {
  id: unknown
  el: HTMLElement
  hit: ReturnType<typeof annotationDetails>
  before: string
  attribute: string | null
} | null = null
const textPreviews = new Map<Element, TextPreview>()

function textEditable(el: Element | null): el is HTMLElement {
  return (
    el instanceof HTMLElement &&
    el !== document.body &&
    el !== document.documentElement &&
    !el.isContentEditable &&
    !el.matches('input,textarea,select,script,style') &&
    Array.from(el.childNodes).every((node) => node.nodeType === Node.TEXT_NODE)
  )
}

function endText(mode: 'cancel' | 'revert' | 'save' | 'chat'): void {
  const edit = text
  if (!edit) return
  text = null
  const { el } = edit
  const after = el.childElementCount ? el.innerText : el.textContent
  if (edit.attribute === null) el.removeAttribute('contenteditable')
  else el.setAttribute('contenteditable', edit.attribute)
  if (el.textContent !== edit.before || el.childElementCount) el.textContent = edit.before
  if (document.activeElement === el) el.blur()
  window.getSelection()?.removeAllRanges()
  annotationChanged()
  if (mode !== 'cancel')
    postToParent({ type: 'doop:textEdit-finished', id: edit.id, mode, hit: edit.hit, before: edit.before, after })
}

function startText(d: AnnotationCommand): boolean {
  if (text) return false
  const el = document.elementFromPoint(viewX(d.x), viewX(d.y))
  if (!textEditable(el) || !el.textContent?.trim()) return false
  text = {
    id: d.id,
    el,
    hit: annotationDetails(el, d.x, d.y),
    before: el.textContent,
    attribute: el.getAttribute('contenteditable'),
  }
  el.setAttribute('contenteditable', 'plaintext-only')
  el.focus({ preventScroll: true })
  selectAllIn(el)
  return true
}

function syncText(edits: TextPreview[]): void {
  for (const [el, preview] of textPreviews) {
    if (
      edits.some(
        (edit) =>
          edit.id === preview.id &&
          edit.after === preview.after &&
          styleTarget(edit.selector) === el &&
          (el.textContent === preview.after || text?.el === el),
      )
    )
      continue
    if (textEditable(el) && el.textContent === preview.after) el.textContent = preview.before
    textPreviews.delete(el)
  }
  for (const edit of edits) {
    if (!edit.pending) continue
    const el = styleTarget(edit.selector)
    if (!textEditable(el) || el.textContent !== edit.before) continue
    el.textContent = edit.after
    textPreviews.set(el, edit)
  }
  annotationChanged()
}

const syncCss = annotationCss(
  styleTarget,
  () => document.createElement('div').style,
  (name, value) => CSS.supports(name, value),
  annotationChanged,
)

function scrollAnnotation(x: number, y: number, dx: number, dy: number): void {
  for (let el = document.elementFromPoint(viewX(x), viewX(y)); el && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el)
    const left = /^(auto|scroll)$/.test(cs.overflowX) ? dx : 0
    const top = /^(auto|scroll)$/.test(cs.overflowY) ? dy : 0
    if (
      (left < 0 && el.scrollLeft > 0) ||
      (left > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth) ||
      (top < 0 && el.scrollTop > 0) ||
      (top > 0 && el.scrollTop + el.clientHeight < el.scrollHeight)
    ) {
      el.scrollBy(left, top)
      return
    }
  }
  window.scrollBy(dx, dy)
}

const cropResourceReplies = new Map<number, (blob: unknown) => void>()
let nextCropResource = 0

function cropResource(session: string, url: string, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const id = ++nextCropResource
    const abort = () => {
      cropResourceReplies.delete(id)
      reject(signal.reason)
    }
    cropResourceReplies.set(id, (blob) => {
      cropResourceReplies.delete(id)
      signal.removeEventListener('abort', abort)
      if (blob instanceof Blob) resolve(blob)
      else reject(new Error('The proxy could not read the crop resource'))
    })
    signal.addEventListener('abort', abort, { once: true })
    postToParent({ type: 'doop:annotation-crop-resource', session, id, url })
  })
}

function capture(d: AnnotationCommand): void {
  const viewport = { width: frameWidth(), height: frameHeight(), scrollX, scrollY }
  let rects = Array.isArray(d.selectors)
    ? d.selectors.flatMap((selector) => {
        if (typeof selector !== 'string') return []
        try {
          const node = document.querySelector(selector)
          return node ? [designRect(node)] : []
        } catch {
          return []
        }
      })
    : []
  if (d.region)
    rects = [
      d.regionInPage ? { ...d.region, x: d.region.x - viewport.scrollX, y: d.region.y - viewport.scrollY } : d.region,
    ]
  const plan = planDesignCrop(rects, viewport, devicePixelRatio)
  const answer = (png: Blob | null) => postToParent({ type: 'doop:annotation-crop-result', reqId: d.reqId, plan, png })
  if (!plan || d.geometryOnly) return answer(null)

  let deadline: number | null = setTimeout(() => {
    deadline = null
    answer(null)
  }, 2500)
  const finish = (png: Blob | null) => {
    if (deadline === null) return
    clearTimeout(deadline)
    deadline = null
    answer(png)
  }
  const session = d.resourceSession
  const readFromProxy =
    browse && typeof session === 'string'
      ? (url: string, signal: AbortSignal) => cropResource(session, url, signal)
      : undefined
  void paintFrameCrop(plan, bleed, d.textEdit, readFromProxy).then(finish, () => finish(null))
}

export function annotationCommand(d: AnnotationCommand): void {
  if (d.type === 'doop:textEdit') {
    if (d.action === 'start') postToParent({ type: 'doop:textEdit-result', reqId: d.reqId, started: startText(d) })
    else if (d.action === 'cancel' && text?.id === d.id) endText('cancel')
    else if (d.action === 'sync' && Array.isArray(d.edits)) syncText(d.edits as TextPreview[])
  }
  if (d.type === 'doop:css') {
    if (d.action === 'inspect') {
      const el = styleTarget(d.selector)
      const css = el && getComputedStyle(el)
      const names = typeof d.prop === 'string' ? [d.prop] : css ? Array.from(css) : []
      const properties = css && Object.fromEntries(names.map((name) => [name, css.getPropertyValue(name)]))
      postToParent({ type: 'doop:css-result', reqId: d.reqId, properties })
    } else if (d.action === 'sync' && Array.isArray(d.targets)) syncCss(d.targets as PreviewTarget[])
  }
  if (d.type === 'doop:annotation-wheel') scrollAnnotation(d.x, d.y, d.dx ?? 0, d.dy ?? 0)
  if (d.type === 'doop:annotation-watch') watchAnnotations(!!d.on, Array.isArray(d.selectors) ? d.selectors : [])
  if (d.type === 'doop:annotation-crop') capture(d)
  if (d.type === 'doop:annotation-crop-resource-result' && typeof d.id === 'number')
    cropResourceReplies.get(d.id)?.(d.blob)
}

export function installAnnotations(): void {
  if (typeof ResizeObserver !== 'undefined') resize = new ResizeObserver(annotationChanged)
  window.addEventListener('scroll', annotationChanged, true)
  window.addEventListener('resize', annotationChanged)
  window.addEventListener(
    'keydown',
    (ev) => {
      if (!text || !isTrusted(ev) || ev.isComposing) return
      const mode =
        ev.key === 'Escape'
          ? 'revert'
          : ev.key === 'Enter'
            ? 'save'
            : (ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && shortcutKey(ev) === 'l'
              ? 'chat'
              : null
      if (!mode) return
      ev.preventDefault()
      ev.stopImmediatePropagation()
      endText(mode)
    },
    true,
  )
  window.addEventListener(
    'input',
    (ev) => {
      if (ev.target === text?.el) annotationChanged()
    },
    true,
  )
}
