import { isTrusted, postToParent, browse } from './channel'

/** The opaque Browser design surface navigates through the editor's proxy. */
export function installBrowse(): void {
  if (!browse) return
  const currentUrl = browse.url
  document.addEventListener(
    'click',
    (event) => {
      if (!isTrusted(event)) return
      const link = event.target instanceof Element && event.target.closest('a, area')
      if (!link) return
      const href = link.getAttribute('href') ?? link.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
      if (href === null) return
      event.preventDefault()
      const next = URL.parse(href, currentUrl)
      if (!next || !/^https?:$/.test(next.protocol) || next.username || next.password) return
      postToParent({ type: 'doop:browse-navigate', url: next.href })
    },
    true,
  )
  document.addEventListener(
    'auxclick',
    (event) => {
      if (event.target instanceof Element && event.target.closest('a, area')) event.preventDefault()
    },
    true,
  )
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      const hash = new URL(currentUrl).hash.slice(1)
      if (hash) {
        try {
          document.getElementById(decodeURIComponent(hash))?.scrollIntoView()
        } catch {
          /* invalid fragment */
        }
      }
    },
    { once: true },
  )
  postToParent({ type: 'doop:browse-ready', url: currentUrl })
}
