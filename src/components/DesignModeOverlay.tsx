import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { DesignNote, NoteRect } from '../lib/designNotes'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Switch } from './ui/switch'
import { IconButton } from './ui/icon-button'
import { AnnotationIcon, CheckIcon, MessageSquareIcon, XIcon } from './ui/icons'
import { Textarea } from './ui/textarea'
import type { useDesignMode } from './useDesignMode'

type Mode = ReturnType<typeof useDesignMode>

export function DesignModeControls({ mode }: { mode: Mode }) {
  const t = useT()
  const manage = t('panels.designQueueToggle', { count: mode.pendingCount })
  return (
    <div className="flex shrink-0 items-center gap-0.5 border-l border-line pl-1 sm:pl-2">
      {mode.pendingCount > 0 ? (
        <Button
          size="pill"
          variant="default"
          disabled={mode.busy}
          aria-label={t('panels.designSendToAgent', { count: mode.pendingCount })}
          title={t('panels.designSendToAgent', { count: mode.pendingCount })}
          onClick={() => void mode.sendPending()}
        >
          {t('panels.designSendCount', { count: mode.pendingCount })}
        </Button>
      ) : (
        <IconButton
          size="sm"
          aria-label={t('panels.designAnnotate')}
          aria-pressed={mode.enabled}
          on={mode.enabled}
          title={t('panels.designAnnotateShortcut')}
          className="w-auto min-w-6 gap-1 px-1 sm:inline-flex"
          onClick={mode.toggle}
        >
          <AnnotationIcon size="rail" />
          <span className="hidden px-0.5 text-caption @min-[650px]:inline">{t('panels.designAnnotate')}</span>
        </IconButton>
      )}
      {mode.saved.notes.length > 0 && (
        <IconButton
          size="sm"
          aria-label={mode.pendingCount ? manage : t('panels.designQueue')}
          aria-expanded={mode.queueOpen}
          on={mode.queueOpen}
          onClick={() => mode.setQueueOpen(!mode.queueOpen)}
        >
          <MessageSquareIcon size="rail" />
        </IconButton>
      )}
    </div>
  )
}

