import { useEffect, useRef, type KeyboardEvent } from 'react'
import { api } from '../lib/api'
import { posthog } from '../lib/posthog'
import { navigate } from '../App'
import { FrameIcon, HomeIcon, PinIcon, PlusIcon, UnpinIcon, XIcon } from './ui/icons'
import { Tooltip } from './ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu'
import { cn } from '@/lib/utils'
import {
  TAB_SHORTCUTS,
  canvasTabTarget,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  ensureTab,
  openCanvasTab,
  openExternal,
  setCanvasTabPinned,
  useTabs,
} from '../lib/desktop'
import { chordHint } from '../lib/actions/chords'
import { hasInsetTrafficLights, isDesktopShell } from '../lib/shell'
import type { CanvasTab } from '../lib/desktop'
import { useT } from '../lib/i18n'

/**
 * Tab strip, desktop shell only. It sits where the title bar
 * would be (the shell's title bar is an overlay: just the traffic lights,
 * floating over this strip) — so the strip doubles as the window's drag
 * handle via data-tauri-drag-region, which Tauri only honours on the exact
 * element carrying the attribute, leaving the tabs themselves clickable.
 */
export function DesktopTabs({ path }: { path: string }) {
  const t = useT()
  const tabs = useTabs((s) => s.tabs)
  const activeId = path.match(/^\/c\/([^/]+)/)?.[1] ?? null
  const strip = useRef<HTMLDivElement>(null)

  /* deep links and back/forward can land on a canvas the strip never opened */
  useEffect(() => {
    if (activeId) ensureTab(activeId)
  }, [activeId])

  useEffect(() => {
    const list = strip.current
    const active = list?.querySelector('[aria-selected="true"]')
    if (!list || !active) return
    const visible = list.getBoundingClientRect()
    const selected = active.getBoundingClientRect()
    if (selected.left < visible.left) list.scrollLeft += selected.left - visible.left
    else if (selected.right > visible.right) list.scrollLeft += selected.right - visible.right
  }, [activeId, tabs])

  if (!isDesktopShell()) return null

  async function newCanvas() {
    const canvas = await api.createCanvas('Untitled canvas')
    posthog.capture('canvas_created')
    openCanvasTab(canvas.id, canvas.name)
  }

  function moveTabFocus(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target
    if (!(target instanceof HTMLButtonElement) || target.getAttribute('role') !== 'tab') return
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      const rect = target.getBoundingClientRect()
      target.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }),
      )
      return
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
    const current = buttons.indexOf(target)
    if (current < 0) return
    event.preventDefault()
    if (event.key === 'Home') buttons[0]?.focus()
    else if (event.key === 'End') buttons.at(-1)?.focus()
    else {
      const step = event.key === 'ArrowRight' ? 1 : -1
      buttons[(current + step + buttons.length) % buttons.length]?.focus()
    }
  }

  return (
    <div
      data-tauri-drag-region
      className="fixed inset-x-0 top-0 z-[800] flex h-[38px] items-center gap-1 border-b border-line bg-paper-deep px-2 pt-[3px]"
    >
      {hasInsetTrafficLights() && <div data-tauri-drag-region className="w-[70px] flex-none" />}
      <Tooltip label={withShortcut(t('canvas.tabHome'), 0)} side="bottom" className="z-[825]">
        <button
          type="button"
          className={cn(
            'grid size-[30px] flex-none place-items-center rounded-md text-ink-soft hover:bg-ink/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            path === '/' && 'bg-ink/[0.08] text-ink',
          )}
          aria-label={t('canvas.tabHome')}
          aria-current={path === '/' ? 'page' : undefined}
          onClick={() => (path !== '/' || location.search) && navigate('/')}
        >
          <HomeIcon />
        </button>
      </Tooltip>
      <div
        ref={strip}
        role="tablist"
        aria-label={t('canvas.openCanvases')}
        className="flex min-w-0 items-center gap-[3px] overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onKeyDown={moveTabFocus}
      >
        {tabs.map((tab, index) => {
          const on = tab.id === activeId
          const pinned = tab.pinned === true
          return (
            <ContextMenu key={tab.id}>
              <ContextMenuTrigger asChild>
                <div
                  className={cn(
                    'group relative h-[30px]',
                    pinned ? 'w-[30px] flex-none' : 'min-w-[112px] max-w-[205px] flex-1 basis-[205px]',
                  )}
                  onAuxClick={(e) => e.button === 1 && closeTab(tab.id, path)}
                >
                  <Tooltip label={withShortcut(tab.name, index + 1)} side="bottom" className="z-[825]">
                    <button
                      id={`desktop-canvas-tab-${tab.id}`}
                      role="tab"
                      type="button"
                      aria-label={tab.name}
                      aria-selected={on}
                      tabIndex={on || (!activeId && index === 0) ? 0 : -1}
                      onClick={() => path !== `/c/${tab.id}` && navigate(canvasTabTarget(tab))}
                      className={cn(
                        'relative flex size-full items-center gap-1.5 rounded-md border border-transparent text-[12.5px] text-ink-soft hover:bg-ink/[0.05] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        pinned ? 'justify-center' : 'px-2 pr-7',
                        on &&
                          'border-line bg-surface text-ink after:absolute after:inset-x-[7px] after:bottom-0 after:border-b-2 after:border-brand',
                      )}
                    >
                      <FrameIcon size="rail" className="shrink-0" />
                      {!pinned && <span className="min-w-0 truncate">{tab.name}</span>}
                    </button>
                  </Tooltip>
                  {!pinned && (
                    <button
                      type="button"
                      tabIndex={on ? 0 : -1}
                      className={cn(
                        'absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-[5px] p-0 text-ink-faint opacity-0 hover:bg-ink/[0.08] hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover:opacity-100',
                        on && 'opacity-100',
                      )}
                      onClick={() => closeTab(tab.id, path)}
                      aria-label={t('canvas.closeTab')}
                      title={t('canvas.closeTab')}
                    >
                      <XIcon className="size-3" />
                    </button>
                  )}
                </div>
              </ContextMenuTrigger>
              <TabContextMenu tab={tab} path={path} />
            </ContextMenu>
          )
        })}
      </div>
      <button
        type="button"
        className="grid size-[30px] flex-none place-items-center rounded-md text-ink-soft hover:bg-ink/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={newCanvas}
        aria-label={t('canvas.newCanvas')}
        title={t('canvas.newCanvas')}
      >
        <PlusIcon size="rail" />
      </button>
    </div>
  )
}

