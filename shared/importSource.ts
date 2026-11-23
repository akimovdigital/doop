export const IMPORT_SOURCE_META = 'doop-import-source'

/** Identify snapshots created from a particular requested URL. The value is
 *  encoded so an arbitrary query string cannot break the HTML attribute. */
export function importedPageSource(html: string): string | undefined {
  const encoded = html.match(
    new RegExp(`<meta\\s+name=["']${IMPORT_SOURCE_META}["']\\s+content=["']([^"']+)["']`, 'i'),
  )?.[1]
  if (!encoded) return undefined
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}
