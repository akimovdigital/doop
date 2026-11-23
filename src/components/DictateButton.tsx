import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useLocale, useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { openExternal } from '../lib/desktop'
import { createDictation, dictationLocale, pickDictationEngine, type DictationEngine } from '../lib/dictation'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { MicIcon } from './ui/icons'

export function DictateButton({
  text,
  onText,
  disabled,
}: {
  text: string
  onText: (value: string) => void
  disabled?: boolean
}) {
  const t = useT()
  const { locale } = useLocale()
  const mic = useRef<HTMLSpanElement>(null)
  const settings = useRef<HTMLButtonElement>(null)
  const [engine, setEngine] = useState<DictationEngine>()
  useEffect(() => {
    const candidate = pickDictationEngine()
    if (!candidate) return
    let ignore = false
    void Promise.resolve(candidate.available(dictationLocale(locale))).then(
      (available) => {
        if (!ignore) setEngine(available ? candidate : undefined)
      },
      () => {
        if (!ignore) setEngine(undefined)
      },
    )
    return () => {
      ignore = true
    }
  }, [locale])

  const dictation = useMemo(() => createDictation(engine), [engine])
  useLayoutEffect(() => {
    dictation.setField({ locale: () => locale, text: () => text, onText })
  }, [dictation, locale, text, onText])
  const state = useSyncExternalStore(dictation.subscribe, dictation.getState)
  useEffect(() => {
    window.addEventListener('pagehide', dictation.dispose)
    return () => {
      window.removeEventListener('pagehide', dictation.dispose)
      dictation.dispose()
    }
  }, [dictation])
  useEffect(() => {
    if (disabled) dictation.dispose()
  }, [dictation, disabled])

  useEffect(() => {
    if (!state.error) return
    function dismiss(event: Event) {
      // Tab from the mic must be able to reach the settings action.
      const target = event.target
      if (target instanceof Node && settings.current?.contains(target)) return
      if (
        event instanceof KeyboardEvent &&
        event.key === 'Tab' &&
        target instanceof Node &&
        mic.current?.contains(target)
      )
        return
      dictation.dismissError()
    }
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', dismiss, true)
    return () => {
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', dismiss, true)
    }
  }, [dictation, state.error])

  if (!state.available) return null
  const label = t(state.listening ? 'panels.dictationStop' : 'panels.dictationStart')
  return (
    <>
      <span ref={mic} className="relative inline-flex shrink-0 justify-self-end">
        <IconButton
          type="button"
          size="sm"
          className={cn('touch-none', state.listening && 'text-red-500 hover:text-red-500')}
          data-dictate=""
          data-recording={state.listening ? 'true' : undefined}
          aria-label={label}
          title={label}
          aria-pressed={state.listening}
          disabled={disabled}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            dictation.pointerDown()
          }}
          onPointerUp={dictation.pointerUp}
          onPointerCancel={dictation.pointerCancel}
          onLostPointerCapture={dictation.pointerCancel}
          onClick={(event) => {
            if (event.detail === 0) dictation.toggle()
          }}
        >
          <MicIcon size={14} />
          {state.listening && (
            <span
              aria-hidden="true"
              className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-red-500 motion-safe:animate-pulse"
            />
          )}
        </IconButton>
        {state.listening && (
          <span
            role="status"
            className="absolute right-0 bottom-full z-10 mb-1 whitespace-nowrap rounded-row border border-line bg-surface px-2 py-1 text-caption text-ink shadow-pop"
          >
            {t('panels.dictationListening')}
          </span>
        )}
      </span>
      {state.error && (
        <span className="order-last col-span-full basis-full rounded-row border border-line bg-surface px-2 py-1 text-caption text-ink">
          <span role="alert">
            {t(state.error === 'disabled' ? 'panels.dictationDisabled' : 'panels.dictationError')}
          </span>
          {state.error === 'disabled' && (
            <Button
              ref={settings}
              variant="link"
              size="inline"
              className="ml-2 text-brand underline"
              onClick={() => {
                openExternal('x-apple.systempreferences:com.apple.Keyboard-Settings.extension')
                dictation.dismissError()
              }}
            >
              {t('panels.dictationOpenSettings')}
            </Button>
          )}
        </span>
      )}
    </>
  )
}