export function DesignModeHint({ mode }: { mode: Mode }) {
  const t = useT()
  const message = t(
    mode.region ? 'panels.designDragHint' : mode.draft ? 'panels.designNoteHint' : 'panels.designPickHint',
  )
  if (!mode.enabled) return null
  return (
    <div
      data-design-hint=""
      className="relative z-10 flex min-h-9 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 py-1 text-caption sm:px-3"
    >
      <AnnotationIcon size="rail" className="shrink-0 text-brand" />
      <span className="min-w-0 flex-1 truncate text-ink-soft" title={message}>
        {message}
      </span>
      <Button
        size="pill"
        variant="default"
        aria-label={t('panels.designExit')}
        title={t('panels.designExit')}
        onClick={mode.exit}
      >
        {t('panels.designExit')}
      </Button>
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
    const iframe = viewport?.querySelector<HTMLIFrameElement>(`[data-proto-entry="${screen}"] iframe`)
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

function box(rect: NoteRect, surface: Surface): CSSProperties {
  return {
    left: surface.x + rect.x * surface.scale,
    top: surface.y + rect.y * surface.scale,
    width: rect.width * surface.scale,
    height: rect.height * surface.scale,
  }
}

const inset = 8
const shell = 'rounded-card border border-line bg-surface text-ink shadow-pop'

export function DesignModeOverlay({
  mode,
  frameId,
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
  const shieldRef = useRef<HTMLDivElement>(null)
  const cardOpen = !!mode.draft

  useLayoutEffect(() => {
    if (cardOpen) fieldRef.current?.focus({ preventScroll: true })
    else if (mode.enabled) shieldRef.current?.focus({ preventScroll: true })
  }, [cardOpen, mode.enabled])

  useLayoutEffect(() => {
    const shield = shieldRef.current
    if (!mode.enabled || !shield || !surface) return
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
  }, [mode.enabled, surface, getWindow])

  if (!mode.allowed) return null
  const { draft, hover } = mode
  const selection = draft?.region ?? (draft?.id ? mode.pins[draft.id]?.rect : undefined) ?? draft?.elements[0]?.rect
  const cardWidth = Math.min(320, (surface?.viewportWidth ?? 320) - 2 * inset)
  const cardLeft =
    surface && selection
      ? Math.min(
          Math.max(inset, surface.x + (selection.x + selection.width) * surface.scale + inset),
          surface.viewportWidth - cardWidth - inset,
        )
      : inset
  const cardTop =
    surface && selection
      ? Math.max(inset, Math.min(surface.y + selection.y * surface.scale, surface.viewportHeight - 235))
      : inset

  return (
    <div className="pointer-events-none absolute inset-0 z-[6] text-ink" data-design-overlay="">
      {surface && surface.scale > 0 && (
        <>
          {mode.enabled && (
            <div
              ref={shieldRef}
              tabIndex={-1}
              data-design-shield=""
              className="pointer-events-auto absolute cursor-crosshair touch-none outline-none"
              style={{ left: surface.x, top: surface.y, width: surface.width, height: surface.height }}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.preventDefault()
                if (!draft) e.currentTarget.focus({ preventScroll: true })
                e.currentTarget.setPointerCapture(e.pointerId)
                mode.pointerDown(designPoint(e, surface.scale), e.pointerId)
              }}
              onPointerMove={(e) => mode.pointerMove(designPoint(e, surface.scale), e.shiftKey, e.altKey)}
              onPointerUp={(e) => mode.pointerUp(designPoint(e, surface.scale), e.pointerId, e.shiftKey, e.altKey)}
              onPointerCancel={mode.cancelDrag}
              onPointerLeave={mode.clearHover}
            />
          )}
          {mode.enabled && hover && (
            <div
              data-design-hover={hover.selector}
              className="absolute outline-2 outline-brand"
              style={box(hover.rect, surface)}
            >
              <span
                className={cn(
                  'absolute left-0 top-0 max-w-[180px] truncate bg-brand px-1.5 py-0.5 text-caption font-semibold text-white',
                  surface.y + hover.rect.y * surface.scale < 22 ? 'rounded-b-row' : '-translate-y-full rounded-t-row',
                )}
              >
                {mode.label(hover)}
              </span>
            </div>
          )}
          {mode.enabled &&
            draft?.elements.map((el, index) => (
              <div
                key={el.selector}
                data-design-selection=""
                className="absolute bg-brand/10 outline-2 outline-brand"
                style={box((index === 0 && draft.id && mode.pins[draft.id]?.rect) || el.rect, surface)}
              />
            ))}
          {mode.enabled && (mode.region ?? draft?.region) && (
            <div
              data-design-region=""
              className="absolute border-2 border-dashed border-brand bg-brand/10"
              style={box((mode.region ?? draft?.region)!, surface)}
            />
          )}
          {mode.saved.notes
            .filter((note) => note.frameId === frameId && note.status !== 'resolved')
            .map((note) => {
              const pin = mode.pins[note.id]
              const rect = pin?.rect ?? note.lastRect ?? note.elements[0]?.rect ?? note.region
              if (!rect) return null
              const { left, top } = box(rect, surface)
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
                    'pointer-events-auto absolute z-10 size-[22px] rounded-full bg-brand text-caption font-semibold text-white shadow-pop hover:bg-brand/90 hover:text-white',
                    (note.status === 'sent' || pin?.missing) && 'opacity-55',
                  )}
                  style={{ left, top }}
                  onClick={() => mode.openNote(note)}
                >
                  {note.number}
                </IconButton>
              )
            })}
        </>
      )}
      {mode.enabled && draft && (
        <section
          data-design-card=""
          role="group"
          aria-label={t('panels.designNote')}
          className={cn(
            shell,
            'pointer-events-auto absolute z-30 grid max-h-[calc(100%-48px)] gap-2 overflow-auto p-3',
          )}
          style={{ width: cardWidth, left: cardLeft, top: cardTop }}
        >
          <div className="flex items-start justify-between gap-2">
            <SelectionToken draft={draft} />
            <IconButton
              size="sm"
              variant="danger"
              aria-label={t('panels.designDelete')}
              disabled={mode.busy}
              onClick={() => (draft.id ? mode.deleteNote(draft.id) : mode.escape())}
            >
              <XIcon size="rail" />
            </IconButton>
          </div>
          <Textarea
            ref={fieldRef}
            data-design-note-field=""
            aria-label={t('panels.designDescribe')}
            placeholder={t('panels.designDescribe')}
            rows={3}
            className="min-h-16 resize-y"
            value={draft.comment}
            readOnly={mode.busy}
            onChange={(e) => mode.setComment(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            onKeyUp={(e) => e.stopPropagation()}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-caption text-ink-soft">
              <Switch
                size="sm"
                aria-label={t('panels.designBatch')}
                title={t('panels.designBatch')}
                checked={mode.saved.batch}
                disabled={mode.busy}
                onCheckedChange={mode.setBatch}
              />
              {t('panels.designBatch')}
            </label>
            <Button
              size="sm"
              aria-label={t(
                draft.id ? 'panels.designSave' : mode.saved.batch ? 'panels.designStack' : 'panels.designSend',
              )}
              title={t(draft.id ? 'panels.designSave' : mode.saved.batch ? 'panels.designStack' : 'panels.designSend')}
              disabled={!draft.comment.trim() || mode.busy}
              onClick={() => void mode.submit()}
            >
              {t(draft.id ? 'panels.designSave' : mode.saved.batch ? 'panels.designStack' : 'panels.designSend')}
            </Button>
          </div>
          {mode.sendError && (
            <p role="alert" className="text-caption text-accent-ink">
              {mode.sendError}
            </p>
          )}
        </section>
      )}
      {mode.queueOpen && <AnnotationQueue mode={mode} />}
    </div>
  )
}

