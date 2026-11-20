import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'
import studio from '../vendor/studio/integration.mjs'

export default defineConfig({
  devToolbar: { enabled: false },
  integrations: [studio({
    root: fileURLToPath(new URL('.', import.meta.url)),
    assets: fileURLToPath(new URL('../vendor/studio/', import.meta.url)),
    editing: 'source',
    port: 48672,
  })],
})
