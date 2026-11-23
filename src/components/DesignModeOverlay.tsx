import { DictateButton } from './DictateButton'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { hasInsetTrafficLights } from '../lib/shell'
import { markupPath, markupStrokeWidth, type MarkupStroke, type MarkupTool } from '../lib/designMarkup'
import type { DesignNote, NoteRect } from '../lib/designNotes'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Switch } from './ui/switch'
import { IconButton } from './ui/icon-button'
import {
  ArrowUpRightIcon,
  BoxIcon,
  CheckIcon,
  ChevronDownIcon,
  HotspotIcon,
  CircleIcon,
  EditIcon,
  MessageSquareIcon,
  PlusIcon,
  SlidersIcon,
  XIcon,
} from './ui/icons'
import { Textarea } from './ui/textarea'
import { DesignCssInspector } from './DesignCssInspector'
import type { useDesignMode } from './useDesignMode'

type Mode = ReturnType<typeof useDesignMode>

export function DesignModeToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  const t = useT()
  return (
    <IconButton
      size="sm"
      aria-label={t('panels.designAnnotate')}
      title={t('panels.designAnnotateShortcut')}
      aria-pressed={enabled}
      on={enabled}
      data-design-toggle=""
      onClick={onToggle}
    >
      <HotspotIcon size="rail" />
    </IconButton>
  )
}

