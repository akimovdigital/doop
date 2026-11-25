import { useState, type RefObject } from 'react'
import { useStore } from '../lib/store'
import { useIsMobile } from '../hooks/use-mobile'
import { ALT_KEY, MOD_KEY } from '../lib/keys'
import { parseZoomPercent } from '../lib/viewOptions'
import { MenuHint } from './ui/menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Toolbar, ToolbarButton } from './ui/toolbar'
import { Input } from './ui/input'
import { MinusIcon, PlusIcon } from './ui/icons'
import { useT } from '../lib/i18n'

/* The zoom pill at the bottom right of the open canvas: step out, the current
   level, step in. The level doubles as the trigger of a menu with the preset
   zooms, a field to type one, the fits and what the canvas draws over the
   frames. The Stage writes the percentage into `labelRef` straight
   from its viewport subscription, so pan/zoom never re-renders this. */
export function ZoomControls({
  labelRef,
  onZoomIn,
  onZoomOut,
  onZoomTo,
  onFit,
  onFitSelection,
}: {
  labelRef: RefObject<HTMLSpanElement>
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomTo: (zoom: number) => void
  onFit: () => void
  onFitSelection: () => void
}) {
  const t = useT()
  const isMobile = useIsMobile()
  const hasSelection = useStore((s) => s.selectedIds.length > 0)
  const rulers = useStore((s) => s.rulers)
  const toggleRulers = useStore((s) => s.toggleRulers)
  const viewOptions = useStore((s) => s.viewOptions)
  const toggleViewOption = useStore((s) => s.toggleViewOption)
  const [open, setOpen] = useState(false)
  /* the typed level, seeded with the current one each time the menu opens */
  const [draft, setDraft] = useState('')
  function onOpenChange(next: boolean) {
    if (next) setDraft(`${Math.round(useStore.getState().viewport.zoom * 100)}%`)
    setOpen(next)
  }
  function applyDraft() {
    const zoom = parseZoomPercent(draft)
    if (zoom === null) return
    onZoomTo(zoom)
    setOpen(false)
  }
  /* phones have no room for shortcut hints, and no keyboard to use them */
  const hint = (keys: string) => !isMobile && <MenuHint>{keys}</MenuHint>

  return (
    <Toolbar className="h-9 shrink-0 gap-0.5 px-1 py-0">
      <ToolbarButton aria-label={t('canvas.zoomOut')} onClick={onZoomOut}>
        <MinusIcon />
      </ToolbarButton>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <ToolbarButton
            aria-label={t('canvas.zoomLevel')}
            className="w-auto min-w-[48px] px-1.5 font-mono text-[12px] text-ink md:w-auto md:px-1.5"
          >
            <span ref={labelRef}>100%</span>
          </ToolbarButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" width="md">
          <div className="p-1.5">
            <Input
              variant="mono"
              inputSize="sm"
              aria-label={t('canvas.zoomLevel')}
              value={draft}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                /* the menu's own keys (typeahead, arrows) stay out of the
                   field; Esc still closes the menu */
                if (e.key !== 'Escape') e.stopPropagation()
                if (e.key === 'Enter') applyDraft()
              }}
            />
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onZoomIn}>
            {t('canvas.zoomIn')}
            {hint(`${MOD_KEY}+`)}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onZoomOut}>
            {t('canvas.zoomOut')}
            {hint(`${MOD_KEY}−`)}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onFit}>
            {t('canvas.zoomToFit')}
            {hint('⇧1')}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasSelection} onSelect={onFitSelection}>
            {t('canvas.zoomToSelection')}
            {hint('⇧2')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onZoomTo(0.5)}>{t('canvas.zoomTo', { percent: 50 })}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onZoomTo(1)}>
            {t('canvas.zoomTo', { percent: 100 })}
            {hint(`${MOD_KEY}0`)}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onZoomTo(2)}>{t('canvas.zoomTo', { percent: 200 })}</DropdownMenuItem>
          {/* phones show no rulers, so there is nothing to toggle there */}
          {!isMobile && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={toggleRulers}>
                {rulers ? t('canvas.hideRulers') : t('canvas.showRulers')}
                {hint('⇧R')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => toggleViewOption('pixelGrid')}>
                {viewOptions.pixelGrid ? t('canvas.hidePixelGrid') : t('canvas.showPixelGrid')}
                {hint("⇧'")}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => toggleViewOption('cursors')}>
            {viewOptions.cursors ? t('canvas.hideCursors') : t('canvas.showCursors')}
            {hint(`${MOD_KEY}${ALT_KEY}\\`)}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => toggleViewOption('comments')}>
            {viewOptions.comments ? t('canvas.hideComments') : t('canvas.showComments')}
            {hint('⇧C')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ToolbarButton aria-label={t('canvas.zoomIn')} onClick={onZoomIn}>
        <PlusIcon />
      </ToolbarButton>
    </Toolbar>
  )
}
