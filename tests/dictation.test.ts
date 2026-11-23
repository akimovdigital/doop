import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDictation, dictationLocale, type DictationEngine, type SpeechCallbacks } from '../src/lib/dictation'

function setup(available = true) {
  let callbacks: SpeechCallbacks
  let output = 'Existing note'
  const stop = vi.fn()
  const cancel = vi.fn()
  const start = vi.fn((_language: string, next: SpeechCallbacks) => {
    callbacks = next
    return { stop, cancel }
  })
  const engine: DictationEngine | undefined = available ? { available: () => true, start } : undefined
  const controller = createDictation(engine, {
    locale: () => 'ru-RU',
    text: () => output,
    onText: (text) => {
      output = text
    },
  })
  return {
    controller,
    start,
    stop,
    cancel,
    callbacks: () => callbacks,
    text: () => output,
    type: (next: string) => {
      output = next
    },
  }
}

describe('dictating a Design Mode note', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('toggles on click, updates interim text in place, and escapes without clearing typed text', () => {
    const { controller, start, stop, callbacks, text } = setup()
    controller.pointerDown()
    vi.advanceTimersByTime(100)
    controller.pointerUp()
    expect(start).toHaveBeenCalledWith('ru-RU', expect.anything())
    expect(controller.getState().listening).toBe(true)
    callbacks().result('moving', false)
    expect(text()).toBe('Existing note moving')
    callbacks().result('move it', false)
    expect(text()).toBe('Existing note move it')
    expect(controller.escape()).toBe(true)
    expect(controller.getState().listening).toBe(false)
    expect(stop).toHaveBeenCalledTimes(1)
    callbacks().result('move it down', true)
    callbacks().end()
    expect(text()).toBe('Existing note move it down')
    expect(controller.escape()).toBe(false)
    controller.toggle()
    controller.toggle()
    expect(stop).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('starts after 300ms and stops on release, with no second toggle', () => {
    const { controller, start, stop } = setup()
    controller.pointerDown()
    vi.advanceTimersByTime(299)
    expect(start).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(start).toHaveBeenCalledTimes(1)
    controller.pointerUp()
    expect(controller.getState().listening).toBe(false)
    expect(stop).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('cancels a pending hold on Escape and does not record after release', () => {
    const { controller, start } = setup()
    controller.pointerDown()
    expect(controller.escape()).toBe(true)
    vi.advanceTimersByTime(500)
    controller.pointerUp()
    expect(start).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('surfaces a recognition error, preserves the draft and permits a retry', () => {
    const { controller, start, callbacks, text } = setup()
    controller.toggle()
    callbacks().error()
    expect(controller.getState()).toEqual({ available: true, listening: false, error: true })
    expect(text()).toBe('Existing note')
    controller.toggle()
    expect(start).toHaveBeenCalledTimes(2)
    expect(controller.getState().error).toBe(false)
    controller.dispose()
  })

  it('preserves manual edits made while a final transcript is still arriving', () => {
    const { controller, callbacks, text, type } = setup()
    controller.toggle()
    callbacks().result('possible words', false)
    controller.escape()
    type('Manual replacement')
    callbacks().result('final words', true)
    callbacks().end()
    expect(text()).toBe('Manual replacement')
  })

  it('reports unavailable so the control stays hidden, and falls back to Russian without a UI locale', () => {
    const { controller, start } = setup(false)
    expect(controller.getState().available).toBe(false)
    controller.toggle()
    expect(start).not.toHaveBeenCalled()
    expect(dictationLocale('')).toBe('ru-RU')
    expect(dictationLocale('pt-BR')).toBe('pt-BR')
  })
})
