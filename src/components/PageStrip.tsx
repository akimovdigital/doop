import { useLayoutEffect, useRef } from 'react'
import { canvasPages } from '../../shared/pages'
import { stepPage } from '../lib/actions/edits'
import { useIsMobile } from '../hooks/use-mobile'
import { useT } from '../lib/i18n'
import { isDrawingTool } from '../lib/tools'
import { useStore } from '../lib/store'
import { cn } from '../lib/utils'
import { ChevronLeftIcon, ChevronRightIcon, PageIcon } from './ui/icons'
import { Toolbar, ToolbarButton } from './ui/toolbar'

/** Floating page strip on the stage: switch canvas pages without opening
 *  Layers. Complements the Pages list, PageUp/PageDown and the View menu;
 *  it does not replace them. */
export function PageStrip({ hidden }: { hidden: boolean }) {
  const t = useT()
  const isMobile = useIsMobile()
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const drawing = useStore((s) => isDrawingTool(s.tool))
  const listRef = useRef<HTMLDivElement>(null)

  const pages = canvas ? canvasPages(canvas) : []
  const activeId = activePageId ?? pages[0]?.id ?? null
  const at = activeId ? pages.findIndex((page) => page.id === activeId) : -1

  useLayoutEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
    row?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeId])

  if (!canvas || hidden || !pages.length || !activeId) return null

  return (
    <Toolbar
      data-slot="page-strip"
      aria-label={t('stage.pagesStrip')}
      className={cn(
        /* beside the zoom pill on desktop — bottom-left is the Getting started
           card; on phones sit above the tool strip, clear of the zoom pill */
        'absolute z-[35] h-9 max-w-[min(28rem,calc(100%-1.5rem))] gap-0.5 overflow-hidden px-1 py-0',
        isMobile
          ? cn(
              'bottom-[calc(112px+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2',
              drawing && 'bottom-[calc(172px+env(safe-area-inset-bottom))]',
            )
          : 'bottom-3.5 right-[calc(var(--chrome-right,12px)+5.75rem)]',
      )}
    >
      {pages.length > 1 && (
        <ToolbarButton
          aria-label={t('actions.previousPage')}
          disabled={at <= 0}
          className="shrink-0"
          onClick={() => stepPage(-1)}
        >
          <ChevronLeftIcon />
        </ToolbarButton>
      )}
      <div ref={listRef} role="list" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {pages.map((page) => {
          const current = page.id === activeId
          return (
            <ToolbarButton
              key={page.id}
              role="listitem"
              aria-current={current ? 'page' : undefined}
              aria-label={page.name}
              data-page-strip-id={page.id}
              title={page.name}
              className={cn(
                'flex! w-auto max-w-40 shrink-0 gap-1 px-1.5 sm:w-auto sm:px-1.5',
                current && 'bg-paper-deep text-ink hover:bg-paper-deep hover:text-ink',
              )}
              onClick={() => {
                if (!current) useStore.getState().setActivePage(page.id)
              }}
            >
              <PageIcon className="size-3.5 shrink-0" />
              <span className="truncate text-label">{page.name}</span>
            </ToolbarButton>
          )
        })}
      </div>
      {pages.length > 1 && (
        <ToolbarButton
          aria-label={t('actions.nextPage')}
          disabled={at < 0 || at >= pages.length - 1}
          className="shrink-0"
          onClick={() => stepPage(1)}
        >
          <ChevronRightIcon />
        </ToolbarButton>
      )}
    </Toolbar>
  )
}
