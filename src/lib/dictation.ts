export const DICTATION_HOLD_MS = 300

type DictationError = 'generic' | 'disabled'

export interface SpeechCallbacks {
  result(transcript: string, final: boolean): void
  end(): void
  noSpeech(): void
  error(reason?: DictationError): void
}

interface SpeechSession {
  stop(): void
  cancel(): void
}

export interface DictationEngine {
  available(locale: string): boolean | Promise<boolean>
  start(locale: string, callbacks: SpeechCallbacks): SpeechSession
}

export interface DictationState {
  available: boolean
  listening: boolean
  error: DictationError | null
}

interface DictationField {
  locale(): string
  text(): string
  onText(text: string): void
}

let escapeActive: (() => boolean) | undefined

/** The player handles Escape in capture phase, before either editor closes. */
export function stopActiveDictation(): boolean {
  return escapeActive?.() ?? false
}

export function dictationLocale(locale: string): string {
  return locale === 'en' ? 'en-US' : locale.trim() || 'ru-RU'
}

export function createDictation(engine: DictationEngine | undefined, field?: DictationField) {
  let state: DictationState = { available: !!engine, listening: false, error: null }
  let session: { speech?: SpeechSession; base: string; lastWritten?: string } | undefined
  let press: { timer: ReturnType<typeof setTimeout>; held: boolean } | undefined
  const listeners = new Set<() => void>()

  let errorTimer: ReturnType<typeof setTimeout> | undefined

  function dismissError() {
    if (state.error) publish(state.listening)
  }

  function publish(listening: boolean, error: DictationError | null = null) {
    clearTimeout(errorTimer)
    errorTimer = error ? setTimeout(dismissError, 4000) : undefined
    state = { ...state, listening, error }
    listeners.forEach((listener) => listener())
  }

  function clearPress() {
    if (press) clearTimeout(press.timer)
    press = undefined
  }

  function releaseActive() {
    if (escapeActive === escape) escapeActive = undefined
  }

  function stop() {
    if (!state.listening) return
    releaseActive()
    publish(false)
    session?.speech?.stop()
  }

  function start() {
    if (!engine || !field || state.listening) return
    if (escapeActive && escapeActive !== escape) escapeActive()
    escapeActive = escape
    const previous = session
    const current: NonNullable<typeof session> = { base: field.text() }
    session = current
    previous?.speech?.cancel()
    publish(true)
    function finish(error: DictationError | null = null) {
      if (session !== current) return
      session = undefined
      releaseActive()
      publish(false, error)
    }
    try {
      current.speech = engine.start(dictationLocale(field.locale()), {
        result(transcript) {
          if (!field || session !== current || !transcript.trim()) return
          const currentText = field.text()
          if (currentText !== current.base && currentText !== current.lastWritten) {
            stop()
            return
          }
          const join = current.base && !/\s$/.test(current.base) ? ' ' : ''
          current.lastWritten = current.base + join + transcript.trim()
          field.onText(current.lastWritten)
        },
        end: () => finish(),
        noSpeech: () => finish(),
        error: (reason = 'generic') => finish(reason),
      })
    } catch {
      finish('generic')
    }
  }

  function toggle() {
    if (state.listening) stop()
    else start()
  }

  function escape() {
    if (!press && !state.listening) return false
    clearPress()
    stop()
    releaseActive()
    return true
  }

  return {
    getState: () => state,
    setField(next: DictationField) {
      field = next
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    pointerDown() {
      if (!engine || press) return
      if (escapeActive && escapeActive !== escape) escapeActive()
      escapeActive = escape
      press = {
        held: false,
        timer: setTimeout(() => {
          if (!press) return
          press.held = true
          start()
        }, DICTATION_HOLD_MS),
      }
    },
    pointerUp() {
      if (!press) return
      const { held } = press
      clearPress()
      if (held) stop()
      else toggle()
      if (!state.listening) releaseActive()
    },
    pointerCancel() {
      const wasHeld = press?.held
      clearPress()
      if (wasHeld) stop()
      if (!state.listening) releaseActive()
    },
    toggle,
    dismissError,
    escape,
    dispose() {
      clearPress()
      releaseActive()
      const previous = session
      session = undefined
      previous?.speech?.cancel()
      if (state.listening || state.error) publish(false)
    },
  }
}

interface Recognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
}

interface RecognitionEvent extends Event {
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

type SpeechEvent =
  { type: 'result'; transcript: string; final: boolean } | { type: 'end' | 'error' | 'disabled' | 'no_speech' }

interface NativeCore {
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>
  Channel: new () => { onmessage: (message: SpeechEvent) => void }
}

type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition
  webkitSpeechRecognition?: new () => Recognition
  __DOOP_NATIVE_DICTATION__?: boolean
  __DOOP_DESKTOP__?: string
  __DOOP_DESKTOP_PLATFORM__?: string
  __TAURI__?: { core?: NativeCore }
}

function nativeEngine(core: NativeCore): DictationEngine {
  return {
    available: (locale) => core.invoke<boolean>('dictation_available', { locale }),
    start(locale, callbacks) {
      const token = crypto.randomUUID()
      const events = new core.Channel()
      events.onmessage = (event) => {
        if (event.type === 'result') callbacks.result(event.transcript, event.final)
        else if (event.type === 'disabled') callbacks.error('disabled')
        else if (event.type === 'no_speech') callbacks.noSpeech()
        else callbacks[event.type]()
      }
      const starting = core.invoke('dictation_start', { token, locale, events })
      void starting.catch(() => callbacks.error())
      function end(cancel: boolean) {
        void starting.then(
          () => core.invoke('dictation_stop', { token, cancel }).catch(() => callbacks.error()),
          () => {},
        )
      }
      return { stop: () => end(false), cancel: () => end(true) }
    },
  }
}

export function pickDictationEngine(view: SpeechWindow = window): DictationEngine | undefined {
  const core = view.__TAURI__?.core
  if (view.__DOOP_NATIVE_DICTATION__ && core?.Channel && typeof core.invoke === 'function') return nativeEngine(core)
  const desktopWebKit =
    view.__DOOP_DESKTOP__ &&
    (!view.__DOOP_DESKTOP_PLATFORM__ || view.__DOOP_DESKTOP_PLATFORM__ === 'macos') &&
    view.__DOOP_NATIVE_DICTATION__ !== false
  if (view.__DOOP_NATIVE_DICTATION__ || desktopWebKit) return
  const Constructor = view.SpeechRecognition ?? view.webkitSpeechRecognition
  if (!Constructor) return
  return {
    available: () => true,
    start(locale, callbacks) {
      const recognition = new Constructor()
      recognition.lang = locale
      recognition.continuous = true
      recognition.interimResults = true
      recognition.addEventListener('result', (event) => {
        const results = Array.from((event as RecognitionEvent).results)
        callbacks.result(
          results.map((part) => part[0].transcript.trim()).join(' '),
          results.every((part) => part.isFinal),
        )
      })
      recognition.addEventListener('error', (event) => {
        if ((event as Event & { error?: string }).error === 'no-speech') callbacks.noSpeech()
        else callbacks.error()
      })
      recognition.addEventListener('end', callbacks.end)
      recognition.start()
      const finish = (stop: () => void) => {
        try {
          stop()
        } catch {
          callbacks.end()
        }
      }
      return { stop: () => finish(() => recognition.stop()), cancel: () => finish(() => recognition.abort()) }
    },
  }
}
