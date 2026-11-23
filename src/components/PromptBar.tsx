import { MAX_PROMPT_ATTACHMENTS } from '../lib/designCrop'
import { ComposerContextChips } from './ContextChip'
import { sendPrompt } from './sendPrompt'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { emptyComposerDraft, useStore } from '../lib/store'
import { meterText, useAllowance } from './TeamAllowance'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Note } from './ui/note'
import { Tooltip } from './ui/tooltip'
import { DoopMark } from './Logo'
import { ArrowUpIcon, AttachmentIcon, BookOpenIcon, FrameIcon, XIcon } from './ui/icons'
import { ModelPicker } from './ModelPicker'
import { useSkillMenu } from './SkillMenu'
import { useRunnerPick } from '../lib/runnerPick'
import { resolveRunnerPick } from '../../shared/agentRunner'
import { LayerKindIcon } from './LayerKindIcon'
import { buildLayerTree, findLayer, layerName } from '../lib/layers'
import type { CardScope } from '../../shared/types'
import type { LayerKind } from '../lib/layers'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * The canvas's front door to the resident team: the prompt composer
 * docked to the bottom of the Agents tab. It queues a board card without
 * anyone having to discover the board first; the tasks it starts show up in
 * the list above it.
 *
 * Screenshots and images attach via the paperclip (or a paste into the
 * field); on send they land on the canvas as reference frames and the card
 * carries their ids so the agent looks at them before designing.
 */

/** the scope chip's label is cut here so a long text node never eats the row */
const MAX_SCOPE_LABEL = 24
/** the field grows with the draft up to this many lines, then scrolls */
const MAX_COMPOSER_LINES = 6
/** a ⌘/ older than this is ignored by a composer that mounts later */
const FOCUS_REQUEST_TTL_MS = 2000

interface ScopeChip {
  scope: CardScope
  /** what the chip reads: an element's "aside.rail", a frame's name */
  label: string
  kind: LayerKind | 'frame'
}

function clip(text: string): string {
  return text.length > MAX_SCOPE_LABEL ? `${text.slice(0, MAX_SCOPE_LABEL - 1).trimEnd()}…` : text
}

/** "frame:element" for an element scope, the frame id alone for a frame one */
function scopeKey(scope: CardScope): string {
  return scope.selector ? `${scope.frameId}:${scope.selector}` : scope.frameId
}

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024 // mirrors the server's asset cap

/** Size the field to its draft, up to MAX_COMPOSER_LINES. */
function autosize(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto'
  if (!ta.scrollHeight) return // not laid out (hidden, or a DOM without layout)
  const line = parseFloat(getComputedStyle(ta).lineHeight) || 20
  ta.style.height = `${Math.min(ta.scrollHeight, Math.round(line * MAX_COMPOSER_LINES))}px`
}

interface Attachment {
  file: File
  /** object URL for the thumbnail, revoked on removal/submit */
  preview: string
}

