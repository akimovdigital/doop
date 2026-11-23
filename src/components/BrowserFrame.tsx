import { MOBILE_QUERY } from '../hooks/use-mobile'
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  GripVertical,
  Laptop,
  LoaderCircle,
  Minimize2,
  PanelRight,
  RotateCw,
  Smartphone,
  Tablet,
  X,
} from 'lucide-react'
import {
  BROWSER_DEVICES,
  browserAddress,
  browserDeviceSize,
  browserFrameSchema,
  browserViewport,
  type BrowserDevice,
} from '../../shared/browserFrame'
import type { Frame } from '../../shared/types'
import {
  changeBrowserDevice,
  closeBrowserSurface,
  navigateBrowser,
  openBrowserSurface,
  reloadBrowser,
  revealBrowserControl,
  useBrowserUi,
} from '../lib/browserFrames'
import { useT } from '../lib/i18n'
import { counterZoom, FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY } from '../lib/layoutZoom'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { cn } from '../lib/utils'
import { BrowserAddressField } from './BrowserAddressField'
import { FrameResizeHandles } from './FrameResizeHandles'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { Panel } from './ui/panel'
import { useIsMobile } from '../hooks/use-mobile'
import type { ResizeHandle } from '../lib/elementResize'

type WebPage = { src: string; request?: { address: string; reload: number }; status: 'loading' | 'ready' | 'error' }
const DEVICE_ICONS = { laptop: Laptop, tablet: Tablet, phone: Smartphone }
const ACTIVATION_DELAY = 300
const ACTIVATION_MOVE_LIMIT = 4

function movedPastClick(start: { x: number; y: number }, event: ReactPointerEvent) {
  return Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > ACTIVATION_MOVE_LIMIT
}

/** CSS top layer changes how the element paints without changing its parent.
 * Moving the iframe to a portal or constructing a second iframe restarts it. */
