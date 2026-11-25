import { buildFrameRuntime, type BuiltFrameRuntime } from './build.ts'
import { normalizePath, type Plugin } from 'vite'

/**
 * The frame runtime is built into one classic script and handed to the editor
 * as a string (`import FRAME_RUNTIME from 'virtual:frame-runtime'`), which
 * `FRAME_BOOTSTRAP` inlines into every frame's `srcdoc`. A frame is a
 * sandboxed iframe without `allow-same-origin`, so the script stays inline:
 * loaded from Doop's origin it would need its own CSP, caching and desktop
 * shell rules.
 *
 * esbuild bundles `main.ts` and everything it imports into one IIFE: every
 * module's top level lands in the one function scope, so nothing reaches the
 * window the design's scripts share, as the hand-written closure did. The
 * same plugin serves `bun run dev`, `vite build`, vitest, the browser-test
 * fixture build and Storybook, since they all load vite.config.ts.
 */

export { buildFrameRuntime } from './build.ts'

export const FRAME_RUNTIME_MODULE = 'virtual:frame-runtime'
const RESOLVED_ID = '\0' + FRAME_RUNTIME_MODULE

export function frameRuntime(): Plugin {
  let built: Promise<BuiltFrameRuntime> | null = null
  let inputs = new Set<string>()
  function current(): Promise<BuiltFrameRuntime> {
    built ??= buildFrameRuntime().catch((error: unknown) => {
      built = null // a syntax error mid-edit: build again on the next request
      throw error
    })
    return built
  }
  return {
    name: 'doop:frame-runtime',
    resolveId(id) {
      return id === FRAME_RUNTIME_MODULE ? RESOLVED_ID : null
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null
      const runtime = await current()
      inputs = new Set(runtime.inputs)
      for (const input of runtime.inputs) this.addWatchFile(input)
      return `export default ${JSON.stringify(runtime.code)}`
    },
    async generateBundle() {
      const runtime = await current()
      this.emitFile({ type: 'asset', fileName: 'frame-runtime.js', source: runtime.code })
    },
    /* `vite build --watch` */
    watchChange(id) {
      if (inputs.has(normalizePath(id))) built = null
    },
    /* the dev server: a changed runtime file rebuilds the script and updates
       the modules that inline it, so open frames load the new runtime */
    handleHotUpdate({ file, server, modules }) {
      if (!inputs.has(normalizePath(file))) return
      built = null
      const runtime = server.moduleGraph.getModuleById(RESOLVED_ID)
      if (!runtime) return
      server.moduleGraph.invalidateModule(runtime)
      return [...modules, runtime]
    },
  }
}