export function PromptBar({ canvasId }: { canvasId: string }) {
  const frames = useStore((s) => s.canvas?.frames)
  const selectedId = useStore((s) => s.selectedId)
  const selectedElement = useStore((s) => s.selectedElement)
  const focusAt = useStore((s) => s.composerFocusAt)
  const draft = useStore((s) => s.composerDrafts[canvasId] ?? emptyComposerDraft)
  const { text, contexts } = draft
  const canSend = !!text.trim() || contexts.length > 0
  const setDraft = useStore((s) => s.setComposerDraft)
  /* this canvas's send only: another canvas's outcome is not ours to show */
  const send = useStore((s) => (s.composerSend?.canvasId === canvasId ? s.composerSend : null))
  const busy = send?.status === 'busy'
  const sent = send?.status === 'sent'
  const sendError = send?.status === 'error' ? send.message : null
  const { allowance } = useAllowance()
  /* the meter names the connection the next task goes to: the composer's pick */
  const runnerStore = useRunnerPick()
  const picked = resolveRunnerPick(runnerStore.runners, runnerStore.stored)
  const pickedProvider = picked?.pick.provider
  /* the selection is the prompt's scope until the chip is dismissed — × or
     Esc drops it entirely, no stepping up to the frame. Keyed on the scope
     so a new selection brings the chip back. */
  const [dismissed, setDismissed] = useState<string | null>(null)
  const chip = useMemo<ScopeChip | null>(() => {
    const frame = frames?.find((f) => f.id === (selectedElement?.frameId ?? selectedId))
    if (!frame) return null
    const scope: CardScope = selectedElement
      ? { frameId: frame.id, selector: selectedElement.selector }
      : { frameId: frame.id }
    if (dismissed === scopeKey(scope)) return null
    if (!selectedElement) return { scope, label: frame.name, kind: 'frame' }
    const node = findLayer(buildLayerTree(frame.html), selectedElement.selector)
    return {
      scope,
      label: node ? layerName(node) : (selectedElement.selector.split(' > ').at(-1) ?? ''),
      kind: node?.kind ?? 'box',
    }
  }, [frames, selectedId, selectedElement, dismissed])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  /* attachment slips (too big, too many) — local and brief, unlike a failed
     send, which the store keeps until the draft changes */
  const [attachError, setAttachError] = useState<string | null>(null)
  /* an image file is being dragged over the composer */
  const [dropping, setDropping] = useState(false)
  const error = attachError ?? sendError
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const skillMenu = useSkillMenu({
    from: { canvasId },
    text,
    setText: (value) => setDraft(canvasId, value),
    inputRef,
    /* the store keeps the draft per canvas, so leaving to add a skill loses nothing */
    offerNew: true,
  })
  const t = useT()
  const meter = meterText(allowance, t, pickedProvider, picked?.runner.name)

  useLayoutEffect(() => {
    if (inputRef.current) autosize(inputRef.current)
  }, [text])

  /* ⌘/: the page has opened the panel on this tab — take the keyboard. The
     request is a timestamp so a composer mounted later (a tab switch some
     minutes on) does not re-run an old one. */
  useEffect(() => {
    if (focusAt && Date.now() - focusAt < FOCUS_REQUEST_TTL_MS) inputRef.current?.focus()
  }, [focusAt])

  /* previews are object URLs — release whatever is still held on unmount
     (via a ref: an empty-deps cleanup would close over the first render) */
  const attachmentsRef = useRef(attachments)
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])
  useEffect(() => () => attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.preview)), [])

  function showError(msg: string) {
    setAttachError(msg)
    window.setTimeout(() => setAttachError(null), 5000)
  }

  function addFiles(list: Iterable<File>) {
    const images = [...list].filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    const oversize = images.find((f) => f.size > MAX_ATTACHMENT_BYTES)
    const fitting = images.filter((f) => f.size <= MAX_ATTACHMENT_BYTES)
    const room = MAX_PROMPT_ATTACHMENTS - attachments.length
    if (oversize) showError(t('panels.promptTooBig', { name: oversize.name }))
    else if (fitting.length > room) showError(t('panels.promptTooMany', { count: MAX_PROMPT_ATTACHMENTS }))
    const ok = fitting.slice(0, Math.max(0, room))
    if (ok.length)
      setAttachments((cur) => [...cur, ...ok.map((file) => ({ file, preview: URL.createObjectURL(file) }))])
  }

  function removeAttachment(preview: string) {
    URL.revokeObjectURL(preview)
    setAttachments((cur) => cur.filter((a) => a.preview !== preview))
  }

  async function submit(prompt: string) {
    const clean = prompt.trim()
    if ((!clean && !contexts.length) || busy) return
    const files = attachments.map((a) => a.file)
    await sendPrompt({ canvasId, text: clean, files, scope: chip?.scope, allowance })
    /* the thumbnails go once the card is queued: the files were handed to
       the upload, and a failure keeps the text and the previews for a retry */
    const remaining = useStore.getState().composerDrafts[canvasId]
    if (!remaining?.text && !remaining?.contexts.length) {
      attachments.forEach((a) => URL.revokeObjectURL(a.preview))
      setAttachments([])
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (skillMenu.onKeyDown(e)) return
    if (e.key === 'Escape' && chip) {
      e.preventDefault()
      setDismissed(scopeKey(chip.scope))
      return
    }
    /* Enter sends, ⇧Enter breaks the line; an Enter that commits an IME
       composition is neither */
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit(text)
    }
  }

  /* dropped images attach like pasted ones; claiming the drag keeps the
     canvas, which listens on the window, from turning it into frames */
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = busy ? 'none' : 'copy'
    setDropping(!busy)
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDropping(false)
    if (!busy) addFiles(e.dataTransfer.files)
  }

  return (
    <div
      className={cn(
        'flex shrink-0 flex-col gap-1.5 border-t border-line-soft bg-surface px-3 pt-2.5 pb-2',
        dropping && 'bg-paper-deep',
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <ComposerContextChips canvasId={canvasId} draft={draft} busy={busy} />
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <div key={a.preview} className="relative h-11 w-11 overflow-hidden rounded-[7px] bg-paper shadow-ring">
              <img src={a.preview} alt={a.file.name} className="block h-full w-full object-cover" />
              <Button
                variant="bare"
                className="absolute right-0.5 top-0.5 size-4 justify-center rounded-full bg-black/55 p-0 text-xs leading-none text-white hover:bg-black/70 hover:text-white"
                aria-label={t('panels.promptRemoveAttachment', { name: a.file.name })}
                disabled={busy}
                onClick={() => removeAttachment(a.preview)}
              >
                <XIcon size={10} />
              </Button>
            </div>
          ))}
        </div>
      )}
      <form
        className="relative rounded-[10px]"
        onSubmit={(e) => {
          e.preventDefault()
          void submit(text)
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files ?? [])
            e.target.value = '' // same file can be re-picked after removal
          }}
        />
        {chip && (
          <div className="mb-2 flex">
            <span
              className="flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-[6px] pr-1 pl-2 text-[12px] text-ink-soft shadow-ring"
              title={
                chip.kind === 'frame'
                  ? t('panels.promptScopedFrame', { name: chip.label })
                  : t('panels.promptScopedElement', { name: chip.label || t('panels.promptElement') })
              }
            >
              <span className="flex-none text-ink-faint">
                {chip.kind === 'frame' ? <FrameIcon className="size-3.5" /> : <LayerKindIcon kind={chip.kind} />}
              </span>
              <span className="min-w-0 truncate">{clip(chip.label || t('panels.promptElement'))}</span>
              <Button
                variant="bare"
                className="size-4 flex-none justify-center rounded-full p-0 text-ink-faint hover:bg-paper-deep hover:text-ink"
                aria-label={
                  chip.kind === 'frame' ? t('panels.promptRemoveFrameScope') : t('panels.promptRemoveElementScope')
                }
                disabled={busy}
                onClick={() => setDismissed(scopeKey(chip.scope))}
              >
                <XIcon className="size-3" aria-hidden />
              </Button>
            </span>
          </div>
        )}
        {skillMenu.menu}
        <Textarea
          ref={inputRef}
          variant="bare"
          rows={1}
          aria-label={t('panels.promptAria')}
          className="block overflow-y-auto px-0.5 text-[12.5px] leading-[1.45] placeholder:text-ink-ghost md:text-[12.5px]"
          value={text}
          disabled={busy}
          placeholder={
            chip
              ? chip.kind === 'frame'
                ? t('panels.promptPlaceholderFrame')
                : t('panels.promptPlaceholderElement')
              : t('panels.promptPlaceholder')
          }
          {...skillMenu.inputProps}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
            if (images.length) {
              e.preventDefault()
              addFiles(images)
            }
          }}
        />
        <div className="mt-2 flex items-center gap-1">
          <Button
            variant="bare"
            size="icon-sm"
            className="size-7 rounded-[7px] text-ink-faint hover:bg-paper-deep hover:text-ink"
            aria-label={t('panels.promptAttach')}
            title={t('panels.promptAttachTitle')}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            <AttachmentIcon className="size-3.5" />
          </Button>
          <Button
            variant="bare"
            size="icon-sm"
            className="size-7 rounded-[7px] text-ink-faint hover:bg-paper-deep hover:text-ink"
            aria-label={t('skills.menuLabel')}
            title={t('skills.menuButton')}
            disabled={busy}
            /* keep the field's caret: the / goes where the person was typing */
            onMouseDown={(e) => e.preventDefault()}
            onClick={skillMenu.openMenu}
          >
            <BookOpenIcon className="size-3.5" />
          </Button>
          <span className="flex-1" />
          <ModelPicker disabled={busy} />
          {/* the meter rides on the send button; a disabled button takes no
              pointer events, so the span under it is what the tooltip hangs on */}
          <Tooltip label={meter ?? t('panels.promptSendTooltip')} side="top" align="end">
            <span
              className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint"
              /* while the button is disabled the wrapper takes its tab stop,
                 so the meter can be reached and read without a pointer */
              tabIndex={busy || !canSend ? 0 : -1}
              aria-label={meter ?? undefined}
            >
              <Button
                variant="primary"
                size="icon-sm"
                className="size-7 rounded-full"
                type="submit"
                aria-label={t('panels.promptSend')}
                disabled={busy || !canSend}
              >
                {busy ? <span aria-hidden>…</span> : <ArrowUpIcon className="size-3.5" strokeWidth={1.6} />}
              </Button>
            </span>
          </Tooltip>
        </div>
      </form>
      {(error || sent) && (
        <div className="text-[11px] leading-[1.4]">
          {error ? (
            <Note tone="error" size="sm" className="text-[11px]">
              {error}
            </Note>
          ) : (
            <Note size="sm" className="text-[11px] text-ink-soft">
              <DoopMark size={11} /> {t('panels.promptSent')}
            </Note>
          )}
        </div>
      )}
    </div>
  )
}
