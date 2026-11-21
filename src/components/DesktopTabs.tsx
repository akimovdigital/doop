import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api } from '../lib/api'
import { posthog } from '../lib/posthog'
import { navigate } from '../App'
import { ChevronRightIcon, FrameIcon, HomeIcon, PlusIcon, XIcon } from './ui/icons'
import { Tooltip } from './ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from './ui/context-menu'
import { MenuHint } from './ui/menu'
import { Input } from './ui/input'
import { Button } from './ui/button'
import { Modal, ModalActions, ModalTitle } from './ui/modal'
import { cn } from '@/lib/utils'
import {
  COPY_TAB_LINK_SHORTCUT,
  TAB_SHORTCUTS,
  canvasTabTarget,
  closeAllTabs,
  closeCanvasSplit,
  closeOtherTabs,
  closeTab,
  copyCanvasTabLink,
  ensureTab,
  groupCanvasTab,
  moveCanvasTabToWindow,
  openCanvasSplit,
  openCanvasTab,
  openExternal,
  renameCanvasTab,
  renameCanvasTabGroup,
  setCanvasTabPinned,
  supportsCanvasWindows,
  useTabs,
  type CanvasTab,
} from '../lib/desktop'
import { chordHint } from '../lib/actions/chords'
import { hasInsetTrafficLights, isDesktopShell } from '../lib/shell'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { useT } from '../lib/i18n'

const stripButton =
  'grid h-full w-[38px] flex-none place-items-center border-r border-line-soft text-ink-soft hover:bg-sub hover:text-ink focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
const tabMenu = 'z-[850] min-w-[220px] rounded-[12px] border border-line bg-surface'

type GroupEdit = { tabId: string; previous?: string }

function openTabMenu(tab: HTMLElement) {
  const { left, bottom } = tab.getBoundingClientRect()
  tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: left, clientY: bottom }))
}

/** The strip itself doubles as the drag handle. Tauri only honours
 *  data-tauri-drag-region on the exact element carrying the attribute. */
