import { en } from './en'
import type { Catalog, Locale } from './index'

export const catalogs: Partial<Record<Locale, Catalog>> = { en }

let loading: Promise<void> | undefined

export function loadCatalog(locale: Locale): Promise<void> | undefined {
  if (catalogs[locale]) return
  loading ??= import('./pt-BR')
    .then(({ ptBR }) => {
      catalogs['pt-BR'] = ptBR
    })
    .catch((error: unknown) => {
      console.warn('Could not load the Portuguese translation.', error)
    })
    .finally(() => {
      loading = undefined
    })
  return loading
}