function designPoint(event: { currentTarget: HTMLDivElement; clientX: number; clientY: number }, scale: number) {
  const bounds = event.currentTarget.getBoundingClientRect()
  return { x: (event.clientX - bounds.left) / scale, y: (event.clientY - bounds.top) / scale }
}

function SelectionToken({ draft }: { draft: NonNullable<Mode['draft']> }) {
  const t = useT()
  const selected = draft.region
    ? t('panels.designRegion', { width: Math.round(draft.region.width), height: Math.round(draft.region.height) })
    : t(draft.elements.length > 1 ? 'panels.designSelectedMany' : 'panels.designSelected', {
        label: draft.elements[0]?.label ?? '',
        count: draft.elements.length - 1,
      })
  return (
    <span
      data-design-token=""
      className="truncate rounded-row bg-brand/10 px-2 py-1 text-caption font-semibold text-brand"
      title={selected}
    >
      {selected}
    </span>
  )
}

function AnnotationQueue({ mode }: { mode: Mode }) {
  const t = useT()
  const [showResolved, setShowResolved] = useState(false)
  const pending = mode.saved.notes.filter((note) => note.status === 'pending')
  const sent = mode.saved.notes.filter((note) => note.status === 'sent' || (showResolved && note.status === 'resolved'))
  const row = (note: DesignNote) => {
    const remove = t('panels.designRemove', { number: note.number })
    return (
      <li
        key={note.id}
        data-design-queue-note={note.status}
        className={cn('flex min-w-0 items-center gap-1', note.status !== 'pending' && 'opacity-65')}
      >
        <Button
          size="sm"
          variant="bare"
          className="min-w-0 flex-1 justify-start px-1 py-1.5 text-body"
          title={note.comment}
          aria-label={`${note.number}. ${note.comment}`}
          disabled={mode.busy}
          onClick={() => mode.openNote(note)}
        >
          <span className="truncate">
            {note.number}. {note.comment}
          </span>
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
        'pointer-events-auto absolute right-2 z-30 grid max-h-[65%] w-[min(340px,calc(100%-16px))] gap-2 overflow-auto p-3',
        'top-2',
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-body font-semibold">{t('panels.designQueue')}</h2>
        <IconButton size="sm" aria-label={t('common.close')} onClick={() => mode.setQueueOpen(false)}>
          <XIcon size="rail" />
        </IconButton>
      </header>
      {pending.length > 0 && (
        <div className="grid gap-1">
          <div className="flex items-center justify-between">
            <h3 className="text-caption text-ink-soft">{t('panels.designPending')}</h3>
            <Button
              size="pill"
              variant="default"
              title={t('panels.designClear')}
              aria-label={t('panels.designClear')}
              disabled={mode.busy}
              onClick={mode.clearPending}
            >
              {t('panels.designClear')}
            </Button>
          </div>
          <ol>{pending.map(row)}</ol>
        </div>
      )}
      {mode.saved.notes.some((note) => note.status !== 'pending') && (
        <div className="grid gap-1">
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
    </section>
  )
}
