import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { RotateCw, X } from 'lucide-react'
import type { Frame } from '../../shared/types'
import { closeBrowserSurface } from '../lib/browserFrames'
import { framePreviewAddress } from '../lib/canvasFrameChrome'
import { useT } from '../lib/i18n'
import { IconButton } from './ui/icon-button'
import { BrowserSideResize } from './FrameBrowserChrome'

/** The same top-layer side surface as Browser, with the existing full-page
 * prototype route as its document. The editable canvas iframe stays put. */
export function HtmlFrameBrowserPanel({ frame }: { frame: Frame }) {
  const t = useT()
  const panel = useRef<HTMLDivElement>(null)
  const iframe = useRef<HTMLIFrameElement>(null)
  const [width, setWidth] = useState(0)
  const address = framePreviewAddress(frame)

  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    element.showPopover()
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0))
    observer.observe(element)
    return () => {
      observer.disconnect()
      element.hidePopover()
    }
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeBrowserSurface(frame.id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [frame.id])

  return (
    <div
      ref={panel}
      {...{ popover: 'manual' }}
      role="complementary"
      aria-label={frame.name}
      data-browser-surface="side"
      data-browser-controls=""
      className="browser-surface"
    >
      <div className="browser-overlay-bar">
        <div className="browser-chrome min-w-0 flex-1">
          <IconButton
            size="sm"
            aria-label={t('canvas.browserReload')}
            onClick={() => {
              if (iframe.current) iframe.current.src = address
            }}
          >
            <RotateCw size={14} />
          </IconButton>
          <span className="truncate px-1 text-label" title={address}>
            {address}
          </span>
          <IconButton
            size="sm"
            aria-label={t('canvas.browserClose')}
            className="ml-auto"
            onClick={() => closeBrowserSurface(frame.id)}
          >
            <X size={14} />
          </IconButton>
        </div>
      </div>
      <iframe ref={iframe} src={address} title={frame.name} className="min-h-0 w-full flex-1 border-0 bg-paper" />
      <BrowserSideResize width={width} />
    </div>
  )
}
