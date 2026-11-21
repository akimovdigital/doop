import type { CanvasPageLayout, CanvasSection } from '../../shared/types'
import { errorMessage, req } from './api'
import { canEditOpenCanvas, useStore } from './store'

const EMPTY_SECTIONS: readonly CanvasSection[] = []

export function activeSections({ canvas, activePageId }: ReturnType<typeof useStore.getState>) {
  return canvas?.pages?.find((page) => page.id === activePageId)?.sections ?? EMPTY_SECTIONS
}

type SectionChange =
  | { type: 'save'; section: CanvasSection }
  | { type: 'move'; section: CanvasSection; x: number; y: number }
  | { type: 'delete'; section: CanvasSection }

export async function changeSection(canvasId: string, pageId: string, change: SectionChange) {
  const before = useStore.getState()
  if (before.canvas?.id !== canvasId || before.activePageId !== pageId || !canEditOpenCanvas(before)) return
  const { section } = change
  const url = `/api/canvases/${encodeURIComponent(canvasId)}/pages/${encodeURIComponent(pageId)}/sections/${encodeURIComponent(section.id)}`
  try {
    const layout = await req<CanvasPageLayout>(
      change.type === 'move' ? `${url}/move` : url,
      change.type === 'save'
        ? { method: 'PUT', body: JSON.stringify(section) }
        : change.type === 'move'
          ? {
              method: 'POST',
              body: JSON.stringify({ x: change.x, y: change.y, expected: { x: section.x, y: section.y } }),
            }
          : { method: 'DELETE' },
    )
    const now = useStore.getState()
    // The live room usually applies the layout before this response arrives.
    if (now.canvas?.id === canvasId && now.canvas.pages === before.canvas.pages) {
      now.setPages(layout.pages, canvasId, layout.frameMoves)
    }
  } catch (error) {
    if (useStore.getState().canvas?.id === canvasId)
      useStore.getState().pushNotice(errorMessage(error, 'Section could not be saved'))
  }
}