export function DesktopTabs({ path }: { path: string }) {
  const t = useT()
  const tabs = useTabs((s) => s.tabs)
  const split = useTabs((s) => s.split)
  const activeId = path.match(/^\/c\/([^/]+)/)?.[1] ?? null
  const readOnlyId = useStore((s) => (s.canvas && !canEditOpenCanvas(s) ? s.canvas.id : null))
  const strip = useRef<HTMLDivElement>(null)
  const [renaming, setRenaming] = useState<CanvasTab | null>(null)
  const [groupEdit, setGroupEdit] = useState<GroupEdit | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const groups = [...new Set(tabs.flatMap((tab) => (tab.group ? [tab.group] : [])))]

  /* Deep links and back/forward can land on a canvas the strip never opened. */
  useEffect(() => {
    if (activeId) ensureTab(activeId)
  }, [activeId])

  useEffect(() => {
    const list = strip.current
    const selected = list?.querySelector('[aria-selected="true"]')
    if (!list || !selected) return
    const visible = list.getBoundingClientRect()
    const rect = selected.getBoundingClientRect()
    if (rect.left < visible.left) list.scrollLeft += rect.left - visible.left
    else if (rect.right > visible.right) list.scrollLeft += rect.right - visible.right
  }, [activeId, tabs])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 3500)
    return () => window.clearTimeout(timer)
  }, [notice])

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
      openTabMenu(target)
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
      className="fixed inset-x-0 top-0 z-[800] flex h-[38px] border-b border-line bg-paper-deep"
    >
      {hasInsetTrafficLights() && (
        <div data-tauri-drag-region className="w-[76px] flex-none border-r border-line-soft" />
      )}
      <Tooltip label={withShortcut(t('canvas.tabHome'), 0)} side="bottom" className="z-[825]">
        <button
          type="button"
          className={cn(stripButton, path === '/' && 'bg-surface text-ink')}
          aria-label={t('canvas.tabHome')}
          aria-current={path === '/' ? 'page' : undefined}
          onClick={() => (path !== '/' || location.search) && navigate('/')}
        >
          <HomeIcon size="rail" />
        </button>
      </Tooltip>
      <div
        ref={strip}
        role="tablist"
        aria-label={t('canvas.openCanvases')}
        className="flex h-full min-w-0 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onKeyDown={moveTabFocus}
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === activeId
          const editing = renaming?.id === tab.id
          const compact = tab.pinned && !editing
          const companion =
            tabs.find((item) => item.id === activeId && item.id !== tab.id) ?? tabs[index + 1] ?? tabs[index - 1]
          const menuOpenToEditor = () => setRenaming(tab)
          return (
            <Fragment key={tab.id}>
              {tab.group && tab.group !== tabs[index - 1]?.group && (
                <div className="flex h-full shrink-0 items-center border-r border-line-soft bg-sub px-2.5 text-[11px] font-medium text-ink-soft">
                  <span className="max-w-[100px] truncate" title={tab.group}>
                    {tab.group}
                  </span>
                </div>
              )}
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div
                    className={cn(
                      'group relative h-full border-r border-line-soft',
                      compact ? 'w-[37px] flex-none' : 'w-max min-w-[128px] max-w-[220px] flex-none',
                    )}
                    onAuxClick={(e) => e.button === 1 && closeTab(tab.id, path)}
                    onContextMenu={(event) => {
                      if (!event.nativeEvent.isTrusted) return
                      event.preventDefault()
                      openTabMenu(event.currentTarget)
                    }}
                  >
                    <Tooltip label={withShortcut(tab.name, index + 1)} side="bottom" className="z-[825]">
                      <button
                        id={`desktop-canvas-tab-${tab.id}`}
                        role="tab"
                        type="button"
                        aria-label={tab.name}
                        aria-selected={selected}
                        aria-haspopup="menu"
                        aria-controls={selected ? 'desktop-canvas-content' : undefined}
                        tabIndex={selected || (!activeId && index === 0) ? 0 : -1}
                        onClick={() => path !== `/c/${tab.id}` && navigate(canvasTabTarget(tab))}
                        onDoubleClick={() => tab.id !== readOnlyId && menuOpenToEditor()}
                        className={cn(
                          'relative flex size-full items-center gap-2 text-[12.5px] text-ink-soft hover:bg-sub focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                          'aria-selected:bg-surface aria-selected:text-ink aria-selected:after:absolute aria-selected:after:bottom-[2px] aria-selected:after:left-1/2 aria-selected:after:w-9 aria-selected:after:-translate-x-1/2 aria-selected:after:rounded-full aria-selected:after:border-b-2 aria-selected:after:border-brand',
                          compact ? 'justify-center aria-selected:after:w-4' : 'px-3 pr-8',
                        )}
                      >
                        <FrameIcon size="rail" className={cn('shrink-0', selected && 'text-brand')} />
                        {!compact && <span className="min-w-0 truncate">{tab.name}</span>}
                      </button>
                    </Tooltip>
                    {!compact && !editing && (
                      <button
                        type="button"
                        tabIndex={selected ? 0 : -1}
                        className={cn(
                          'absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-[4px] text-ink-faint opacity-0 hover:bg-sub hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover:opacity-100',
                          selected && 'opacity-100',
                        )}
                        onClick={() => closeTab(tab.id, path)}
                        aria-label={t('canvas.closeTab')}
                        title={t('canvas.closeTab')}
                      >
                        <XIcon className="size-3" />
                      </button>
                    )}
                    {editing && (
                      <TabNameField
                        tab={tab}
                        onDone={() => setRenaming(null)}
                        onError={() => setNotice(t('canvas.tabRenameFailed'))}
                      />
                    )}
                  </div>
                </ContextMenuTrigger>
                <TabContextMenu
                  tab={tab}
                  path={path}
                  groups={groups}
                  canRename={tab.id !== readOnlyId}
                  companion={companion?.id === tab.id ? undefined : companion}
                  onRename={menuOpenToEditor}
                  onGroupEdit={setGroupEdit}
                  onNotice={setNotice}
                />
              </ContextMenu>
            </Fragment>
          )
        })}
      </div>
      <button
        type="button"
        className={stripButton}
        onClick={newCanvas}
        aria-label={t('canvas.newCanvas')}
        title={t('canvas.newCanvas')}
      >
        <PlusIcon size="rail" />
      </button>
      {split && split[0] === activeId && (
        <button
          type="button"
          className={stripButton}
          onClick={closeCanvasSplit}
          aria-label={t('canvas.closeSplit')}
          title={t('canvas.closeSplit')}
        >
          <XIcon size="rail" />
        </button>
      )}
      {notice && (
        <div
          className="pointer-events-none absolute top-full right-2 mt-2 rounded-control border border-line bg-surface px-3 py-2 text-[12px] text-ink shadow-pop"
          role="status"
        >
          {notice}
        </div>
      )}
      {groupEdit && <GroupNameDialog edit={groupEdit} onClose={() => setGroupEdit(null)} />}
    </div>
  )
}

function withShortcut(label: string, slot: number): string {
  const chord = TAB_SHORTCUTS[slot]
  return chord ? `${label} (${chordHint(chord)})` : label
}

function TabNameField({ tab, onDone, onError }: { tab: CanvasTab; onDone: () => void; onError: () => void }) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  function finish() {
    onDone()
    document.getElementById(`desktop-canvas-tab-${tab.id}`)?.focus({ preventScroll: true })
  }

  async function submit() {
    if (pending.current) return
    const name = input.current?.value.trim()
    if (!name || name === tab.name) return finish()
    pending.current = true
    setBusy(true)
    try {
      await renameCanvasTab(tab.id, name)
      finish()
    } catch {
      onError()
      pending.current = false
      setBusy(false)
      input.current?.focus()
    }
  }

  return (
    <form
      className="absolute inset-x-1.5 top-1/2 -translate-y-1/2"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <Input
        ref={input}
        defaultValue={tab.name}
        aria-label={t('canvas.renameFile')}
        aria-busy={busy}
        readOnly={busy}
        inputSize="auto"
        className="h-7 px-2 text-[12.5px]"
        onBlur={() => {
          if (!pending.current) onDone()
        }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape' && !pending.current) {
            event.preventDefault()
            finish()
          }
        }}
      />
    </form>
  )
}

