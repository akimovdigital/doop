import { useCallback, useContext, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Camera, ExternalLink, GripVertical, PanelRight, Play, MousePointerSquareDashed } from 'lucide-react'
import { rotatedBounds } from '../../shared/frameRotation'
import type { Frame } from '../../shared/types'
import { useIsMobile } from '../hooks/use-mobile'
import { useBrowserUi } from '../lib/browserFrames'
import { useT } from '../lib/i18n'
import { FrameLabelLayer } from './FrameLabelLayer'
import { Button } from './ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { IconButton } from './ui/icon-button'
import { Panel } from './ui/panel'

type Drag = (event: PointerEvent<HTMLDivElement>) => void
export type CaptureArea = 'visible' | 'full'

/* The frame and its portalled controls share one hover lease. Only the
   previous and next owners get notified, regardless of the frame count. */
let hoverOwner: (() => void) | undefined

export function useFrameChromeHover() {
  const [hovered, setHovered] = useState(false)
  const timer = useRef<number>()
  const release = useCallback(() => {
    window.clearTimeout(timer.current)
    setHovered(false)
  }, [])
  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      if (hoverOwner === release) hoverOwner = undefined
    },
    [release],
  )
  return {
    hovered,
    enter() {
      window.clearTimeout(timer.current)
      if (hoverOwner === release) return
      hoverOwner?.()
      hoverOwner = release
      setHovered(true)
    },
    leave() {
      if (hoverOwner !== release) return
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        hoverOwner = undefined
        release()
      }, 150)
    },
  }
}

export function FrameBrowserChrome({
  frame,
  address,
  reload,
  device,
  onDrag,
  onSide,
  onPresent,
  onActivate,
  onExit,
  onPick,
  picking,
  onCapture,
  onImport,
  onEnter,
  onLeave,
  onBarClick,
  busy,
  selected,
  html,
  sizeBadge,
}: {
  frame: Frame
  address: ReactNode
  reload: ReactNode
  device?: ReactNode
  onDrag?: Drag
  onSide: () => void
  onPresent: () => void
  onActivate?: () => void
  onExit?: () => void
  onPick?: () => void
  picking?: boolean
  onCapture?: (area: CaptureArea) => void
  onImport?: () => void
  onEnter?: () => void
  onLeave?: () => void
  onBarClick?: () => void
  busy?: boolean
  selected?: boolean
  html?: boolean
  sizeBadge?: boolean
}) {
  const layer = useContext(FrameLabelLayer)
  const t = useT()
  const { x, y, width, height } = rotatedBounds(frame, frame.rotation ?? 0)
  const px = (value: number) => `calc(${value}px * var(--zoom, 1))`
  const content = (
    <div
      data-canvas-browser-chrome={frame.id}
      data-html-browser-chrome={html || undefined}
      data-chrome-active={!!onExit || undefined}
      data-chrome-selected={selected || undefined}
      data-chrome-size-badge={sizeBadge || undefined}
      className="canvas-browser-chrome"
      style={
        layer
          ? {
              left: px(x),
              top: px(y),
              width: px(width),
              height: px(height),
            }
          : { inset: 0 }
      }
    >
      {html && (
        <div
          className="canvas-browser-outline"
          style={{ width: px(frame.width), height: px(frame.height), rotate: `${frame.rotation ?? 0}deg` }}
        />
      )}
      <div
        className="browser-canvas-bar browser-chrome"
        data-browser-controls=""
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        onPointerDown={(event) => {
          if (event.target instanceof Element && event.target.closest('button, input')) event.stopPropagation()
        }}
        onClickCapture={onBarClick}
        onDoubleClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        {onDrag && (
          <div
            className="grid size-6 flex-none cursor-grab place-items-center text-ink-faint"
            aria-label={t('canvas.browserDrag')}
            title={t('canvas.browserDrag')}
            onPointerDown={onDrag}
          >
            <GripVertical size={14} />
          </div>
        )}
        {reload}
        {address}
        {onActivate && (
          <IconButton size="sm" aria-label={t('canvas.chromeInteract')} onClick={onActivate}>
            <Play size={14} />
          </IconButton>
        )}
        {device}
        <IconButton size="sm" aria-label={t('canvas.browserSidePanel')} onClick={onSide}>
          <PanelRight size={14} />
        </IconButton>
        <IconButton size="sm" aria-label={t('canvas.browserPresent')} onClick={onPresent}>
          <ExternalLink size={14} />
        </IconButton>
        {onExit && (
          <Button
            variant="bare"
            type="button"
            className="h-4 rounded-row border border-line bg-paper-deep px-1 font-mono text-micro text-ink-soft"
            title={t('canvas.browserDeactivate')}
            aria-label={t('canvas.browserDeactivate')}
            onClick={onExit}
          >
            Esc
          </Button>
        )}
        {busy && <div className="browser-progress" aria-hidden="true" />}
      </div>
      {selected && (onPick || onCapture || onImport) && (
        <div
          className="browser-under-bar browser-chrome"
          data-browser-controls=""
          onPointerEnter={onEnter}
          onPointerLeave={onLeave}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          {onPick && (
            <IconButton size="sm" aria-label={t('canvas.chromePick')} on={picking} onClick={onPick}>
              <MousePointerSquareDashed size={14} />
            </IconButton>
          )}
          {onCapture && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <IconButton size="sm" aria-label={t('canvas.chromeCapture')}>
                  <Camera size={14} />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                width="sm"
                align="center"
                data-browser-controls=""
                onPointerDown={(event) => event.stopPropagation()}
              >
                <DropdownMenuItem onSelect={() => onCapture('visible')}>{t('canvas.chromeVisible')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onCapture('full')}>{t('canvas.chromeFull')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {onImport && (
            <Button size="sm" variant="bare" className="h-6 px-2 text-label" onClick={onImport}>
              {t('canvas.chromeImport')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
  return layer ? createPortal(content, layer) : content
}

/** Both side previews use the same width and the editor's resizable panel edge. */
export function BrowserSideResize({ width }: { width: number }) {
  const t = useT()
  const mobile = useIsMobile()
  if (mobile || !width) return null
  return (
    <Panel
      surface="docked"
      className="pointer-events-none left-0 bg-transparent"
      resize={{
        label: t('canvas.browserResizeSide'),
        edge: 'left',
        width: width + 1,
        min: 180,
        max: Math.floor(Math.min(900, window.innerWidth * 0.7)),
        onResize: (sideWidth) => useBrowserUi.setState({ sideWidth }),
      }}
    />
  )
}