/** A tooltip with its ⌘1…⌘9 shortcut, when the slot has one. */
function withShortcut(label: string, slot: number): string {
  const chord = TAB_SHORTCUTS[slot]
  return chord ? `${label} (${chordHint(chord)})` : label
}

/** Right-click menu is portalled to the body, so it needs to clear the
 *  strip's own z-index to overlap it. */
function TabContextMenu({ tab, path }: { tab: CanvasTab; path: string }) {
  const t = useT()
  const url = new URL(canvasTabTarget(tab), location.origin).href
  const on = path === `/c/${tab.id}`
  const Icon = tab.pinned ? UnpinIcon : PinIcon
  return (
    <ContextMenuContent className="z-[850]">
      <ContextMenuItem onSelect={() => setCanvasTabPinned(tab.id, !tab.pinned)}>
        <Icon size="rail" />
        {t(tab.pinned ? 'canvas.unpinTab' : 'canvas.pinTab')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => navigator.clipboard.writeText(url)}>{t('canvas.copyLink')}</ContextMenuItem>
      {/* a full load of that canvas: the tab's own page when it's current,
          otherwise a hard navigation there (tabs are in-page routes, so
          there is nothing else to refresh) */}
      <ContextMenuItem onSelect={() => (on ? location.reload() : location.assign(url))}>
        {t('canvas.reload')}
      </ContextMenuItem>
      {/* the shell's opener IPC hands the URL to the system browser; without
          it (a plain browser, or a pre-0.1.2 shell) a new tab is the closest thing */}
      <ContextMenuItem onSelect={() => openExternal(url) || window.open(url, '_blank', 'noopener')}>
        {t('canvas.openInBrowser')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => closeTab(tab.id, path)}>{t('common.close')}</ContextMenuItem>
      <ContextMenuItem onSelect={() => closeOtherTabs(tab.id, path)}>{t('canvas.closeOtherTabs')}</ContextMenuItem>
      <ContextMenuItem onSelect={closeAllTabs}>{t('canvas.closeAllTabs')}</ContextMenuItem>
    </ContextMenuContent>
  )
}

/** Invisible drag handle for shell screens without the tab strip (signed
 *  out): the overlay title bar has no native drag area of its own. */
export function ShellDragBar() {
  if (!hasInsetTrafficLights()) return null
  return <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-[950] h-6" />
}