function GroupNameDialog({ edit, onClose }: { edit: GroupEdit; onClose: () => void }) {
  const t = useT()
  const [name, setName] = useState(edit.previous ?? '')
  const title = t(edit.previous ? 'canvas.renameTabGroup' : 'canvas.newTabGroup')
  return (
    <Modal onClose={onClose} aria-describedby={undefined}>
      <ModalTitle>{title}</ModalTitle>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const group = name.trim()
          if (!group) return
          if (edit.previous) renameCanvasTabGroup(edit.previous, group)
          else groupCanvasTab(edit.tabId, group)
          onClose()
        }}
      >
        <Input
          aria-label={t('canvas.tabGroupName')}
          value={name}
          maxLength={48}
          onChange={(e) => setName(e.target.value)}
          className="mt-3"
        />
        <ModalActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!name.trim()}>
            {t('common.save')}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  )
}

function TabContextMenu({
  tab,
  path,
  groups,
  canRename,
  companion,
  onRename,
  onGroupEdit,
  onNotice,
}: {
  tab: CanvasTab
  path: string
  groups: string[]
  canRename: boolean
  companion?: CanvasTab
  onRename: () => void
  onGroupEdit: (edit: GroupEdit) => void
  onNotice: (text: string) => void
}) {
  const t = useT()
  const afterClose = useRef<(() => void) | null>(null)
  const url = new URL(canvasTabTarget(tab), location.origin).href
  const current = path === `/c/${tab.id}`

  function handOffFocus(action: () => void) {
    afterClose.current = action
  }

  return (
    <ContextMenuContent
      aria-label={t('canvas.tabActions', { name: tab.name })}
      className={tabMenu}
      onCloseAutoFocus={(event) => {
        const action = afterClose.current
        afterClose.current = null
        if (!action) return
        // The menu traps focus until its content unmounts.
        event.preventDefault()
        action()
      }}
    >
      <ContextMenuItem onSelect={() => setCanvasTabPinned(tab.id, !tab.pinned)}>
        {t(tab.pinned ? 'canvas.unpinTab' : 'canvas.pinTab')}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() =>
          void copyCanvasTabLink(tab).then(
            () => onNotice(t('canvas.linkCopied')),
            () => onNotice(t('canvas.tabCopyFailed')),
          )
        }
      >
        {t('canvas.copyLink')}
        <MenuHint aria-hidden="true">{chordHint(COPY_TAB_LINK_SHORTCUT)}</MenuHint>
      </ContextMenuItem>
      <ContextMenuItem disabled={!canRename} onSelect={() => handOffFocus(onRename)}>
        {t('canvas.renameFile')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => (current ? location.reload() : location.assign(url))}>
        {t('canvas.reload')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          {t('canvas.addToTabGroup')}
          <ChevronRightIcon size="rail" className="ml-auto" aria-hidden="true" />
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="border border-line">
          <ContextMenuItem onSelect={() => handOffFocus(() => onGroupEdit({ tabId: tab.id }))}>
            {t('canvas.newTabGroup')}
          </ContextMenuItem>
          {groups
            .filter((group) => group !== tab.group)
            .map((group) => (
              <ContextMenuItem key={group} onSelect={() => groupCanvasTab(tab.id, group)}>
                {group}
              </ContextMenuItem>
            ))}
          {tab.group && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => handOffFocus(() => onGroupEdit({ tabId: tab.id, previous: tab.group }))}>
                {t('canvas.renameTabGroup')}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => groupCanvasTab(tab.id)}>
                {t('canvas.removeFromTabGroup')}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem
        disabled={!supportsCanvasWindows()}
        onSelect={() => void moveCanvasTabToWindow(tab).catch(() => onNotice(t('canvas.tabWindowFailed')))}
      >
        {t('canvas.moveToNewWindow')}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!companion}
        onSelect={() => {
          if (companion) openCanvasSplit(current ? tab : companion, current ? companion : tab)
        }}
      >
        {t('canvas.openInSplitTab')}
      </ContextMenuItem>
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

export function DesktopSplit({ tabs }: { tabs: [CanvasTab, CanvasTab] }) {
  return (
    <div className="grid h-full min-h-0 grid-cols-2 gap-px bg-line">
      {tabs.map((tab) => (
        <section key={tab.id} className="flex min-w-0 flex-col bg-paper" aria-label={tab.name}>
          <div className="truncate border-b border-line px-3 py-1.5 text-[12px] font-medium text-ink-soft">
            {tab.name}
          </div>
          <iframe title={tab.name} src={canvasTabTarget(tab)} className="min-h-0 w-full flex-1 border-0" />
        </section>
      ))}
    </div>
  )
}

/** Invisible drag handle for shell screens without the tab strip. */
export function ShellDragBar() {
  if (!hasInsetTrafficLights()) return null
  return <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-[950] h-6" />
}
