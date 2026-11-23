export function perfHudEnabled(search: string, storage: Pick<Storage, 'getItem'>): boolean {
  if (new URLSearchParams(search).get('perfHud') === '1') return true
  try {
    return storage.getItem('doop:perf-hud') === '1'
  } catch {
    return false
  }
}

export function loadPerfHud<T>(search: string, storage: Pick<Storage, 'getItem'>, load: () => T): T | undefined {
  return perfHudEnabled(search, storage) ? load() : undefined
}
