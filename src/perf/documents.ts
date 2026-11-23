import { hasFrameDocument } from '../lib/frameBridge'

export function liveDocuments() {
  const iframes = document.querySelectorAll('iframe[data-doop-frame]')
  let ready = 0
  for (const iframe of iframes) {
    const id = iframe.closest('[data-doop-frame-shell]')?.getAttribute('data-doop-frame-shell')
    if (id && hasFrameDocument(id)) ready++
  }
  return { mounted: iframes.length, ready }
}
