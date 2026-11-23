import { ComposerContextChips } from './ContextChip'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@/lib/i18n'
import type { Allowance } from '../lib/api'
import { chatTurns } from '../lib/agentChat'
import { emptyComposerDraft, useStore, type PreviewComposerTarget } from '../lib/store'
import { AgentIcon } from './AgentIcon'
import { sendPrompt } from './sendPrompt'
import { Button } from './ui/button'
import { DotMatrix } from './ui/dot-matrix'
import { IconButton } from './ui/icon-button'
import { ArrowUpIcon, PreviewMinimizeIcon, XIcon } from './ui/icons'
import { Textarea } from './ui/textarea'

const storageKey = (canvasId: string) => `doop.previewChat.${canvasId}`

function readOpen(canvasId: string | undefined) {
  try {
    return !!canvasId && localStorage.getItem(storageKey(canvasId)) === 'open'
  } catch {
    return false
  }
}

export function usePreviewChat(canvasId: string | undefined, canEdit: boolean) {
  const allowed = !!canvasId && canEdit
  const [state, setState] = useState(() => ({ canvasId, open: readOpen(canvasId) }))
  const [focusRequest, requestFocus] = useState<{ target: 'field' | 'pill' }>()
  const open = allowed && (state.canvasId === canvasId ? state.open : readOpen(canvasId))

  function setOpen(value: boolean) {
    if (!canvasId || !allowed) return
    setState({ canvasId, open: value })
    try {
      localStorage.setItem(storageKey(canvasId), value ? 'open' : 'closed')
    } catch {
      // The capsule still works when the browser denies storage.
    }
  }

  function expand(target?: PreviewComposerTarget) {
    if (!allowed || !canvasId) return
    if (target) useStore.getState().setPreviewComposerTarget(canvasId, target)
    setOpen(true)
    requestFocus({ target: 'field' })
  }

  function collapse() {
    if (open) setOpen(false)
  }

  function collapseAndFocus() {
    collapse()
    requestFocus({ target: 'pill' })
  }

  function escape() {
    if (!open || !canvasId) return false
    const focused = document.activeElement
    if (
      focused instanceof HTMLTextAreaElement &&
      focused.matches('[data-preview-chat-field]') &&
      useStore.getState().composerDrafts[canvasId]?.text.trim()
    ) {
      focused.blur()
      return true
    }
    collapseAndFocus()
    return true
  }

  return { allowed, open, focusRequest, expand, collapse, collapseAndFocus, escape }
}

type Chat = ReturnType<typeof usePreviewChat>

