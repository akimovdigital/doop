import { nanoid } from 'nanoid'
import { pageFrames } from '../../shared/pages'
import { sectionAround } from '../../shared/sections'
import type { CanvasPageLayout, CanvasSection } from '../../shared/types'
import { errorMessage, req } from './api'
import { pageLink } from './pageLink'
import { canEditOpenCanvas, useStore } from './store'

const EMPTY_SECTIONS: readonly CanvasSection[] = []

export function activeSections({ canvas, activePageId }: ReturnType<typeof useStore.getState>) {
  return canvas?.pages?.find((page) => page.id === activePageId)?.sections ?? EMPTY_SECTIONS
}

export function selectedSection(state: ReturnType<typeof useStore.getState>) {
  return activeSections(state).find((section) => section.id === state.selectedSectionId)
}

export function sectionLink(canvasId: string, pageId: string, sectionId: string) {
  const url = new URL(pageLink(canvasId, pageId))
  url.searchParams.set('section', sectionId)
  return url.href
}

type SectionChange =
  | { type: 'save'; section: CanvasSection }
  | { type: 'patch'; section: CanvasSection; patch: Partial<Omit<CanvasSection, 'id'>> }
  | { type: 'move'; section: CanvasSection; x: number; y: number }
  | { type: 'position'; section: CanvasSection; x?: number; y?: number }
  | { type: 'delete'; section: CanvasSection }

const writes = new Map<string, Promise<boolean>>()

/** Property commits and pointer edits share the server's canvas layout transaction. */
export function changeSection(canvasId: string, pageId: string, change: SectionChange): Promise<boolean> {
  const previous = writes.get(canvasId)
  const write = previous
    ? previous.then(() => sendSectionChange(canvasId, pageId, change))
    : sendSectionChange(canvasId, pageId, change)
  writes.set(canvasId, write)
  void write.then(() => {
    if (writes.get(canvasId) === write) writes.delete(canvasId)
  })
  return write
}

async function sendSectionChange(canvasId: string, pageId: string, change: SectionChange) {
  const before = useStore.getState()
  if (
    before.canvas?.id !== canvasId ||
    !before.canvas.pages?.some((page) => page.id === pageId) ||
    !canEditOpenCanvas(before)
  )
    return false
  const page = before.canvas.pages?.find((item) => item.id === pageId)
  if (change.type === 'position') {
    const current = page?.sections?.find((section) => section.id === change.section.id)
    if (!current) return false
    change = { type: 'move', section: current, x: change.x ?? current.x, y: change.y ?? current.y }
  }
  const { section } = change
  const url = `/api/canvases/${encodeURIComponent(canvasId)}/pages/${encodeURIComponent(pageId)}/sections/${encodeURIComponent(section.id)}`
  try {
    const layout = await req<CanvasPageLayout>(
      change.type === 'move' ? `${url}/move` : url,
      change.type === 'save'
        ? { method: 'PUT', body: JSON.stringify(section) }
        : change.type === 'patch'
          ? { method: 'PATCH', body: JSON.stringify(change.patch) }
          : change.type === 'move'
            ? {
                method: 'POST',
                body: JSON.stringify({ x: change.x, y: change.y, expected: { x: section.x, y: section.y } }),
              }
            : { method: 'DELETE' },
    )
    const now = useStore.getState()
    // The live room usually applies the layout before this response arrives.
    if (now.canvas?.id === canvasId && now.canvas.pages === before.canvas.pages)
      now.setPages(layout.pages, canvasId, layout.frameMoves)
    return true
  } catch (error) {
    if (useStore.getState().canvas?.id === canvasId)
      useStore.getState().pushNotice(errorMessage(error, 'Section could not be saved'))
    return false
  }
}

export async function wrapSelectionInSection(name: string) {
  const state = useStore.getState()
  const { canvas, activePageId, selectedIds } = state
  if (!canvas || !activePageId || !canEditOpenCanvas(state)) return
  const ids = new Set(selectedIds)
  const bounds = sectionAround(pageFrames(canvas, activePageId).filter((frame) => ids.has(frame.id)))
  if (!bounds) return
  const section = { ...bounds, id: nanoid(10), name: `${name} ${activeSections(state).length + 1}` }
  if (await changeSection(canvas.id, activePageId, { type: 'save', section })) {
    const current = useStore.getState()
    if (current.canvas?.id === canvas.id && current.activePageId === activePageId) current.selectSection(section.id)
  }
}
