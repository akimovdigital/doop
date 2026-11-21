import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { nanoid } from 'nanoid'
import { pageFrames } from '../../shared/pages'
import { sectionContainsFrame, sectionForFrame } from '../../shared/sections'
import type { CanvasSection } from '../../shared/types'
import { usePageCanvas } from '../lib/pages'
import { activeSections, changeSection } from '../lib/canvasSections'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { cn } from '../lib/utils'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { SectionIcon } from './ui/icons'

type Point = { x: number; y: number }
type Gesture =
  { type: 'create' } | { type: 'move' | 'resize'; section: CanvasSection; element: HTMLElement; handle: HTMLElement }
const TITLE_SCALE = 'scale(calc(1 / var(--zoom, 1)))'
const MIN_SIZE = 24

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
  const focus = useStore((state) => state.sectionFocus)
  const editable = useStore(canEditOpenCanvas)
  const tool = useStore((state) => state.tool)
  const [selected, setSelected] = useState<string>()
  const [renaming, setRenaming] = useState<CanvasSection>()
  const [name, setName] = useState('')
  const t = useT()
  const draft = useRef<HTMLDivElement>(null)
  const inProgress = useRef<() => void>(undefined)
  const saving = useRef(false)
  const picked = selected ?? focus?.id

  useEffect(() => () => inProgress.current?.(), [canvasId, pageId, tool])

  function submit(change: Parameters<typeof changeSection>[2]) {
    if (!canvasId || !pageId || saving.current) return
    saving.current = true
    void changeSection(canvasId, pageId, change).finally(() => {
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
    if (gesture.type !== 'create') {
      setSelected(gesture.section.id)
      state.select(null)
    }
    const handle = gesture.type === 'create' ? surface : gesture.handle
    try {
      handle.setPointerCapture(pointerId)
    } catch {
      /* the window handlers also work without capture */
    }

    function nextBox() {
      return gesture.type === 'create'
        ? outline(origin, { x: origin.x + delta.x, y: origin.y + delta.y })
        : {
            ...gesture.section,
            width: Math.max(MIN_SIZE, gesture.section.width + delta.x),
            height: Math.max(MIN_SIZE, gesture.section.height + delta.y),
          }
    }

    function update(event_: PointerEvent) {
      delta = { x: (event_.clientX - event.clientX) / zoom, y: (event_.clientY - event.clientY) / zoom }
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
        submit({
          type: 'save',
          section: {
            id,
            name: `${t('canvas.toolSection')} ${sections.length + 1}`,
            ...box,
            width: Math.max(MIN_SIZE, box.width),
            height: Math.max(MIN_SIZE, box.height),
          },
        })
        setSelected(id)
        useStore.getState().setTool('select')
      } else if (gesture.type === 'move') {
        submit({
          type: 'move',
          section: gesture.section,
          x: gesture.section.x + delta.x,
          y: gesture.section.y + delta.y,
        })
      } else {
        submit({ type: 'save', section: { ...gesture.section, ...nextBox() } })
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
  function pointerHandle(event: ReactPointerEvent, section: CanvasSection, type: 'move' | 'resize') {
    const element = event.currentTarget.closest<HTMLElement>('[data-canvas-section]')
    if (element && event.currentTarget instanceof HTMLElement) {
      begin(event.nativeEvent, { type, section, element, handle: event.currentTarget })
    }
  }

  return (
    <>
      {sections.map((section) => (
        <div
          key={section.id}
          data-canvas-section={section.id}
          className={cn(
            'pointer-events-none absolute rounded-control border border-line bg-paper-deep/35',
            picked === section.id && 'border-brand/80 bg-brand/5',
          )}
          style={{
            left: section.x,
            top: section.y,
            width: section.width,
            height: section.height,
            borderWidth: 'calc(1px / var(--zoom, 1))',
          }}
        >
          <div className="absolute bottom-full left-0 origin-bottom-left pb-1.5" style={{ transform: TITLE_SCALE }}>
            {renaming?.id === section.id ? (
              <form
                className="pointer-events-auto"
                onSubmit={(event) => {
                  event.preventDefault()
                  const next = name.trim()
                  if (next && next !== section.name) submit({ type: 'save', section: { ...section, name: next } })
                  setRenaming(undefined)
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
                  onBlur={() => setRenaming(undefined)}
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
                    onPointerDown={(event) => pointerHandle(event, section, 'move')}
                    onDoubleClick={() => startRename(section)}
                    onClick={() => setSelected(section.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'F2') return startRename(section)
                      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
                        event.key
                      ]
                      if (!editable || !direction) return
                      event.preventDefault()
                      event.stopPropagation()
                      const step = event.shiftKey ? 32 : 8
                      submit({
                        type: 'move',
                        section,
                        x: section.x + direction[0]! * step,
                        y: section.y + direction[1]! * step,
                      })
                    }}
                  >
                    <SectionIcon className="size-3.5 shrink-0 text-ink-soft" aria-hidden />
                    <span className="truncate">{section.name}</span>
                  </Button>
                </ContextMenuTrigger>
                {editable && (
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => useStore.getState().focusSection(section.id)}>
                      {t('canvas.sectionFit')}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => startRename(section)}>{t('canvas.sectionRename')}</ContextMenuItem>
                    <ContextMenuItem onSelect={() => submit({ type: 'delete', section })}>
                      {t('canvas.sectionDelete')}
                    </ContextMenuItem>
                  </ContextMenuContent>
                )}
              </ContextMenu>
            )}
          </div>
          {editable && picked === section.id && tool === 'select' && (
            <Button
              variant="bare"
              size={null}
              aria-label={t('canvas.sectionResize')}
              className="pointer-events-auto absolute right-0 bottom-0 size-3 origin-bottom-right touch-none rounded-tag border border-brand bg-surface cursor-nwse-resize"
              style={{ transform: TITLE_SCALE }}
              onPointerDown={(event) => pointerHandle(event, section, 'resize')}
            />
          )}
        </div>
      ))}
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
  const canEdit = useStore(canEditOpenCanvas)
  const t = useT()
  const frameCounts = new Map<string, number>()
  for (const frame of canvas?.frames ?? []) {
    const section = sectionForFrame(sections, frame)
    if (section) frameCounts.set(section.id, (frameCounts.get(section.id) ?? 0) + 1)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-2">
      {canEdit && (
        <Button
          variant="bare"
          size={null}
          className="mb-2 justify-between rounded-control bg-sub px-2.5 py-2 text-left text-label font-medium text-ink hover:bg-paper-deep"
          onClick={() => useStore.getState().setTool('section')}
        >
          {t('canvas.sectionAdd')} <span className="text-ink-faint">⇧S</span>
        </Button>
      )}
      {sections.length === 0 && <p className="px-2.5 py-2 text-label text-ink-soft">{t('canvas.sectionEmpty')}</p>}
      {sections.map((section) => (
        <Button
          variant="bare"
          size={null}
          key={section.id}
          title={section.name}
          className="flex items-center justify-start gap-2 rounded-row px-2.5 py-2 text-left text-label text-ink hover:bg-sub"
          onClick={() => useStore.getState().focusSection(section.id)}
        >
          <SectionIcon className="size-3.5 shrink-0 text-ink-soft" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{section.name}</span>
          <span className="tabular-nums text-ink-faint">{frameCounts.get(section.id) ?? 0}</span>
        </Button>
      ))}
    </div>
  )
}
