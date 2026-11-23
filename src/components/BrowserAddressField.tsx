import { useState, type Ref } from 'react'
import { useT } from '../lib/i18n'
import { cn } from '../lib/utils'
import { Input } from './ui/input'

export function BrowserAddressField({
  url,
  inputRef,
  autoFocus,
  readOnly,
  tabIndex,
  className,
  onCommit,
  onCancel,
  onReveal,
}: {
  url: string
  inputRef?: Ref<HTMLInputElement>
  autoFocus?: boolean
  readOnly?: boolean
  tabIndex?: number
  className?: string
  onCommit: (value: string) => boolean
  onCancel?: () => void
  onReveal?: (input: HTMLInputElement) => void
}) {
  const t = useT()
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const reset = () => {
    setDraft(null)
    setInvalid(false)
  }
  return (
    <Input
      variant="bare"
      inputSize="auto"
      ref={inputRef}
      autoFocus={autoFocus}
      type="text"
      inputMode="url"
      aria-label={t('canvas.browserUrl')}
      aria-invalid={invalid || undefined}
      title={invalid ? t('canvas.browserInvalidUrl') : undefined}
      placeholder={t('canvas.browserUrl')}
      autoCapitalize="off"
      autoComplete="off"
      spellCheck={false}
      readOnly={readOnly}
      tabIndex={tabIndex}
      className={cn(
        'browser-address min-w-0 rounded-row border border-line bg-sub px-2 text-label text-ink',
        className,
      )}
      value={draft ?? url}
      onPointerDown={(event) => event.stopPropagation()}
      onFocus={(event) => {
        event.currentTarget.select()
        onReveal?.(event.currentTarget)
      }}
      onChange={(event) => {
        setDraft(event.target.value)
        setInvalid(false)
      }}
      onBlur={() => {
        reset()
        onCancel?.()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          reset()
          event.currentTarget.blur()
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          if (!readOnly && onCommit(event.currentTarget.value)) {
            reset()
            event.currentTarget.blur()
          } else if (!readOnly) setInvalid(true)
        }
      }}
    />
  )
}
