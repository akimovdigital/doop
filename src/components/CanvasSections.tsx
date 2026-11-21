import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { nanoid } from 'nanoid'
import { pageFrames } from '../../shared/pages'
import {
  SECTION_FILL,
  SECTION_RADIUS,
  SECTION_STROKE,
  sectionContainsFrame,
  sectionForFrame,
  sectionPaint,
  sectionSize,
} from '../../shared/sections'
import type { CanvasSection } from '../../shared/types'
import { usePageCanvas } from '../lib/pages'
import { activeSections, changeSection, sectionLink } from '../lib/canvasSections'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { useTheme } from '../lib/theme'
import { isTypingTarget } from '../lib/keys'
import { cn } from '../lib/utils'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { SectionIcon } from './ui/icons'

type Point = { x: number; y: number }
type Corner = 'nw' | 'ne' | 'sw' | 'se'
type Gesture =
  | { type: 'create' }
  | { type: 'move'; section: CanvasSection; element: HTMLElement; handle: HTMLElement }
  | { type: 'resize'; section: CanvasSection; element: HTMLElement; handle: HTMLElement; corner: Corner }
const cornerNames = {
  nw: 'canvas.sectionCornerNW',
  ne: 'canvas.sectionCornerNE',
  sw: 'canvas.sectionCornerSW',
  se: 'canvas.sectionCornerSE',
} as const
const TITLE_SCALE = 'scale(calc(1 / var(--zoom, 1)))'
const MIN_DRAW_SIZE = 24
const corners: Record<Corner, string> = {
  nw: 'top-0 left-0 origin-top-left cursor-nwse-resize',
  ne: 'top-0 right-0 origin-top-right cursor-nesw-resize',
  sw: 'bottom-0 left-0 origin-bottom-left cursor-nesw-resize',
  se: 'bottom-0 right-0 origin-bottom-right cursor-nwse-resize',
}

function resizeBox(section: CanvasSection, delta: Point, corner: Corner, lock: boolean) {
  const west = corner.endsWith('w')
  const north = corner.startsWith('n')
  const nextWidth = Math.max(1, section.width + delta.x * (west ? -1 : 1))
  const nextHeight = Math.max(1, section.height + delta.y * (north ? -1 : 1))
  const axis = Math.abs(nextWidth / section.width - 1) >= Math.abs(nextHeight / section.height - 1) ? 'width' : 'height'
  const { width, height } = lock
    ? sectionSize(section, axis, axis === 'width' ? nextWidth : nextHeight, true)
    : { width: nextWidth, height: nextHeight }
  return {
    x: west ? section.x + section.width - width : section.x,
    y: north ? section.y + section.height - height : section.y,
    width,
    height,
  }
}

function sectionShadow(section: CanvasSection, color: string | null) {
  const width = section.strokeWidth ?? 1
  if (!color || !width) return undefined
  const ink = sectionPaint(color, section.strokeOpacity ?? 100)
  const align = section.strokeAlign ?? 'inside'
  if (align === 'inside') return `inset 0 0 0 ${width}px ${ink}`
  if (align === 'outside') return `0 0 0 ${width}px ${ink}`
  return `inset 0 0 0 ${width / 2}px ${ink}, 0 0 0 ${width / 2}px ${ink}`
}

function outline(origin: Point, point: Point) {
  return {
    x: Math.min(origin.x, point.x),
    y: Math.min(origin.y, point.y),
    width: Math.abs(origin.x - point.x),
    height: Math.abs(origin.y - point.y),
  }
}