export function DesignModeControls({ mode }: { mode: Mode }) {
  const t = useT()
  const manage = t('panels.designQueueToggle', { count: mode.pendingCount })
  const controls = useRef<HTMLDivElement>(null)
  const { queueOpen, setQueueOpen } = mode
  useEffect(() => {
    if (!queueOpen) return
    function dismiss(event: PointerEvent) {
      if (!(event.target instanceof Element) || controls.current?.contains(event.target)) return
      if (event.target.closest('[data-preview-chat-pending]')) return
      setQueueOpen(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [queueOpen, setQueueOpen])
  return (
    <div ref={controls} className="relative flex shrink-0 items-center">
      {mode.pendingCount > 0 ? (
        <div className="flex items-center rounded-pill bg-brand text-white">
          <Button
            size="pill"
            variant="bare"
            disabled={mode.busy}
            className="h-6 gap-1 rounded-r-none px-1.5 text-white hover:bg-white/15 hover:text-white"
            aria-label={t('panels.designSendToAgent', { count: mode.pendingCount })}
            title={t('panels.designSendToAgent', { count: mode.pendingCount })}
            onClick={() => void mode.sendPending()}
          >
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-white/20 px-0.5">
              {mode.pendingCount}
            </span>
            {t('panels.designSendAction')}
          </Button>
          <IconButton
            size="sm"
            className="h-6 w-5 rounded-l-none rounded-r-full border-l border-white/20 text-white hover:bg-white/15 hover:text-white"
            aria-label={manage}
            title={mode.enabled ? manage : t('panels.designShowPending')}
            aria-expanded={mode.queueOpen}
            onClick={() => mode.setQueueOpen(!mode.queueOpen)}
          >
            <ChevronDownIcon size={12} />
          </IconButton>
        </div>
      ) : (
        <>
          {mode.saved.notes.length > 0 && (
            <IconButton
              size="sm"
              aria-label={t('panels.designQueue')}
              aria-expanded={mode.queueOpen}
              on={mode.queueOpen}
              onClick={() => mode.setQueueOpen(!mode.queueOpen)}
            >
              <MessageSquareIcon size="rail" />
            </IconButton>
          )}
        </>
      )}
      {mode.queueOpen && <AnnotationQueue mode={mode} />}
    </div>
  )
}

const markupTools = [
  { tool: 'draw', label: 'panels.designMarkupDraw', Icon: EditIcon },
  { tool: 'ellipse', label: 'panels.designMarkupEllipse', Icon: CircleIcon },
  { tool: 'rectangle', label: 'panels.designMarkupRectangle', Icon: BoxIcon },
  { tool: 'arrow', label: 'panels.designMarkupArrow', Icon: ArrowUpRightIcon },
] as const satisfies readonly { tool: MarkupTool; label: string; Icon: unknown }[]

export function DesignModeHint({ mode }: { mode: Mode }) {
  const t = useT()
  const canEditText = mode.draft?.elements.length === 1 && mode.draft.elements[0]?.textEditable
  const message = t(
    mode.editingText
      ? 'panels.designTextEditingHint'
      : mode.draft?.region
        ? 'panels.designMarkupHint'
        : canEditText
          ? 'panels.designTextNoteHint'
          : mode.region || mode.draft
            ? 'panels.designNoteHint'
            : 'panels.designPickHint',
  )
  return (
    <div
      data-design-hint=""
      className={cn(
        'flex min-w-0 flex-1 items-center gap-1 text-caption text-brand',
        hasInsetTrafficLights() && 'pl-[76px]',
      )}
    >
      <IconButton size="sm" className="text-brand" aria-label={t('panels.designExit')} onClick={mode.exit}>
        <XIcon size="rail" />
      </IconButton>
      {mode.draft?.region && (
        <div className="flex shrink-0 items-center" role="group" aria-label={t('panels.designMarkupTools')}>
          {markupTools.map(({ tool, label, Icon }) => (
            <IconButton
              key={tool}
              data-design-markup-tool={tool}
              size="sm"
              on={mode.markupTool === tool}
              aria-pressed={mode.markupTool === tool}
              aria-label={t(label)}
              title={t(label)}
              onClick={() => mode.setMarkupTool(mode.markupTool === tool ? 'move' : tool)}
            >
              <Icon size={14} />
            </IconButton>
          ))}
        </div>
      )}
      <span className="truncate" title={message}>
        {message}
      </span>
    </div>
  )
}

interface Surface {
  x: number
  y: number
  width: number
  height: number
  scale: number
  viewportWidth: number
  viewportHeight: number
}

function useSurface(viewportRef: RefObject<HTMLDivElement>, screen: number, revision: number) {
  const [surface, setSurface] = useState<Surface>()
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const iframe = viewport?.querySelector<HTMLIFrameElement>(
      `[data-proto-entry="${screen}"] iframe, iframe[data-design-screen="${screen}"]`,
    )
    if (!viewport || !iframe) return
    function measure() {
      const parent = viewport!.getBoundingClientRect()
      const rect = iframe!.getBoundingClientRect()
      const next = {
        x: rect.left - parent.left,
        y: rect.top - parent.top,
        width: rect.width,
        height: rect.height,
        scale: iframe!.offsetWidth ? rect.width / iframe!.offsetWidth : 1,
        viewportWidth: viewport!.clientWidth,
        viewportHeight: viewport!.clientHeight,
      }
      setSurface((previous) =>
        previous && Object.entries(next).every(([key, value]) => previous[key as keyof Surface] === value)
          ? previous
          : next,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(iframe.parentElement!)
    viewport.addEventListener('scroll', measure, true)
    return () => {
      observer.disconnect()
      viewport.removeEventListener('scroll', measure, true)
    }
  }, [viewportRef, screen, revision])
  return surface
}

function box(rect: NoteRect, surface: Surface) {
  return {
    left: surface.x + rect.x * surface.scale,
    top: surface.y + rect.y * surface.scale,
    width: rect.width * surface.scale,
    height: rect.height * surface.scale,
  }
}

const inset = 8
const shell = 'rounded-control border border-line bg-surface text-ink shadow-pop'

export function DesignModeOverlay({
  mode,
  screen,
  revision,
  viewportRef,
  getWindow,
}: {
  mode: Mode
  frameId?: string
  screen: number
  revision: number
  viewportRef: RefObject<HTMLDivElement>
  getWindow: () => Window | undefined
}) {
  const t = useT()
  const surface = useSurface(viewportRef, screen, revision)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const cssButtonRef = useRef<HTMLButtonElement>(null)
  const shieldRef = useRef<HTMLDivElement>(null)
  const picking = mode.enabled && !mode.usingPage && !mode.editingText
  const cardOpen = picking && !!mode.draft

  useLayoutEffect(() => {
    if (cardOpen) fieldRef.current?.focus({ preventScroll: true })
    else if (picking) shieldRef.current?.focus({ preventScroll: true })
  }, [cardOpen, picking])

  useLayoutEffect(() => {
    const shield = shieldRef.current
    if (!picking || !shield || !surface) return
    function wheel(event: WheelEvent) {
      if (event.ctrlKey || event.metaKey) return
      event.preventDefault()
      const bounds = shield!.getBoundingClientRect()
      const scale = surface!.scale || 1
      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? bounds.height
            : 1
      getWindow()?.postMessage(
        {
          type: 'doop:annotation-wheel',
          x: (event.clientX - bounds.left) / scale,
          y: (event.clientY - bounds.top) / scale,
          dx: (event.deltaX * delta) / scale,
          dy: (event.deltaY * delta) / scale,
        },
        '*',
      )
    }
    shield.addEventListener('wheel', wheel, { passive: false })
    return () => shield.removeEventListener('wheel', wheel)
  }, [picking, surface, getWindow])

  const gesture = useRef<{ id: number; mouse: boolean }>()
  const handlers = useRef(mode)
  useLayoutEffect(() => {
    handlers.current = mode
  })
  useLayoutEffect(() => {
    const shield = shieldRef.current
    if (!picking || !shield || !surface) return
    const scale = surface.scale
    function cancel(event?: PointerEvent) {
      if (!gesture.current || (event && event.pointerId !== gesture.current.id)) return
      gesture.current = undefined
      handlers.current.cancelPointer()
    }
    function finish(event: MouseEvent, id: number) {
      if (event.button !== 0 || gesture.current?.id !== id) return
      gesture.current = undefined
      handlers.current.pointerUp(designPoint(event, shield!, scale), id, event.shiftKey, event.altKey, scale)
    }
    function up(event: PointerEvent) {
      finish(event, event.pointerId)
    }
    function mouseUp(event: MouseEvent) {
      const active = gesture.current
      if (active?.mouse) finish(event, active.id)
    }
    function move(event: PointerEvent) {
      const active = gesture.current
      if (!active || event.pointerId !== active.id) return
      if (active.mouse && !(event.buttons & 1)) {
        cancel(event)
        return
      }
      handlers.current.pointerMove(designPoint(event, shield!, scale), event.shiftKey, event.altKey, scale)
    }
    const blur = () => cancel()
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('mouseup', mouseUp, true)
    window.addEventListener('pointercancel', cancel, true)
    shield.addEventListener('lostpointercapture', cancel)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('mouseup', mouseUp, true)
      window.removeEventListener('pointercancel', cancel, true)
      shield.removeEventListener('lostpointercapture', cancel)
      window.removeEventListener('blur', blur)
      cancel()
    }
  }, [picking, surface, revision])

  if (!mode.allowed) return null
  const { draft, hover } = mode
  const selected =
    draft?.elements.map((el, index) => (index === 0 && draft.id && mode.pins[draft.id]?.rect) || el.rect) ?? []
  const draftRegion = draft && mode.visibleRegion(draft)
  const anchors = draftRegion ? [draftRegion] : selected
  const cardWidth = Math.min(290, Math.max(0, (surface?.viewportWidth ?? 290) - 2 * inset))
  const right = Math.max(...anchors.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...anchors.map((rect) => rect.y + rect.height))
  const cardLeft =
    surface && anchors.length
      ? Math.max(inset, Math.min(surface.x + right * surface.scale, surface.viewportWidth - inset) - cardWidth)
      : inset
  const top = Math.min(...anchors.map((rect) => rect.y))
  const comment = draft?.comment.trim()
  const canSubmit = !!(comment || draft?.textEdit || draft?.cssEdits?.length || draft?.markup?.length)
  const rows = Math.min(3, (draft?.comment ?? '').split('\n').length)
  const cardHeight = (canSubmit || draft?.id ? 58 : 34) + (rows - 1) * 20
  let cardTop = inset
  if (surface && anchors.length) {
    const below = surface.y + bottom * surface.scale + inset
    const above = surface.y + top * surface.scale - cardHeight - inset
    const limit = surface.viewportHeight - cardHeight - inset
    // Keep the note from covering the selected text before the second click.
    cardTop = below > limit && above >= inset ? above : Math.max(inset, Math.min(below, limit))
  }
  const cssBelow = (surface?.viewportHeight ?? 0) - cardTop - cardHeight - 2 * inset
  const cssAbove = cardTop - 2 * inset
  const cssOnTop = cssBelow < 210 && cssAbove > cssBelow
  const submitLabel = t(draft?.id ? 'panels.designSave' : mode.saved.batch ? 'panels.designStack' : 'panels.designSend')
  const tagBadge = 'absolute right-0 bottom-full max-w-full truncate rounded-row bg-brand px-1 text-micro/4 text-white'

  return (
    <div className="pointer-events-none absolute inset-0 z-[6] text-ink" data-design-overlay="">
      {surface && surface.scale > 0 && (
        <>
          {picking && (
            <div
              ref={shieldRef}
              tabIndex={-1}
              data-design-shield=""
              className={cn(
                'pointer-events-auto absolute touch-none outline-none select-none',
                draftRegion && mode.markupTool === 'move' ? 'cursor-default' : 'cursor-crosshair',
              )}
              style={{ left: surface.x, top: surface.y, width: surface.width, height: surface.height }}
              onPointerDown={(e) => {
                if (e.button !== 0 || !e.isPrimary) return
                if (gesture.current) mode.cancelPointer()
                const mouse = e.pointerType === 'mouse'
                // Keep compatibility mouseup enabled. Capture touch/pen; the shield
                // and the window listeners already cover the mouse.
                if (!mouse) e.currentTarget.setPointerCapture(e.pointerId)
                if (!draft || draft.region) e.currentTarget.focus({ preventScroll: true })
                gesture.current = { id: e.pointerId, mouse }
                mode.pointerDown(designPoint(e, e.currentTarget, surface.scale), e.pointerId)
              }}
              onPointerMove={(e) => {
                if (!gesture.current) {
                  mode.pointerMove(designPoint(e, e.currentTarget, surface.scale), e.shiftKey, e.altKey, surface.scale)
                }
              }}
              onMouseDown={(event) => {
                if (draft) event.preventDefault()
              }}
              onDoubleClick={(event) => {
                if (!draft?.region && !event.altKey && !event.shiftKey)
                  void mode.startTextEdit(designPoint(event, event.currentTarget, surface.scale))
              }}
              onPointerLeave={mode.clearHover}
            />
          )}
          {picking && hover && !draft?.elements.some((el) => el.selector === hover.selector) && (
            <div
              data-design-hover={hover.selector}
              className="absolute outline-1 outline-brand"
              style={box(hover.rect, surface)}
            >
              <span className={tagBadge}>{hover.tag}</span>
            </div>
          )}
          {picking &&
            draft?.elements.map((el, index) => (
              <div
                key={el.selector}
                data-design-selection=""
                className="absolute bg-brand/10 outline-1 outline-brand"
                style={box(selected[index]!, surface)}
              >
                <span className={tagBadge}>{el.tag}</span>
              </div>
            ))}
          {picking && (mode.region ?? draftRegion) && (
            <div
              data-design-region=""
              className="absolute border-2 border-dashed border-brand bg-brand/10"
              style={box((mode.region ?? draftRegion)!, surface)}
            />
          )}
          {picking && (
            <MarkupLayer
              surface={surface}
              offset={mode.pageOffset}
              groups={[
                ...mode.pageNotes
                  .filter((note) => note.id !== draft?.id && note.markup?.length)
                  .map((note) => ({ id: note.id, status: note.status, markup: note.markup! })),
                ...(draft?.region && (draft.markup?.length || mode.markupStroke)
                  ? [
                      {
                        id: 'draft',
                        status: 'draft',
                        markup: [...(draft.markup ?? []), ...(mode.markupStroke ? [mode.markupStroke] : [])],
                      },
                    ]
                  : []),
              ]}
            />
          )}
          {picking &&
            mode.pageNotes.map((note) => {
              const pin = mode.pins[note.id]
              const rect = note.region
                ? mode.visibleRegion(note)
                : (pin?.rect ?? note.lastRect ?? note.elements[0]?.rect)
              if (!rect) return null
              const { left, top, width } = box(rect, surface)
              const title = t('panels.designPin', { number: note.number })
              return (
                <IconButton
                  key={note.id}
                  data-design-pin={note.number}
                  data-status={note.status}
                  size="sm"
                  shape="round"
                  aria-label={title}
                  title={pin?.missing ? `${title} · ${t('panels.designMissing')}` : title}
                  disabled={mode.busy}
                  className={cn(
                    'pointer-events-auto absolute z-10 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-brand text-micro font-semibold text-white hover:bg-brand/90 hover:text-white',
                    (note.status === 'sent' || pin?.missing) && 'opacity-55',
                  )}
                  style={{ left: left + width, top }}
                  onClick={() => mode.openNote(note)}
                >
                  {note.number}
                </IconButton>
              )
            })}
        </>
      )}
      {cardOpen && draft && (
        <section
          data-design-card=""
          role="group"
          aria-label={t('panels.designNote')}
          className={cn(shell, 'dark pointer-events-auto absolute z-30 grid gap-1 px-2 py-1')}
          style={{ width: cardWidth, left: cardLeft, top: cardTop }}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <SelectionToken draft={draft} />
            <Textarea
              ref={fieldRef}
              data-design-note-field=""
              aria-label={t('panels.designDescribe')}
              placeholder={draft.textEdit ? `“${draft.textEdit.after}”` : t('panels.designDescribe')}
              variant="bare"
              rows={rows}
              className="min-w-0 flex-1 text-caption/5 md:text-caption/5"
              value={draft.comment}
              readOnly={mode.busy}
              onChange={(e) => mode.setComment(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              onKeyUp={(e) => e.stopPropagation()}
            />
            {draft.elements.length === 1 && !draft.textEdit && (
              <IconButton
                ref={cssButtonRef}
                size="sm"
                className="size-5"
                aria-label={t('panels.designCssEdit')}
                title={t('panels.designCssEdit')}
                aria-expanded={!!mode.cssInspector}
                onClick={() => void mode.toggleCssInspector()}
                disabled={mode.busy}
              >
                <SlidersIcon size={13} />
              </IconButton>
            )}
            {!canSubmit && !draft.id && (
              <IconButton size="sm" className="size-5" aria-label={submitLabel} disabled>
                <span aria-hidden="true">↵</span>
              </IconButton>
            )}
          </div>
          {mode.cssInspector && (
            <DesignCssInspector
              properties={mode.cssInspector.properties}
              edits={draft.cssEdits ?? []}
              above={cssOnTop}
              maxHeight={Math.min(270, Math.max(124, cssOnTop ? cssAbove : cssBelow))}
              onChange={mode.setCssProperty}
              onAdd={mode.addCssProperty}
              onClose={() => {
                mode.closeCssInspector()
                cssButtonRef.current?.focus()
              }}
            />
          )}
          {(canSubmit || draft.id) && (
            <div className="flex items-center justify-between gap-1">
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-caption text-ink-soft">
                {t('panels.designBatch')}
                <Switch
                  size="sm"
                  aria-label={t('panels.designBatch')}
                  title={t('panels.designBatch')}
                  checked={mode.saved.batch}
                  disabled={mode.busy}
                  onCheckedChange={mode.setBatch}
                />
              </label>
              <div className="flex items-center gap-1">
                {(comment || draft.textEdit || !!draft.cssEdits?.length) && (
                  <DictateButton text={draft.comment} onText={mode.setComment} disabled={mode.busy} />
                )}
                {draft.id && (
                  <IconButton
                    size="sm"
                    variant="danger"
                    className="size-5"
                    aria-label={t('panels.designDelete')}
                    disabled={mode.busy}
                    onClick={() => mode.deleteNote(draft.id!)}
                  >
                    <XIcon size={12} />
                  </IconButton>
                )}
                <IconButton
                  size="sm"
                  shape="round"
                  variant="primary"
                  className="size-5"
                  aria-label={submitLabel}
                  disabled={!canSubmit || mode.busy}
                  onClick={() => void mode.submit()}
                >
                  {draft.id ? (
                    <CheckIcon size={12} />
                  ) : mode.saved.batch ? (
                    <PlusIcon size={12} />
                  ) : (
                    <span aria-hidden="true">↵</span>
                  )}
                </IconButton>
              </div>
            </div>
          )}
          {mode.sendError && (
            <p role="alert" className="text-caption text-accent-ink">
              {mode.sendError}
            </p>
          )}
        </section>
      )}
    </div>
  )
}

function MarkupLayer({
  surface,
  offset,
  groups,
}: {
  surface: Surface
  offset: { x: number; y: number }
  groups: { id: string; status: string; markup: MarkupStroke[] }[]
}) {
  if (!groups.length) return null
  const { x, y, width, height, scale } = surface
  return (
    <svg
      aria-hidden="true"
      data-design-markup=""
      className="pointer-events-none absolute overflow-visible text-brand"
      style={{ left: x, top: y, width, height }}
      viewBox={`${offset.x} ${offset.y} ${width / scale} ${height / scale}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={markupStrokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {groups.map(({ id, status, markup }) => (
        <g key={id} data-markup-status={status} opacity={status === 'sent' ? 0.55 : 1}>
          {markup.map((item, index) => (
            <path key={index} data-markup-tool={item.tool} d={markupPath(item)} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      ))}
    </svg>
  )
}

function designPoint(event: { clientX: number; clientY: number }, shield: HTMLDivElement, scale: number) {
  const bounds = shield.getBoundingClientRect()
  return { x: (event.clientX - bounds.left) / scale, y: (event.clientY - bounds.top) / scale }
}

function SelectionToken({ draft }: { draft: NonNullable<Mode['draft']> }) {
  const t = useT()
  const chip = 'shrink-0 truncate rounded-row bg-brand/10 px-1 text-micro/4 font-semibold text-brand'
  const region = draft.region
  return (
    <div className="flex max-w-[42%] shrink-0 gap-0.5 overflow-auto" data-design-token="">
      {region ? (
        <span className={chip}>
          {t('panels.designRegion', { width: Math.round(region.width), height: Math.round(region.height) })}
        </span>
      ) : (
        draft.elements.map((el) => (
          <span className={chip} key={el.selector} title={el.selector}>
            {el.tag}
          </span>
        ))
      )}
    </div>
  )
}

function AnnotationQueue({ mode }: { mode: Mode }) {
  const t = useT()
  const [showResolved, setShowResolved] = useState(false)
  const pending = mode.saved.notes.filter((note) => note.status === 'pending')
  const sent = mode.saved.notes.filter((note) => note.status === 'sent' || (showResolved && note.status === 'resolved'))
  const row = (note: DesignNote) => {
    const remove = t('panels.designRemove', { number: note.number })
    const element = note.elements[0]
    const selector = element
      ? [element.tag, ...element.classes].join('.')
      : note.region &&
        t('panels.designRegion', { width: Math.round(note.region.width), height: Math.round(note.region.height) })
    const visibleText = (note.textEdit?.after ?? element?.text)?.replace(/\s+/g, ' ').trim().slice(0, 80)
    return (
      <li
        key={note.id}
        data-design-queue-note={note.status}
        className={cn('flex min-w-0 items-center gap-1', note.status !== 'pending' && 'opacity-65')}
      >
        <Button
          size="sm"
          variant="bare"
          className="h-6 min-w-0 flex-1 justify-start gap-1 px-0.5 text-caption text-ink"
          title={[selector, visibleText && `“${visibleText}”`, note.comment].filter(Boolean).join(' ')}
          aria-label={`${note.number}. ${note.textEdit ? `“${visibleText}”` : note.comment || (note.cssEdits?.length ? t('panels.designCssChanges') : '')}`}
          disabled={mode.busy}
          onClick={() => mode.openNote(note)}
        >
          <span className="grid h-3.5 min-w-3.5 shrink-0 place-items-center rounded-row bg-brand px-0.5 text-micro text-white">
            {note.number}
          </span>
          <span className="max-w-[50%] truncate">
            {selector}
            {visibleText && <span className="ml-1 text-ink-soft">“{visibleText}”</span>}
          </span>
          <span className="min-w-0 flex-1 truncate text-left">
            {note.comment || (note.cssEdits?.length ? t('panels.designCssChanges') : '')}
          </span>
          {note.textEdit && <span className="shrink-0 rounded-row bg-brand/10 px-1 text-brand">T</span>}
          {note.elements.length > 1 && (
            <span className="shrink-0 rounded-row bg-brand/10 px-1 text-brand">+{note.elements.length - 1}</span>
          )}
        </Button>
        {note.status !== 'pending' && (
          <>
            {note.status === 'sent' && (
              <IconButton
                size="sm"
                aria-label={t('panels.designResolve')}
                disabled={mode.busy}
                onClick={() => mode.resolve(note.id)}
              >
                <CheckIcon size="rail" />
              </IconButton>
            )}
            <Button
              size="pill"
              variant="default"
              aria-label={t('panels.designResend')}
              title={t('panels.designResend')}
              disabled={mode.busy}
              onClick={() => void mode.sendNotes([note])}
            >
              {t('panels.designResend')}
            </Button>
          </>
        )}
        <IconButton
          size="sm"
          variant="danger"
          aria-label={remove}
          disabled={mode.busy}
          onClick={() => mode.deleteNote(note.id)}
        >
          <XIcon size="rail" />
        </IconButton>
      </li>
    )
  }
  return (
    <section
      data-design-queue=""
      role="region"
      aria-label={t('panels.designQueue')}
      className={cn(
        shell,
        'absolute right-0 top-full z-30 mt-1.5 grid max-h-[60vh] w-[min(300px,calc(100cqw-76px))] grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-2 p-2',
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="truncate text-caption text-ink-soft">{t('panels.designEdits', { count: pending.length })}</h2>
        <Button
          size="pill"
          variant="bare"
          className="h-5 px-1 text-caption text-ink-soft"
          aria-label={t('panels.designClear')}
          disabled={mode.busy || pending.length === 0}
          onClick={() => {
            mode.clearPending()
            mode.setQueueOpen(false)
          }}
        >
          {t('panels.designClear')}
        </Button>
      </header>
      <div className="grid grid-cols-1 gap-2 overflow-y-auto">
        {pending.length > 0 && <ol>{pending.map(row)}</ol>}
        {mode.saved.notes.some((note) => note.status !== 'pending') && (
          <div className="grid grid-cols-1 gap-1">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-caption text-ink-soft">{t('panels.designSent')}</h3>
              <label className="inline-flex items-center gap-1.5 text-caption text-ink-soft">
                <Checkbox checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
                {t('panels.designShowResolved')}
              </label>
            </div>
            <ol>{sent.map(row)}</ol>
          </div>
        )}
        {!mode.saved.notes.length && <p className="text-caption text-ink-soft">{t('panels.designEmpty')}</p>}
        {mode.sendError && (
          <p role="alert" className="text-caption text-accent-ink">
            {mode.sendError}
          </p>
        )}
      </div>
    </section>
  )
}
