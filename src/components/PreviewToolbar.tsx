import { useEffect, useId, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useT } from '@/lib/i18n'
import { prototypePath } from '../lib/prototype'
import { previewTrafficLightsClass } from '../lib/shell'
import { isProtoScaling, matchPreviewFrames, previewFrameFromAddress, type ProtoScaling } from '../lib/prototypePlayer'
import { DesignModeToggle } from './DesignModeOverlay'
import { IconButton } from './ui/icon-button'
import { Input } from './ui/input'
import { cn } from '@/lib/utils'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CommentIcon,
  DesktopIcon,
  ExportIcon,
  HistoryIcon,
  HotspotIcon,
  PreviewExpandIcon,
  PreviewMinimizeIcon,
  SyncIcon,
  XIcon,
} from './ui/icons'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

type Screen = { id: string; name: string }

interface PreviewToolbarProps {
  hidden?: boolean
  frameMenu?: ReactNode
  onComment?: () => void
  commenting?: boolean
  annotationHint?: ReactNode
  annotationControls?: ReactNode
  addressRef: RefObject<HTMLInputElement>
  canvasId?: string
  frameId: string
  frameName?: string
  frames: readonly Screen[]
  searchFrames: readonly Screen[]
  canBack: boolean
  canForward: boolean
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onNavigate: (id: string) => void
  onRestart: () => void
  onHotspots: () => void
  /** editors: the pointer-in-square button toggles Design Mode (⌘⇧D) instead of flashing hotspots */
  onDesignMode?: () => void
  designModeOn?: boolean
  scaling: ProtoScaling
  onScalingChange: (next: ProtoScaling) => void
  onMenuClose: (event: Event) => void
  minimized: boolean
  onToggleWindow?: () => void
  onClose?: () => void
}

export function PreviewToolbar(props: PreviewToolbarProps) {
  const t = useT()
  const { canvasId, frameId, minimized, onToggleWindow, onClose } = props
  return (
    <div
      data-preview-toolbar=""
      data-proto-bar=""
      role="group"
      aria-label={t('panels.protoToolbar')}
      className={cn(
        'dark @container relative z-10 flex h-10 shrink-0 items-center gap-1.5 border-b border-line bg-surface px-1.5 text-ink sm:gap-2 sm:px-2',
        props.hidden && 'invisible',
        minimized && 'rounded-t-panel',
        previewTrafficLightsClass(!minimized),
        props.annotationHint && 'border-brand/30',
      )}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      {props.annotationHint ?? (
        <>
          <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
            <IconButton size="sm" aria-label={t('common.back')} disabled={!props.canBack} onClick={props.onBack}>
              <ArrowLeftIcon size="rail" />
            </IconButton>
            <IconButton
              size="sm"
              aria-label={t('panels.protoForward')}
              disabled={!props.canForward}
              onClick={props.onForward}
            >
              <ArrowRightIcon size="rail" />
            </IconButton>
            <IconButton size="sm" aria-label={t('panels.protoReload')} onClick={props.onReload}>
              <SyncIcon size="rail" />
            </IconButton>
          </div>
          {canvasId && <PreviewAddress key={frameId} {...props} canvasId={canvasId} />}
        </>
      )}
      {!props.annotationHint && <div className="hidden min-w-0 @md:block">{props.frameMenu}</div>}
      <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
        <IconButton size="sm" aria-label={t('panels.protoRestart')} onClick={props.onRestart}>
          <HistoryIcon size="rail" />
        </IconButton>
        {props.onDesignMode && <DesignModeToggle enabled={!!props.designModeOn} onToggle={props.onDesignMode} />}
        {!props.designModeOn && (
          <IconButton
            size="sm"
            data-proto-hotspots=""
            aria-label={t('panels.protoHotspots')}
            onClick={props.onHotspots}
          >
            <HotspotIcon size="rail" />
          </IconButton>
        )}
        {props.onComment && (
          <IconButton
            size="sm"
            data-proto-comments=""
            aria-label={t('panels.protoComments')}
            title={t('panels.protoCommentsTitle')}
            aria-pressed={props.commenting}
            onClick={props.onComment}
          >
            <CommentIcon size="rail" />
          </IconButton>
        )}
        <ScalingMenu scaling={props.scaling} onChange={props.onScalingChange} onClose={props.onMenuClose} />
        {onClose && canvasId && (
          <IconButton
            size="sm"
            aria-label={t('panels.protoNewTab')}
            onClick={() => window.open(prototypePath(canvasId, frameId), '_blank', 'noopener')}
          >
            <ExportIcon size="rail" />
          </IconButton>
        )}
      </div>
      {props.annotationControls}
      {onClose && (
        <div className="flex shrink-0 items-center gap-0.5 border-l border-line pl-1 sm:gap-1 sm:pl-2">
          {onToggleWindow && (
            <IconButton
              size="sm"
              aria-label={t(minimized ? 'panels.protoExpand' : 'panels.protoMinimize')}
              onClick={onToggleWindow}
            >
              {minimized ? <PreviewExpandIcon size="rail" /> : <PreviewMinimizeIcon size="rail" />}
            </IconButton>
          )}
          <IconButton size="sm" aria-label={t('panels.protoExit')} title={t('panels.protoExitTitle')} onClick={onClose}>
            <XIcon size="rail" />
          </IconButton>
        </div>
      )}
    </div>
  )
}

