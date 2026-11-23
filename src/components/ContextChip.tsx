import { useEffect, useState } from 'react'
import { discardDesignCrop, readDesignCrop } from '../lib/designCrop'
import { useT } from '@/lib/i18n'
import type { UiElementContext } from '../../shared/uiElementContext'
import { useStore, type ComposerDraft } from '../lib/store'
import { Button } from './ui/button'
import { XIcon } from './ui/icons'
import { Tooltip } from './ui/tooltip'

function safeThumbnail(value: string | undefined) {
  if (!value) return
  try {
    const url = new URL(value, location.href)
    if (url.origin === location.origin && url.pathname.startsWith('/a/')) return url.href
  } catch {
    // Only use stored URLs that point at a Doop asset on this origin.
  }
}

function useThumbnail(context: UiElementContext, composer: boolean) {
  const [local, setLocal] = useState<{ id: string; url: string }>()
  const id = context.noteId
  useEffect(() => {
    if (!composer) return
    let current = true
    let url: string | undefined
    void readDesignCrop(id).then((blob) => {
      if (!current || !blob) return
      url = URL.createObjectURL(blob)
      setLocal({ id, url })
    })
    return () => {
      current = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [id, composer])
  return composer && local?.id === id ? local.url : safeThumbnail(context.thumbnail)
}

export function ContextChip({
  context,
  onRemove,
  disabled,
}: {
  context: UiElementContext
  onRemove?: () => void
  disabled?: boolean
}) {
  const t = useT()
  const { width, height } = context.rect
  const thumbnail = useThumbnail(context, !!onRemove)
  return (
    <span
      data-context-chip={context.kind}
      className="inline-flex min-w-0 max-w-full items-center gap-0.5 rounded-row bg-brand/10 px-1.5 text-caption font-medium text-brand ring-1 ring-inset ring-brand/20"
    >
      <Tooltip
        label={
          <span className="block break-all">
            {context.component && <span className="block">{context.component}</span>}
            {context.selector && <span className="block">{context.selector}</span>}
            {Math.round(width)} × {Math.round(height)} px
            {context.changes?.map((change) => (
              <span key={change} className="block">
                {change}
              </span>
            ))}
          </span>
        }
      >
        <span tabIndex={0} className="max-w-56 truncate py-0.5">
          {thumbnail && (
            <img
              data-context-thumbnail=""
              src={thumbnail}
              alt=""
              className="mr-1 inline-block h-4 w-6 rounded-row object-cover"
            />
          )}
          {context.label}
        </span>
      </Tooltip>
      {onRemove && (
        <Button
          type="button"
          variant="bare"
          size="pill"
          className="size-4 p-0"
          disabled={disabled}
          aria-label={t('panels.contextChipRemove', { name: context.label })}
          onClick={onRemove}
        >
          <XIcon size={10} />
        </Button>
      )}
    </span>
  )
}

export function ContextChips({
  contexts,
  onRemove,
  disabled,
}: {
  contexts: UiElementContext[]
  onRemove?: (index: number) => void
  disabled?: boolean
}) {
  if (!contexts.length) return null
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {contexts.map((context, index) => (
        <ContextChip
          key={`${context.noteId}:${context.selector}:${index}`}
          context={context}
          disabled={disabled}
          onRemove={onRemove && (() => onRemove(index))}
        />
      ))}
    </div>
  )
}

export function ComposerContextChips({
  canvasId,
  draft,
  busy,
}: {
  canvasId: string
  draft: ComposerDraft
  busy: boolean
}) {
  function remove(index: number) {
    const store = useStore.getState()
    const current = store.composerDrafts[canvasId]
    if (!current) return
    const removed = current.contexts[index]
    if (removed && current.contexts.filter((item) => item.noteId === removed.noteId).length === 1)
      void discardDesignCrop(removed.noteId)
    store.setComposerDraft(
      canvasId,
      current.text,
      current.contexts.filter((_, i) => i !== index),
    )
  }
  return <ContextChips contexts={draft.contexts} onRemove={remove} disabled={busy} />
}
