import { build } from 'esbuild'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENTRY = fileURLToPath(new URL('./main.ts', import.meta.url))

export interface BuiltFrameRuntime {
  code: string
  /** every source file in the bundle, normalized for Vite's watcher */
  inputs: string[]
}

export async function buildFrameRuntime(): Promise<BuiltFrameRuntime> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    metafile: true,
    legalComments: 'none',
    logLevel: 'silent',
    /* the closure was strict: esbuild emits the directive above the IIFE,
       which makes this one script element strict and nothing else */
    tsconfigRaw: { compilerOptions: { alwaysStrict: true } },
  })
  const code = result.outputFiles[0]?.text ?? ''
  /* the script sits inside <script data-v-boot>: either sequence would end
     or derail it there */
  if (/<\/script|<!--/i.test(code)) throw new Error('frame runtime: the built script cannot be inlined in <script>')
  const inputs = Object.keys(result.metafile.inputs).map((input) => resolve(input).split(sep).join('/'))
  return { code, inputs }
}