export function PreviewChatCapsule({
  chat,
  canvasId,
  pending,
  allowance,
  onShowQueue,
  onOpenChat,
}: {
  chat: Chat
  canvasId: string
  pending: number
  allowance: Allowance | null
  onShowQueue: () => void
  onOpenChat?: () => void
}) {
  const field = useRef<HTMLTextAreaElement>(null)
  const pill = useRef<HTMLButtonElement>(null)
  const hoverTimer = useRef<number>()

  function cancelHover() {
    window.clearTimeout(hoverTimer.current)
    hoverTimer.current = undefined
  }

  useEffect(() => cancelHover, [chat.open])
  useLayoutEffect(() => {
    const target = chat.focusRequest?.target
    if (target === 'field' && chat.open) field.current?.focus({ preventScroll: true })
    if (target === 'pill' && !chat.open) pill.current?.focus({ preventScroll: true })
  }, [chat.focusRequest, chat.open])

  const t = useT()
  const draft = useStore((s) => s.composerDrafts[canvasId] ?? emptyComposerDraft)
  const canSend = !!draft.text.trim() || draft.contexts.length > 0
  const target = useStore((s) => s.previewComposerTargets[canvasId])
  const send = useStore((s) => (s.composerSend?.canvasId === canvasId ? s.composerSend : null))
  const busy = useStore((s) => s.composerSend?.status === 'busy')
  const tasks = useStore((s) => s.tasks)
  const feedback = useStore((s) => s.feedback)
  const reply = useMemo(
    () =>
      chatTurns(tasks, feedback, undefined)
        .reverse()
        .find((turn) => !!turn.reply),
    [tasks, feedback],
  )
  const working = tasks.some((task) => task.agentName && !task.endedAt && !task.failedAt)
  const hint = t('panels.previewChatAsk')
  const placeholder = t('panels.previewChatPlaceholder')
  const openLabel = t('panels.previewChatOpen')
  const collapseLabel = t('panels.previewChatCollapse')
  const badge = t('panels.previewChatPending', { count: pending })
  const sendLabel = t('panels.promptSend')

  async function submit() {
    if (!canSend || busy) return
    await sendPrompt({ canvasId, text: draft.text.trim(), scope: target?.scope, allowance })
  }

  return (
    <div
      data-preview-chat=""
      data-chat-state={chat.open ? 'expanded' : 'collapsed'}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-[7] flex justify-center px-2"
    >
      {chat.open ? (
        <section
          aria-label={hint}
          className="dark pointer-events-auto mb-2 w-full max-w-[560px] rounded-panel border border-line bg-surface p-2.5 text-ink shadow-pop motion-safe:animate-[preview-chat-in_150ms_ease-out]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-caption font-semibold">
              <AgentIcon name={reply?.agentName || 'Doop'} size={14} />
              <span className="truncate">{reply?.agentName || 'Doop'}</span>
              {working && <Working />}
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
              {pending > 0 && <PendingBadge label={badge} onClick={onShowQueue} />}
              {onOpenChat && (
                <Button variant="bare" size="pill" aria-label={openLabel} title={openLabel} onClick={onOpenChat}>
                  {openLabel}
                </Button>
              )}
              <IconButton size="sm" aria-label={collapseLabel} onClick={chat.collapseAndFocus}>
                <PreviewMinimizeIcon size="rail" />
              </IconButton>
            </div>
          </div>
          {reply?.reply && (
            <p
              data-preview-chat-reply=""
              className="mb-1.5 mt-1 line-clamp-3 overflow-hidden whitespace-pre-wrap break-words text-caption text-ink-soft"
            >
              {reply.reply}
            </p>
          )}
          <ComposerContextChips canvasId={canvasId} draft={draft} busy={busy} />
          {!draft.contexts.length && target?.scope && (
            <div
              className="my-1 flex w-fit max-w-full items-center gap-0.5 rounded-row bg-brand/10 pl-2 text-caption font-medium text-brand"
              data-preview-chat-scope=""
            >
              <span className="truncate" title={target.label ?? target.scope.selector}>
                {target.label ?? target.scope.selector}
              </span>
              <IconButton
                size="sm"
                aria-label={t('panels.promptRemoveElementScope')}
                disabled={busy}
                onClick={() => useStore.getState().setPreviewComposerTarget(canvasId, undefined)}
              >
                <XIcon size="rail" />
              </IconButton>
            </div>
          )}
          <form
            className="mt-1 flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <Textarea
              ref={field}
              data-preview-chat-field=""
              className="max-h-32 min-h-14 resize-y"
              rows={2}
              placeholder={placeholder}
              aria-label={hint}
              value={draft.text}
              onChange={(event) => useStore.getState().setComposerDraft(canvasId, event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
                event.preventDefault()
                if (!event.repeat) void submit()
              }}
              onKeyUp={(event) => event.stopPropagation()}
            />
            <IconButton
              type="submit"
              size="lg"
              variant="primary"
              disabled={!canSend || busy}
              aria-label={sendLabel}
              title={t('panels.promptSendTooltip')}
            >
              {send?.status === 'busy' ? <DotMatrix /> : <ArrowUpIcon size="rail" />}
            </IconButton>
          </form>
          {send && (
            <p
              role={send.status === 'error' ? 'alert' : 'status'}
              data-preview-chat-send={send.status}
              className={
                send.status === 'error'
                  ? 'mt-1.5 break-words text-caption text-accent-ink'
                  : 'mt-1.5 text-caption text-ink-soft'
              }
            >
              {send.status === 'error'
                ? send.message
                : t(send.status === 'busy' ? 'panels.previewChatSending' : 'panels.promptSent')}
            </p>
          )}
        </section>
      ) : (
        <div className="relative flex h-4 shrink-0 items-center">
          <Button
            ref={pill}
            data-preview-chat-handle=""
            variant="bare"
            size="pill"
            className="pointer-events-auto h-4 w-20 p-0 hover:bg-transparent"
            aria-label={hint}
            title={t('panels.previewChatShortcut')}
            aria-expanded={false}
            onPointerMove={(event) => {
              if (event.pointerType !== 'mouse' || hoverTimer.current !== undefined) return
              hoverTimer.current = window.setTimeout(() => {
                hoverTimer.current = undefined
                chat.expand()
              }, 140)
            }}
            onPointerLeave={cancelHover}
            onClick={() => {
              cancelHover()
              chat.expand()
            }}
          >
            <span aria-hidden="true" className="h-[5px] w-[70px] rounded-pill bg-ink-faint ring-1 ring-surface/70" />
          </Button>
          {(pending > 0 || working) && (
            <div className="absolute left-full ml-1 flex items-center gap-1">
              {pending > 0 && <PendingBadge label={badge} count={pending} onClick={onShowQueue} />}
              {working && <Working />}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PendingBadge({ label, count, onClick }: { label: string; count?: number; onClick: () => void }) {
  return (
    <Button
      data-preview-chat-pending=""
      variant="bare"
      size="pill"
      className={
        count === undefined
          ? 'bg-brand/10 text-brand hover:bg-brand/15 hover:text-brand'
          : 'pointer-events-auto h-4 min-w-4 bg-brand px-1 text-micro text-white hover:bg-brand/90 hover:text-white'
      }
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {count ?? label}
    </Button>
  )
}

function Working() {
  const t = useT()
  const label = t('panels.previewChatWorking')
  return (
    <span role="status" aria-label={label} title={label}>
      <DotMatrix />
    </span>
  )
}
