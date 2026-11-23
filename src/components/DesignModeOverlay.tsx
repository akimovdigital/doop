import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { DesignNote, NoteRect } from '../lib/designNotes'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Switch } from './ui/switch'
import { IconButton } from './ui/icon-button'
import { CheckIcon, ChevronDownIcon, MessageSquareIcon, PlusIcon, XIcon } from './ui/icons'
import { Textarea } from './ui/textarea'
import type { useDesignMode } from './useDesignMode'

type Mode = ReturnType<typeof useDesignMode>

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

export function DesignModeHint({ mode }: { mode: Mode }) {
  const t = useT()
  const message = t(mode.region || mode.draft ? 'panels.designNoteHint' : 'panels.designPickHint')
  return (
    <div data-design-hint="" className="flex min-w-0 flex-1 items-center gap-1 text-caption text-brand">
      <IconButton size="sm" className="text-brand" aria-label={t('panels.designExit')} onClick={mode.exit}>
        <XIcon size="rail" />
      </IconButton>
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
  const picking = mode.enabled && !mode.usingPage
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

  if (!mode.allowed) return null
  const { draft, hover } = mode
  const selected =
    draft?.elements.map((el, index) => (index === 0 && draft.id && mode.pins[draft.id]?.rect) || el.rect) ?? []
  const anchors = draft?.region ? [draft.region] : selected
  const cardWidth = Math.min(290, Math.max(0, (surface?.viewportWidth ?? 290) - 2 * inset))
  const right = Math.max(...anchors.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...anchors.map((rect) => rect.y + rect.height))
  const cardLeft =
    surface && anchors.length
      ? Math.max(inset, Math.min(surface.x + right * surface.scale, surface.viewportWidth - inset) - cardWidth)
      : inset
  const comment = draft?.comment.trim()
  const rows = Math.min(3, (draft?.comment ?? '').split('\n').length)
  const cardHeight = (comment || draft?.id ? 58 : 34) + (rows - 1) * 20
  const cardTop =
    surface && anchors.length
      ? Math.max(
          inset,
          Math.min(surface.y + bottom * surface.scale + inset, surface.viewportHeight - cardHeight - inset),
        )
      : inset
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
          {picking && (mode.region ?? draft?.region) && (
            <div
              data-design-region=""
              className="absolute border-2 border-dashed border-brand bg-brand/10"
              style={box((mode.region ?? draft?.region)!, surface)}
            />
          )}
          {picking &&
            mode.saved.notes
              .filter((note) => note.frameId === frameId && note.status !== 'resolved')
              .map((note) => {
                const pin = mode.pins[note.id]
                const rect = pin?.rect ?? note.lastRect ?? note.elements[0]?.rect ?? note.region
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
              placeholder={t('panels.designDescribe')}
              variant="bare"
              rows={rows}
              className="min-w-0 flex-1 text-caption/5 md:text-caption/5"
              value={draft.comment}
              readOnly={mode.busy}
              onChange={(e) => mode.setComment(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              onKeyUp={(e) => e.stopPropagation()}
            />
            {!comment && !draft.id && (
              <IconButton size="sm" className="size-5" aria-label={submitLabel} disabled>
                <span aria-hidden="true">↵</span>
              </IconButton>
            )}
          </div>
          {(comment || draft.id) && (
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
                  disabled={!comment || mode.busy}
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

function designPoint(event: { currentTarget: HTMLDivElement; clientX: number; clientY: number }, scale: number) {
  const bounds = event.currentTarget.getBoundingClientRect()
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
    const visibleText = element?.text.replace(/\s+/g, ' ').trim().slice(0, 80)
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
          aria-label={`${note.number}. ${note.comment}`}
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
          <span className="min-w-0 flex-1 truncate text-left">{note.comment}</span>
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