function applyBox(element: HTMLElement, box: ReturnType<typeof outline>) {
  Object.assign(element.style, {
    left: `${box.x}px`,
    top: `${box.y}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  })
}

export const CanvasSections = memo(function CanvasSections({
  stage,
  world,
}: {
  stage: RefObject<HTMLDivElement | null>
  world: RefObject<HTMLDivElement | null>
}) {
  const sections = useStore(activeSections)
  const canvasId = useStore((state) => state.canvas?.id)
  const pageId = useStore((state) => state.activePageId)
  const picked = useStore((state) => state.selectedSectionId)
  const selectSection = useStore((state) => state.selectSection)
  const { resolved } = useTheme()
  const stackedSections = useMemo(
    () => [...sections].sort((a, b) => b.width * b.height - a.width * a.height),
    [sections],
  )
  const editable = useStore(canEditOpenCanvas)
  const tool = useStore((state) => state.tool)
  const [renaming, setRenaming] = useState<CanvasSection>()
  const [name, setName] = useState('')
  const t = useT()
  const draft = useRef<HTMLDivElement>(null)
  const inProgress = useRef<() => void>(undefined)
  const saving = useRef(false)

  useEffect(() => () => inProgress.current?.(), [canvasId, pageId, tool])

  function submit(change: Parameters<typeof changeSection>[2]) {
    if (!canvasId || !pageId || saving.current) return Promise.resolve(false)
    saving.current = true
    return changeSection(canvasId, pageId, change).finally(() => {
      saving.current = false
    })
  }

  function begin(event: PointerEvent, gesture: Gesture) {
    const surface = stage.current
    const state = useStore.getState()
    if (
      !surface ||
      !canvasId ||
      !pageId ||
      !editable ||
      saving.current ||
      inProgress.current ||
      state.panMode ||
      event.button !== 0 ||
      !event.isPrimary ||
      (gesture.type !== 'create' && state.tool !== 'select')
    )
      return
    event.preventDefault()
    event.stopPropagation()
    const pointerId = event.pointerId
    const zoom = state.viewport.zoom
    const rect = surface.getBoundingClientRect()
    const origin = {
      x: (event.clientX - rect.left - state.viewport.x) / zoom,
      y: (event.clientY - rect.top - state.viewport.y) / zoom,
    }
    let delta = { x: 0, y: 0 }
    let moved = false
    let keepRatio = false
    let paint = 0
    const related: HTMLElement[] = []
    if (gesture.type === 'move' && state.canvas) {
      const { section } = gesture
      const nested = sections.filter(
        (item) =>
          item.id !== section.id &&
          (item.width < section.width || item.height < section.height) &&
          sectionContainsFrame(section, item),
      )
      const frames = pageFrames(state.canvas, pageId).filter((frame) => sectionContainsFrame(section, frame))
      for (const frame of frames) {
        const shell = world.current?.querySelector<HTMLElement>(`[data-doop-frame-shell="${CSS.escape(frame.id)}"]`)
        if (shell) related.push(shell)
      }
      for (const item of nested) {
        const element = world.current?.querySelector<HTMLElement>(`[data-canvas-section="${CSS.escape(item.id)}"]`)
        if (element) related.push(element)
      }
    }
    if (gesture.type !== 'create') selectSection(gesture.section.id)
    const handle = gesture.type === 'create' ? surface : gesture.handle
    try {
      handle.setPointerCapture(pointerId)
    } catch {
      /* the window handlers also work without capture */
    }

    function nextBox() {
      if (gesture.type === 'create') return outline(origin, { x: origin.x + delta.x, y: origin.y + delta.y })
      return gesture.type === 'resize' ? resizeBox(gesture.section, delta, gesture.corner, keepRatio) : gesture.section
    }

    function update(event_: PointerEvent) {
      delta = { x: (event_.clientX - event.clientX) / zoom, y: (event_.clientY - event.clientY) / zoom }
      keepRatio = event_.shiftKey || (gesture.type === 'resize' && !!gesture.section.lockAspectRatio)
      moved ||= Math.hypot(delta.x, delta.y) * zoom >= 4
    }
    function move(event_: PointerEvent) {
      if (event_.pointerId !== pointerId) return
      update(event_)
      if (!moved || paint) return
      paint = requestAnimationFrame(() => {
        paint = 0
        if (gesture.type === 'move') {
          const translate = `${delta.x}px ${delta.y}px`
          gesture.element.style.translate = translate
          for (const element of related) element.style.translate = translate
        } else if (draft.current) {
          draft.current.hidden = false
          applyBox(draft.current, nextBox())
        }
      })
    }
    function finish() {
      cancelAnimationFrame(paint)
      if (draft.current) draft.current.hidden = true
      if (gesture.type === 'move') {
        gesture.element.style.removeProperty('translate')
        for (const element of related) element.style.removeProperty('translate')
      }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', finish)
      inProgress.current = undefined
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
    }
    function up(event_: PointerEvent) {
      if (event_.pointerId !== pointerId) return
      update(event_)
      finish()
      if (!moved || useStore.getState().activePageId !== pageId) return
      if (gesture.type === 'create') {
        const box = nextBox()
        const id = nanoid(10)
        void submit({
          type: 'save',
          section: {
            id,
            name: `${t('canvas.toolSection')} ${sections.length + 1}`,
            ...box,
            width: Math.max(MIN_DRAW_SIZE, box.width),
            height: Math.max(MIN_DRAW_SIZE, box.height),
          },
        }).then((saved) => {
          const current = useStore.getState()
          if (saved && current.canvas?.id === canvasId && current.activePageId === pageId) current.selectSection(id)
        })
        useStore.getState().setTool('select')
      } else if (gesture.type === 'move') {
        void submit({
          type: 'move',
          section: gesture.section,
          x: gesture.section.x + delta.x,
          y: gesture.section.y + delta.y,
        })
      } else {
        void submit({ type: 'patch', section: gesture.section, patch: nextBox() })
      }
    }
    function cancel(event_: PointerEvent) {
      if (event_.pointerId === pointerId) finish()
    }
    inProgress.current = finish
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', finish)
  }

  // A section tool press can start over a frame without starting a frame drag.
  useEffect(() => {
    const surface = stage.current
    if (!surface || tool !== 'section') return
    const start = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest('[data-comment-ui]')) return
      begin(event, { type: 'create' })
    }
    surface.addEventListener('pointerdown', start, true)
    return () => surface.removeEventListener('pointerdown', start, true)
  })

  function startRename(section: CanvasSection) {
    if (!editable) return
    setRenaming(section)
    setName(section.name)
  }
  function pointerHandle(event: ReactPointerEvent<HTMLElement>, section: CanvasSection, corner?: Corner) {
    const element = event.currentTarget.closest<HTMLElement>('[data-canvas-section]')
    const state = useStore.getState()
    if (!element || state.tool !== 'select' || state.panMode || event.button !== 0) return
    event.stopPropagation()
    if (!editable) return
    const handle = event.currentTarget
    begin(
      event.nativeEvent,
      corner ? { type: 'resize', section, element, handle, corner } : { type: 'move', section, element, handle },
    )
  }

  function rename(section: CanvasSection) {
    const next = name.trim()
    if (next && next !== section.name) void submit({ type: 'patch', section, patch: { name: next } })
    setRenaming(undefined)
  }

  async function copyLink(section: CanvasSection) {
    if (!canvasId || !pageId) return
    try {
      await navigator.clipboard.writeText(sectionLink(canvasId, pageId, section.id))
      useStore.getState().pushNotice(t('canvas.sectionLinkCopied'))
    } catch {
      useStore.getState().pushNotice(t('canvas.sectionLinkFailed'))
    }
  }

  useEffect(() => {
    const selected = sections.find((section) => section.id === picked)
    if (!selected || !editable || tool !== 'select') return
    function onKey(event: KeyboardEvent) {
      if (
        !selected ||
        event.defaultPrevented ||
        isTypingTarget(event.target) ||
        (event.target instanceof Element && event.target.closest('[role="menu"], [role="dialog"]'))
      )
        return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
      if (direction) {
        event.preventDefault()
        const step = event.shiftKey ? 32 : 8
        void submit({
          type: 'move',
          section: selected,
          x: selected.x + direction[0]! * step,
          y: selected.y + direction[1]! * step,
        })
      } else if (event.key === 'F2') {
        event.preventDefault()
        startRename(selected)
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        void submit({ type: 'delete', section: selected })
      } else if (event.key === 'Escape') {
        useStore.getState().select(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <>
      {stackedSections.map((section) => {
        const fill = section.fill === undefined ? SECTION_FILL[resolved] : section.fill
        const stroke = section.stroke === undefined ? SECTION_STROKE[resolved] : section.stroke
        return (
          <div
            key={section.id}
            data-canvas-section={section.id}
            data-section-selected={picked === section.id || undefined}
            className="pointer-events-none absolute"
            style={{
              left: section.x,
              top: section.y,
              width: section.width,
              height: section.height,
              borderRadius: section.cornerRadius ?? SECTION_RADIUS,
              backgroundColor: fill ? sectionPaint(fill, section.fillOpacity ?? 100) : 'transparent',
              boxShadow: sectionShadow(section, stroke),
              outline: picked === section.id ? 'calc(1.5px / var(--zoom, 1)) solid var(--brand)' : undefined,
            }}
          >
            {editable && tool === 'select' && (
              <div
                data-section-surface=""
                className="pointer-events-auto absolute inset-0 touch-none"
                onPointerDown={(event) => pointerHandle(event, section)}
              />
            )}
            <div className="absolute bottom-full left-0 origin-bottom-left pb-1.5" style={{ transform: TITLE_SCALE }}>
              {renaming?.id === section.id ? (
                <form
                  className="pointer-events-auto"
                  onSubmit={(event) => {
                    event.preventDefault()
                    rename(section)
                  }}
                >
                  <Input
                    inputSize="auto"
                    autoFocus
                    aria-label={t('canvas.toolSection')}
                    value={name}
                    maxLength={100}
                    className="w-48 rounded-row border-brand px-2 py-1 md:text-label"
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setRenaming(undefined)
                    }}
                    onBlur={() => rename(section)}
                  />
                </form>
              ) : (
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <Button
                      variant="bare"
                      size={null}
                      className={cn(
                        'pointer-events-auto flex max-w-64 touch-none select-none items-center gap-1.5 rounded-row border-line bg-surface px-2 py-1 text-label font-medium text-ink shadow-sm',
                        editable && tool === 'select' && 'cursor-grab active:cursor-grabbing',
                      )}
                      title={section.name}
                      onPointerDown={(event) => pointerHandle(event, section)}
                      onDoubleClick={() => startRename(section)}
                      onClick={() => {
                        if (useStore.getState().tool === 'select' && !useStore.getState().panMode)
                          selectSection(section.id)
                      }}
                    >
                      <SectionIcon className="size-3.5 shrink-0 text-ink-soft" aria-hidden />
                      <span className="truncate">{section.name}</span>
                    </Button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => useStore.getState().focusSection(section.id)}>
                      {t('canvas.sectionFit')}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void copyLink(section)}>
                      {t('canvas.sectionCopyLink')}
                    </ContextMenuItem>
                    {editable && (
                      <>
                        <ContextMenuItem onSelect={() => startRename(section)}>
                          {t('canvas.sectionRename')}
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => void submit({ type: 'delete', section })}>
                          {t('canvas.sectionDelete')}
                        </ContextMenuItem>
                      </>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              )}
            </div>
            {editable &&
              picked === section.id &&
              tool === 'select' &&
              (Object.entries(corners) as [Corner, string][]).map(([corner, position]) => (
                <Button
                  key={corner}
                  variant="bare"
                  size={null}
                  aria-label={t('canvas.sectionResizeCorner', { corner: t(cornerNames[corner]) })}
                  className={cn(
                    'pointer-events-auto absolute size-2.5 touch-none rounded-tag border border-brand bg-surface',
                    position,
                  )}
                  style={{ transform: TITLE_SCALE }}
                  onPointerDown={(event) => pointerHandle(event, section, corner)}
                />
              ))}
          </div>
        )
      })}

      <div
        ref={draft}
        hidden
        className="pointer-events-none absolute z-10 border border-brand bg-brand/10"
        style={{ borderWidth: 'calc(1px / var(--zoom, 1))' }}
      />
    </>
  )
})

export function SectionsPanel() {
  const canvas = usePageCanvas()
  const sections = useStore(activeSections)
  const selectedId = useStore((s) => s.selectedSectionId)
  const t = useT()
  const frameCounts = new Map<string, number>()
  for (const frame of canvas?.frames ?? []) {
    const section = sectionForFrame(sections, frame)
    if (section) frameCounts.set(section.id, (frameCounts.get(section.id) ?? 0) + 1)
  }
  return (
    <div className="flex flex-col px-2">
      {sections.length === 0 && <p className="px-2.5 py-2 text-label text-ink-soft">{t('canvas.sectionEmpty')}</p>}
      {sections.map((section) => (
        <Button
          variant="bare"
          size={null}
          key={section.id}
          title={section.name}
          className="flex items-center justify-start gap-2 rounded-row px-2.5 py-1.5 text-left text-label text-ink hover:bg-sub"
          aria-pressed={selectedId === section.id}
          onClick={() => useStore.getState().selectSection(section.id)}
          onDoubleClick={() => useStore.getState().focusSection(section.id)}
        >
          <SectionIcon className="size-3.5 shrink-0 text-ink-soft" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{section.name}</span>
          <span className="tabular-nums text-ink-faint">{frameCounts.get(section.id) ?? 0}</span>
        </Button>
      ))}
    </div>
  )
}
