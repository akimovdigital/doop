/** This skips iframe layout/paint while its wrapper is offscreen. The iframe
 *  stays mounted and inherits the new counter-zoom alongside visible
 *  iframes. Removing the wrapper's containment is enough to
 *  resume at the current layout zoom, including on an interrupted settle. */
export function createFrameLayoutQueue() {
  const pending = new Map<string, HTMLElement>()
  let raf = 0

  function reveal(id: string) {
    const wrapper = pending.get(id)
    if (!wrapper) return
    wrapper.style.removeProperty('content-visibility')
    pending.delete(id)
  }

  function clear() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    for (const id of pending.keys()) reveal(id)
  }

  function drain() {
    raf = 0
    let count = 0
    for (const id of pending.keys()) {
      reveal(id)
      if (++count === 4) break
    }
    if (pending.size) raf = requestAnimationFrame(drain)
  }

  return {
    get pending() {
      return pending.size
    },
    clear,
    reveal,
    defer(wrappers: Iterable<HTMLElement>, onscreen: ReadonlySet<string>) {
      clear()
      for (const wrapper of wrappers) {
        const id = wrapper.dataset.frameLayoutRoot
        if (!id || onscreen.has(id) || wrapper.contains(document.activeElement)) continue
        wrapper.style.contentVisibility = 'hidden'
        pending.set(id, wrapper)
      }
      // Crossing a paint gives the visible frames a chance to settle before
      // the first offscreen batch. Do not read geometry from paused wrappers.
      if (pending.size)
        raf = requestAnimationFrame(() => {
          raf = requestAnimationFrame(drain)
        })
    },
  }
}
