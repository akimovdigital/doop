import { nanoid } from 'nanoid'
import { pageFrames } from '../../shared/pages'
import { sectionAround, sectionSize } from '../../shared/sections'
import type { CanvasPageLayout, CanvasSection } from '../../shared/types'
import { t } from './i18n'
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
  | { type: 'size'; section: CanvasSection; axis: 'width' | 'height'; value: number }
  | { type: 'position'; section: CanvasSection; x?: number; y?: number }
  | { type: 'delete'; section: CanvasSection; keepContents: boolean; additionalSections: string[] }

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
  if (change.type === 'position' || change.type === 'size') {
    const current = page?.sections?.find((section) => section.id === change.section.id)
    if (!current) return false
    change =
      change.type === 'size'
        ? { type: 'patch', section: current, patch: sectionSize(current, change.axis, change.value) }
        : { type: 'move', section: current, x: change.x ?? current.x, y: change.y ?? current.y }
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
            : {
                method: 'DELETE',
                body: JSON.stringify({
                  keepContents: change.keepContents,
                  additionalSections: change.additionalSections,
                }),
              },
    )
    const now = useStore.getState()
    // The live room usually applies the layout before this response arrives.
    if (now.canvas?.id === canvasId) {
      if (now.canvas.pages === before.canvas.pages) now.setPages(layout.pages, canvasId, layout.frameMoves)
      for (const id of layout.frameDeletes ?? []) {
        if (useStore.getState().canvas?.frames.some((frame) => frame.id === id)) now.removeFrame(id)
      }
    }
    return true
  } catch (error) {
    if (useStore.getState().canvas?.id === canvasId)
      useStore.getState().pushNotice(errorMessage(error, 'Section could not be saved'))
    return false
  }
}

export function removeSectionSelection(keepContents: boolean, targetId?: string): boolean {
  const state = useStore.getState()
  const { canvas, activePageId, selectedSectionId, selectedSectionIds } = state
  const id = targetId ?? selectedSectionId
  const section = activeSections(state).find((item) => item.id === id)
  if (!canvas || !activePageId || !section || !canEditOpenCanvas(state)) return false
  void changeSection(canvas.id, activePageId, {
    type: 'delete',
    section,
    keepContents,
    additionalSections: selectedSectionIds.includes(section.id)
      ? selectedSectionIds.filter((item) => item !== section.id)
      : [],
  })
  return true
}

export async function copySectionLink(section: CanvasSection) {
  const { canvas, activePageId, pushNotice } = useStore.getState()
  if (!canvas || !activePageId) return
  try {
    await navigator.clipboard.writeText(sectionLink(canvas.id, activePageId, section.id))
    pushNotice(t('canvas.sectionLinkCopied'))
  } catch {
    pushNotice(t('canvas.sectionLinkFailed'))
  }
}

export async function wrapSelectionInSection(name: string, target?: { frameId: string } | { sectionId: string }) {
  const state = useStore.getState()
  const { canvas, activePageId, selectedIds, selectedSectionIds, selectedElement } = state
  if (!canvas || !activePageId || !canEditOpenCanvas(state)) return
  const targetFrameId = target && 'frameId' in target ? target.frameId : undefined
  const targetSectionId = target && 'sectionId' in target ? target.sectionId : undefined
  const replace = targetFrameId
    ? !selectedIds.includes(targetFrameId) && selectedElement?.frameId !== targetFrameId
    : targetSectionId !== undefined && !selectedSectionIds.includes(targetSectionId)
  const frameIds = replace ? [targetFrameId] : [...selectedIds, selectedElement?.frameId]
  const sectionIds = replace ? [targetSectionId] : selectedSectionIds
  const bounds = sectionAround([
    ...pageFrames(canvas, activePageId).filter((frame) => frameIds.includes(frame.id)),
    ...activeSections(state).filter((section) => sectionIds.includes(section.id)),
  ])
  if (!bounds) return
  const section = { ...bounds, id: nanoid(10), name: `${name} ${activeSections(state).length + 1}` }
  if (await changeSection(canvas.id, activePageId, { type: 'save', section })) {
    const current = useStore.getState()
    if (current.canvas?.id === canvas.id && current.activePageId === activePageId) current.selectSection(section.id)
  }
}
