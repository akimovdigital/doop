import { readdirSync } from 'node:fs'
import { mergeConfig, type UserConfig } from 'vite'
import app from '../vite.config.ts'

/* The production build the browser tests load (tests/browser.ts runs it once
   per test run): the app's own build with every fixture page as an entry
   beside index.html, minified as it ships. No .env file is read, so the pages
   are the same on every machine, and no source maps are written: nothing
   reads them, and the build stays about a second. */
const benchOnly = process.env.DOOP_BENCH_ONLY === '1'
const pages: UserConfig = {
  // React's ordinary production renderer omits Profiler callbacks.
  ...(benchOnly
    ? {
        resolve: { alias: [{ find: /^react-dom$/, replacement: 'react-dom/profiling' }] },
        define: { 'import.meta.env.DOOP_BENCH_ONLY': 'true' },
      }
    : {}),
  logLevel: 'error',
  envDir: false,
  build: {
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: benchOnly
        ? ['tests/fixtures/perfCanvas.html']
        : [
            'index.html',
            ...readdirSync('tests/fixtures')
              .filter((name) => name.endsWith('.html'))
              .map((name) => `tests/fixtures/${name}`),
          ],
    },
  },
}

export default mergeConfig(app as UserConfig, pages)