function PreviewAddress({
  addressRef,
  canvasId,
  frameId,
  frameName,
  frames,
  searchFrames,
  onNavigate,
}: Pick<PreviewToolbarProps, 'addressRef' | 'frameId' | 'frameName' | 'frames' | 'searchFrames' | 'onNavigate'> & {
  canvasId: string
}) {
  const t = useT()
  const listId = useId()
  const address = location.host + prototypePath(canvasId, frameId)
  const [focused, setFocused] = useState(false)
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(-1)
  const [invalid, setInvalid] = useState(false)
  const options = focused ? matchPreviewFrames(searchFrames, query ?? '') : []
  const open = focused && options.length > 0 && !invalid
  const activeId = open && options[active] ? `${listId}-${active}` : undefined

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  useEffect(() => {
    if (!invalid) return
    const timer = window.setTimeout(() => setInvalid(false), 2400)
    return () => window.clearTimeout(timer)
  }, [invalid])

  function reset() {
    setFocused(false)
    setQuery(null)
    setActive(-1)
  }

  function choose(id: string) {
    addressRef.current?.blur()
    onNavigate(id)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.currentTarget.blur()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((index) =>
        index < 0 ? (step > 0 ? 0 : options.length - 1) : (index + step + options.length) % options.length,
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const linked = query && previewFrameFromAddress(query, prototypePath(canvasId))
      const selected = linked
        ? frames.find((frame) => frame.id === linked)
        : (options[active] ?? (query?.trim() ? options[0] : undefined))
      if (selected) choose(selected.id)
      else if (query?.trim()) {
        event.currentTarget.blur()
        setInvalid(true)
      } else event.currentTarget.blur()
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      <div
        data-slot="bar-pill"
        className="flex h-7 min-w-0 items-center gap-2 rounded-pill bg-sub px-2 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/60"
      >
        <Input
          variant="bare"
          inputSize="auto"
          ref={addressRef}
          role="combobox"
          aria-label={t('panels.protoAddress')}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          value={query ?? address}
          title={address}
          className="min-w-0 flex-1 truncate bg-transparent text-caption text-ink-soft focus:text-ink md:text-caption"
          onFocus={(event) => {
            setInvalid(false)
            setFocused(true)
            event.currentTarget.select()
          }}
          onBlur={reset}
          onClick={(event) => {
            if (query === null) event.currentTarget.select()
          }}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(-1)
          }}
          onKeyDown={onKeyDown}
        />
        <span
          className="hidden max-w-[35%] truncate text-caption text-ink-faint @min-[480px]:block"
          title={frameName}
          data-proto-current=""
        >
          {frameName ?? t('panels.protoMissing')}
        </span>
      </div>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('panels.protoScreens')}
          className="absolute top-full left-0 mt-2 max-h-52 w-[min(100%,360px)] min-w-[min(220px,calc(100vw-110px))] overflow-auto rounded-card border border-line bg-surface p-1.5 shadow-pop"
        >
          {options.map((frame, index) => (
            <li
              key={frame.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={active === index}
              className="cursor-pointer truncate rounded-control px-2.5 py-2 text-label hover:bg-sub aria-selected:bg-sub"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(frame.id)}
              title={frame.name}
            >
              {frame.name}
            </li>
          ))}
        </ul>
      )}
      <span className="sr-only" role="status">
        {invalid ? t('panels.protoNoMatch') : ''}
      </span>
      {invalid && (
        <div
          aria-hidden="true"
          className="absolute top-full left-0 mt-2 w-max max-w-[calc(100vw-110px)] rounded-card border border-line bg-surface px-3 py-2 text-caption shadow-pop"
        >
          {t('panels.protoNoMatch')}
        </div>
      )}
    </div>
  )
}

/** How the player scales its screens: the two recommended choices, then
 *  the scaled ones. */
function ScalingMenu({
  scaling,
  onChange,
  onClose,
}: {
  scaling: ProtoScaling
  onChange: (next: ProtoScaling) => void
  onClose: (event: Event) => void
}) {
  const t = useT()
  const pick = (value: string) => isProtoScaling(value) && onChange(value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild data-proto-menu-trigger="" onKeyDown={(e) => e.stopPropagation()}>
        <IconButton size="sm" aria-label={t('panels.protoScaling')}>
          <DesktopIcon size="rail" />
        </IconButton>
      </DropdownMenuTrigger>
      {/* above the player, which sits over every other layer of the editor */}
      <DropdownMenuContent
        width="md"
        className="z-[90]"
        data-proto-menu=""
        onKeyDown={(e) => e.stopPropagation()}
        /* a closed menu hands the keys back to the prototype: the screen that
           takes them gets the focus; with none up, the button keeps it */
        onCloseAutoFocus={onClose}
      >
        <DropdownMenuRadioGroup value={scaling} onValueChange={pick}>
          <DropdownMenuCaption>{t('panels.protoScalingRecommended')}</DropdownMenuCaption>
          <DropdownMenuRadioItem value="actual">{t('panels.protoScaleActual')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="responsive">{t('panels.protoScaleResponsive')}</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          <DropdownMenuCaption>{t('panels.protoScalingOther')}</DropdownMenuCaption>
          <DropdownMenuRadioItem value="fit-width">{t('panels.protoScaleFitWidth')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="fit">{t('panels.protoScaleFit')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="fill">{t('panels.protoScaleFill')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