function animateBrowserSurface(element: HTMLElement, rect: DOMRect, entering: boolean) {
  if (!element.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const full = element.getBoundingClientRect()
  if (!rect.width || !rect.height || !full.width || !full.height) return
  const from = {
    transform: `translate(${rect.x - full.x}px, ${rect.y - full.y}px) scale(${rect.width / full.width}, ${rect.height / full.height})`,
    opacity: 0.4,
  }
  const to = { transform: 'none', opacity: 1 }
  return element.animate(entering ? [from, to] : [to, from], {
    duration: 220,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'forwards',
  })
}

export function BrowserFrame({
  frame,
  stack,
  layoutZoom,
  loadDocument,
  onDrag,
  onResize,
  onRotate,
}: {
  frame: Frame & { browser: NonNullable<Frame['browser']> }
  stack?: number
  layoutZoom: number
  loadDocument: boolean
  onDrag: (event: ReactPointerEvent<HTMLDivElement>) => void
  onResize: (event: ReactPointerEvent<HTMLDivElement>, handle: ResizeHandle) => void
  onRotate: (event: ReactPointerEvent<HTMLDivElement>) => void
}) {
  const t = useT()
  const mobile = useIsMobile()
  const { browser } = frame
  const selected = useStore((s) => s.selectedIds.includes(frame.id))
  const soleSelected = useStore((s) => s.selectedIds.length === 1 && s.selectedId === frame.id)
  const tool = useStore((s) => s.tool)
  const panMode = useStore((s) => s.panMode)
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const editable = !readOnly && !frame.locked
  const canvasInput = tool === 'select' && !panMode && !frame.locked
  const mode = useBrowserUi((s) => (s.surface?.frameId === frame.id ? s.surface.mode : null))
  const reload = useBrowserUi((s) => s.reloads[frame.id] ?? 0)
  const focusRequested = useBrowserUi((s) => s.focusId === frame.id)
  const shell = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDialogElement>(null)
  const iframe = useRef<HTMLIFrameElement>(null)
  const overlayAddress = useRef<HTMLInputElement>(null)
  const exitButton = useRef<HTMLButtonElement>(null)
  const [active, setActive] = useState(false)
  const [editing, setEditing] = useState(false)
  const [page, setPage] = useState<WebPage>({ src: '', status: 'ready' })
  const [topMode, setTopMode] = useState<typeof mode>(null)
  const [overlayWidth, setOverlayWidth] = useState<number>()
  const [overlayHeight, setOverlayHeight] = useState<number>()
  const [overlayDevice, setOverlayDevice] = useState<BrowserDevice>()
  const [visited, setVisited] = useState({ entries: [browser.url], index: 0 })
  const [everLoaded, setEverLoaded] = useState(false)
  const shouldLoad = everLoaded || loadDocument || !!mode
  const press = useRef<{ x: number; y: number; selected: boolean } | null>(null)
  const activation = useRef<ReturnType<typeof setTimeout>>()
  const targetIndex = useRef<number | null>(null)
  const pageRequest = useRef<string>()
  const awaitingLoad = useRef(false)
  const address = browserFrameSchema.shape.url.safeParse(browser.url).success ? browser.url : ''
  const canInteract = soleSelected && canvasInput && !mode
  const interactions = active && canInteract && !!address
  const overlay = mode ?? topMode
  if (active && (!canInteract || !address)) setActive(false)
  if (editing && !canInteract) setEditing(false)
  if (mode && mode !== topMode) setTopMode(mode)
  if (!everLoaded && shouldLoad) setEverLoaded(true)

  function cancelActivation() {
    clearTimeout(activation.current)
    press.current = null
  }

  useEffect(() => cancelActivation, [soleSelected, canvasInput, mode, address])

  useEffect(() => {
    const id = frame.id
    return () => closeBrowserSurface(id)
  }, [frame.id])

  useEffect(() => {
    if (frame.hidden) closeBrowserSurface(frame.id)
  }, [frame.hidden, frame.id])

  useEffect(() => {
    const index = targetIndex.current
    targetIndex.current = null
    setVisited((previous) => {
      if (previous.entries[previous.index] === address) return previous
      if (index !== null && previous.entries[index] === address) return { ...previous, index }
      return { entries: [...previous.entries.slice(0, previous.index + 1), address], index: previous.index + 1 }
    })
  }, [address])

  useEffect(() => {
    if (!shouldLoad || !address) return
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 5000)
    let current = true
    awaitingLoad.current = false
    // Check reachability in the viewer's browser. A server fetch would probe
    // the server's network and its loopback rather than the viewer's site.
    void fetch(address, {
      method: 'HEAD',
      mode: 'no-cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })
      .then(() => {
        if (!current) return
        const previous = pageRequest.current
        pageRequest.current = address
        awaitingLoad.current = true
        if (previous === address && iframe.current) {
          // Assigning the same src explicitly navigates even after an in-page link.
          iframe.current.src = address
        }
        setPage({ src: address, request: { address, reload }, status: 'loading' })
      })
      .catch(() => {
        if (current) setPage((previous) => ({ ...previous, request: { address, reload }, status: 'error' }))
      })
      .finally(() => clearTimeout(timeout))
    return () => {
      current = false
      controller.abort()
      clearTimeout(timeout)
    }
  }, [address, reload, shouldLoad])

  useLayoutEffect(() => {
    const element = surface.current
    const placeholder = shell.current
    if (!element || !placeholder) return
    if (mode) {
      const rect = placeholder.getBoundingClientRect()
      if (mode === 'present') {
        if (element.matches(':popover-open')) element.hidePopover()
        if (!element.open) element.showModal()
        exitButton.current?.focus()
      } else {
        if (element.open) element.close()
        if (!element.matches(':popover-open')) element.showPopover?.()
      }
      const animation = mode === 'present' ? animateBrowserSurface(element, rect, true) : undefined
      return () => animation?.cancel()
    }

    if (!topMode) return
    const finish = () => {
      if (element.open) element.close()
      if (element.matches(':popover-open')) element.hidePopover()
      setTopMode(null)
      if (topMode === 'present') {
        useStore.getState().select(frame.id)
        placeholder.focus({ preventScroll: true })
      }
    }
    const animation =
      topMode === 'present' ? animateBrowserSurface(element, placeholder.getBoundingClientRect(), false) : undefined
    if (animation) void animation.finished.then(finish, () => {})
    else finish()
    return () => animation?.cancel()
  }, [mode, topMode, frame.id])

  useLayoutEffect(() => {
    if (!overlay) return
    const element = surface.current?.querySelector<HTMLElement>('[data-browser-viewport]')
    if (!element) return
    const measure = () => {
      setOverlayWidth(element.clientWidth)
      setOverlayHeight(element.clientHeight)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [overlay])

  function go(delta: number) {
    const index = visited.index + delta
    const url = visited.entries[index]
    if (!editable || url === undefined) return
    targetIndex.current = index
    navigateBrowser(frame, url)
  }

  useEffect(() => {
    if (!interactions && !overlay) return
    function onKey(event: KeyboardEvent) {
      const target = event.target
      if (overlay === 'side' && (!(target instanceof Node) || !surface.current?.contains(target))) return
      const typing = target instanceof HTMLInputElement
      if (event.key === 'Escape' && (!typing || overlay)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (overlay) closeBrowserSurface(frame.id)
        else {
          setActive(false)
          shell.current?.focus({ preventScroll: true })
        }
      } else if (overlay && (event.metaKey || event.ctrlKey)) {
        switch (event.code) {
          case 'BracketLeft':
            go(-1)
            break
          case 'BracketRight':
            go(1)
            break
          case 'KeyR':
            reloadBrowser(frame.id)
            break
          case 'KeyL':
            overlayAddress.current?.focus()
            break
          default:
            return
        }
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const nextDevice = (device?: BrowserDevice) =>
    BROWSER_DEVICES[(device ? BROWSER_DEVICES.indexOf(device) + 1 : 0) % BROWSER_DEVICES.length]!
  const device = overlay ? overlayDevice : browser.deviceId
  const DeviceIcon = DEVICE_ICONS[device ?? 'laptop']
  const zoom = browser.zoom ?? 1
  const availableWidth = overlayWidth ?? frame.width
  const availableHeight = overlayHeight ?? frame.height
  const preset = browserDeviceSize(overlayDevice, { width: availableWidth, height: availableHeight })
  const fit = overlay && overlayDevice ? Math.min(1, availableWidth / preset.width, availableHeight / preset.height) : 1
  const size = overlay ? preset : frame
  const viewport = browserViewport(size.width, size.height, zoom)
  const iframeScale = zoom * fit * (!overlay && !FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY ? layoutZoom : 1)
  const settledRequest = page.request?.address === address && page.request.reload === reload
  const busy = !!address && (!settledRequest || page.status === 'loading')
  const failed = settledRequest && page.status === 'error'
  const ReloadIcon = busy ? LoaderCircle : RotateCw
  const reloadControl = (
    <IconButton
      size="sm"
      aria-label={t('canvas.browserReload')}
      disabled={!address}
      onClick={() => reloadBrowser(frame.id)}
    >
      <ReloadIcon size={14} className={busy ? 'motion-safe:animate-spin' : undefined} />
    </IconButton>
  )
  const deviceControl = (
    <IconButton
      size="sm"
      aria-label={t('canvas.browserNextDevice')}
      disabled={!overlay && !editable}
      onClick={() => {
        if (overlay) setOverlayDevice(nextDevice(overlayDevice))
        else changeBrowserDevice(frame, nextDevice(browser.deviceId))
      }}
    >
      <DeviceIcon size={14} />
    </IconButton>
  )
  const commit = (value: string) => {
    if (!navigateBrowser(frame, value)) return false
    setEditing(false)
    return true
  }
  const focusPrompt = (input: HTMLInputElement | null) => {
    if (!input || !focusRequested) return
    useBrowserUi.setState({ focusId: null })
    input.focus({ preventScroll: true })
    revealBrowserControl(input)
  }

  return (
    <div
      ref={shell}
      data-doop-frame-shell={frame.id}
      data-frame-locked={frame.locked ? '' : undefined}
      data-browser-frame=""
      data-browser-active={interactions || undefined}
      hidden={frame.hidden}
      tabIndex={-1}
      className="absolute outline-none"
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        zIndex: stack,
        transform: frame.rotation ? `rotate(${frame.rotation}deg)` : undefined,
      }}
    >
      <div
        className="browser-canvas-bar browser-chrome"
        data-browser-controls=""
        onPointerDown={(event) => {
          // Let Hand pan from the grip, while a control keeps its own click.
          if (event.target instanceof Element && event.target.closest('button, input')) event.stopPropagation()
        }}
        onClickCapture={() => {
          // Keep the Esc button mounted until the click, including from an iframe.
          cancelActivation()
          setActive(false)
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <div
          className="grid size-6 flex-none cursor-grab place-items-center text-ink-faint"
          aria-label={t('canvas.browserDrag')}
          title={t('canvas.browserDrag')}
          onPointerDown={onDrag}
        >
          <GripVertical size={14} />
        </div>
        {reloadControl}
        {editing && !overlay ? (
          <BrowserAddressField
            url={address}
            autoFocus
            className="h-5 flex-1"
            onCommit={commit}
            onCancel={() => setEditing(false)}
            onReveal={revealBrowserControl}
          />
        ) : (
          <Button
            variant="bare"
            type="button"
            title={address || t('canvas.browserUrl')}
            aria-label={t('canvas.browserUrl')}
            className="h-6 min-w-0 flex-1 justify-start overflow-hidden rounded-row px-1 text-label focus-visible:ring-2 focus-visible:ring-ring/40"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              if (!editable) return
              const state = useStore.getState()
              state.select(frame.id)
              if (!window.matchMedia(MOBILE_QUERY).matches) state.setInspectorOpen(true)
              if (soleSelected) setEditing(true)
            }}
          >
            <span className="truncate">{browserAddress(address) || t('canvas.browserUrl')}</span>
          </Button>
        )}
        {deviceControl}
        <IconButton
          size="sm"
          aria-label={t('canvas.browserSidePanel')}
          onClick={() => openBrowserSurface(frame, 'side')}
        >
          <PanelRight size={14} />
        </IconButton>
        <IconButton
          size="sm"
          aria-label={t('canvas.browserPresent')}
          onClick={() => openBrowserSurface(frame, 'present')}
        >
          <ExternalLink size={14} />
        </IconButton>
        {interactions && (
          <Button
            variant="bare"
            type="button"
            className="h-4 rounded-row border border-line bg-paper-deep px-1 font-mono text-micro text-ink-soft"
            title={t('canvas.browserDeactivate')}
            aria-label={t('canvas.browserDeactivate')}
            onClick={() => shell.current?.focus({ preventScroll: true })}
          >
            Esc
          </Button>
        )}
        {busy && <div className="browser-progress" aria-hidden="true" />}
      </div>
      <dialog
        ref={surface}
        {...{ popover: 'manual' }}
        data-browser-surface={overlay ?? 'canvas'}
        data-stage-scroll={overlay ? '' : undefined}
        data-browser-controls={overlay ? '' : undefined}
        role={overlay === 'side' ? 'complementary' : overlay === 'present' ? 'dialog' : 'presentation'}
        onCancel={(event) => {
          event.preventDefault()
          closeBrowserSurface(frame.id)
        }}
        aria-modal={overlay === 'present' ? true : undefined}
        aria-label={overlay ? frame.name : undefined}
        className="browser-surface"
        onPointerDown={(event) => {
          if (overlay) event.stopPropagation()
        }}
      >
        {overlay && (
          <div className="browser-overlay-bar">
            <div className="browser-chrome min-w-0 flex-1">
              {overlay === 'present' && (
                <>
                  <IconButton
                    size="sm"
                    aria-label={t('canvas.browserBack')}
                    disabled={!editable || visited.index <= 0}
                    onClick={() => go(-1)}
                  >
                    <ArrowLeft size={15} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    aria-label={t('canvas.browserForward')}
                    disabled={!editable || visited.index >= visited.entries.length - 1}
                    onClick={() => go(1)}
                  >
                    <ArrowRight size={15} />
                  </IconButton>
                </>
              )}
              {reloadControl}
              <BrowserAddressField
                inputRef={overlayAddress}
                url={address}
                readOnly={!editable}
                className="h-6 flex-1"
                onCommit={commit}
              />
              {(overlay === 'side' || availableWidth > 390) && deviceControl}
              {busy && <div className="browser-progress" aria-hidden="true" />}
            </div>
            <div className="browser-chrome">
              {overlay === 'present' && (
                <IconButton
                  size="sm"
                  aria-label={t('canvas.browserExitFullScreen')}
                  onClick={() => closeBrowserSurface(frame.id)}
                >
                  <Minimize2 size={15} />
                </IconButton>
              )}
              <IconButton
                ref={exitButton}
                data-browser-present-close=""
                size="sm"
                aria-label={t('canvas.browserClose')}
                onClick={() => closeBrowserSurface(frame.id)}
              >
                <X size={15} />
              </IconButton>
            </div>
          </div>
        )}
        <div
          data-browser-viewport=""
          className={cn(
            'browser-viewport',
            !overlay && (interactions ? 'browser-live' : selected ? 'browser-selected' : 'browser-hover'),
          )}
          style={overlay ? undefined : { borderRadius: browser.cornerRadius ?? 12 }}
        >
          <div
            className="relative overflow-hidden bg-sub"
            style={{
              width: overlay ? size.width * fit : '100%',
              height: overlay ? size.height * fit : '100%',
              opacity: overlay ? 1 : (browser.opacity ?? 1),
            }}
          >
            {page.src && address && (
              <iframe
                ref={iframe}
                src={page.src}
                title={frame.name}
                // An external URL can redirect back to the editor's origin.
                sandbox="allow-scripts allow-forms allow-popups allow-modals"
                referrerPolicy="no-referrer"
                tabIndex={interactions || overlay ? 0 : -1}
                style={{
                  ...viewport,
                  ...(!overlay && !FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY ? { zoom: counterZoom(layoutZoom) } : null),
                  transform: `scale(${iframeScale})`,
                  visibility: failed ? 'hidden' : undefined,
                  pointerEvents: interactions || overlay ? 'auto' : 'none',
                }}
                className="absolute top-0 left-0 origin-top-left border-0 bg-surface"
                onLoad={() => {
                  if (!awaitingLoad.current || pageRequest.current !== address) return
                  awaitingLoad.current = false
                  setPage((previous) => ({ ...previous, status: 'ready' }))
                }}
              />
            )}
            {!interactions && !overlay && (
              <div
                className="absolute inset-0"
                data-browser-shield=""
                onPointerDown={(event) => {
                  cancelActivation()
                  press.current =
                    canvasInput &&
                    event.button === 0 &&
                    !event.shiftKey &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.altKey
                      ? { x: event.clientX, y: event.clientY, selected: soleSelected }
                      : null
                  onDrag(event)
                  const state = useStore.getState()
                  if (canvasInput && state.selectedId === frame.id && !window.matchMedia(MOBILE_QUERY).matches)
                    state.setInspectorOpen(true)
                }}
                onPointerMove={(event) => {
                  if (press.current && movedPastClick(press.current, event)) press.current = null
                }}
                onPointerLeave={() => {
                  press.current = null
                }}
                onPointerUp={(event) => {
                  const start = press.current
                  press.current = null
                  if (!start?.selected || !address || movedPastClick(start, event)) return
                  activation.current = setTimeout(() => setActive(true), ACTIVATION_DELAY)
                }}
                onPointerCancel={cancelActivation}
                onDoubleClick={(event) => {
                  if (!canvasInput) return
                  event.stopPropagation()
                  cancelActivation()
                  openBrowserSurface(frame, 'present')
                }}
              />
            )}
            {!address && (
              <div className="browser-message">
                {editable && (
                  <BrowserAddressField
                    inputRef={focusPrompt}
                    url=""
                    tabIndex={selected || overlay ? undefined : -1}
                    className={cn('h-8 w-full max-w-80', (selected || overlay) && 'pointer-events-auto')}
                    onCommit={commit}
                    onReveal={overlay ? undefined : revealBrowserControl}
                  />
                )}
                <span>{t('canvas.browserPrompt')}</span>
              </div>
            )}
            {!!address && failed && (
              <div className="browser-message" role="status">
                <span>{t('canvas.browserUnreachable', { host: new URL(address).host })}</span>
                <Button
                  size="sm"
                  variant="bare"
                  className="pointer-events-auto"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => reloadBrowser(frame.id)}
                >
                  {t('canvas.browserRetry')}
                </Button>
              </div>
            )}
          </div>
        </div>
        {overlay === 'side' && !mobile && overlayWidth !== undefined && (
          <Panel
            surface="docked"
            className="pointer-events-none left-0 bg-transparent"
            resize={{
              label: t('canvas.browserResizeSide'),
              edge: 'left',
              width: overlayWidth + 1,
              min: 180,
              max: Math.floor(Math.min(900, window.innerWidth * 0.7)),
              onResize: (sideWidth) => useBrowserUi.setState({ sideWidth }),
            }}
          />
        )}
      </dialog>
      {selected && canvasInput && editable && !overlay && !interactions && (
        <FrameResizeHandles rotation={frame.rotation ?? 0} onStart={onResize} onRotateStart={onRotate} />
      )}
    </div>
  )
}
