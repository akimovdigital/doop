// One observer for live iframe viewport crossings. Ancestor overflow already
// clips the intersection to the stage, including when the editor is split.
const listeners = new WeakMap<Element, (visible: boolean) => void>()
let observer: IntersectionObserver | undefined

export function observeFrameViewportPaint(frame: HTMLIFrameElement, onVisibility: (visible: boolean) => void) {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const { target, intersectionRect } of entries) {
        listeners.get(target)?.(intersectionRect.width > 0 && intersectionRect.height > 0)
      }
    },
    // Touching the clip edge at zero area does not wake a document.
    { threshold: Number.EPSILON },
  )
  listeners.set(frame, onVisibility)
  observer.observe(frame)
  return () => {
    observer?.unobserve(frame)
    listeners.delete(frame)
  }
}
