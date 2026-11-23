import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { build, type Plugin } from 'vite'
import { revision, worktreeDirty } from './site'

function bytes(code: string) {
  return { min: Buffer.byteLength(code), gzip: gzipSync(code).length, brotli: brotliCompressSync(code).length }
}

async function measure(root: string, outDir: string) {
  const js: Record<string, string> = {}
  const staticImports: Record<string, string[]> = {}
  const entries = new Set<string>()
  const css: Record<string, number> = {}
  const modules = new Map<string, number>()
  const collect: Plugin = {
    name: 'doop-bundle-report',
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'asset') {
          if (output.fileName.endsWith('.css')) css[output.fileName] = Buffer.byteLength(output.source)
          if (output.fileName === 'index.html') {
            // Vite's HTML plugin can preload additional static chunks.
            const html = output.source.toString()
            for (const match of html.matchAll(/<link (?=[^>]*rel="modulepreload")[^>]*href="([^"]+)"/g)) {
              if (match[1]) entries.add(match[1].replace(/^\//, ''))
            }
          }
          continue
        }
        js[output.fileName] = output.code
        staticImports[output.fileName] = output.imports
        if (output.isEntry) entries.add(output.fileName)
        for (const [id, module] of Object.entries(output.modules)) {
          const name = id.startsWith(root) ? relative(root, id) : id
          modules.set(name, (modules.get(name) ?? 0) + module.renderedLength)
        }
      }
    },
  }
  const previous = process.cwd()
  process.chdir(root)
  try {
    await build({
      root,
      configLoader: 'runner',
      configFile: join(root, 'vite.config.ts'),
      mode: 'production',
      envDir: false,
      logLevel: 'error',
      plugins: [collect],
      build: { outDir, emptyOutDir: true, copyPublicDir: false, reportCompressedSize: false },
    })
  } finally {
    process.chdir(previous)
  }
  const entry = [...entries].find((file) => /(?:^|\/)index-[^/]+\.js$/.test(file))
  if (!entry || !js[entry]) throw new Error('Could not find the app entry chunk')
  const initial = new Set<string>()
  function visit(file: string) {
    if (initial.has(file) || !js[file]) return
    initial.add(file)
    for (const dependency of staticImports[file] ?? []) visit(dependency)
  }
  for (const file of entries) visit(file)
  const sizes = [...initial].map((file) => ({ file, ...bytes(js[file]!) }))
  return {
    entry: { file: entry, ...bytes(js[entry]) },
    initial: sizes.reduce(
      (sum, size) => ({
        min: sum.min + size.min,
        gzip: sum.gzip + size.gzip,
        brotli: sum.brotli + size.brotli,
      }),
      { min: 0, gzip: 0, brotli: 0 },
    ),
    initialFiles: sizes,
    css,
    shipsHud: Object.values(js).some((code) => code.includes('doop:perf-hud') || code.includes('doop-perf-hud')),
    topModules: [...modules]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([module, renderedBytes]) => ({ module, renderedBytes })),
  }
}

async function main() {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, 'base-ref': { type: 'string' }, help: { type: 'boolean' } },
  })
  if (values.help) {
    console.log('bun run bench:bundle [--out dir] [--base-ref git-ref]')
    return
  }
  const root = process.cwd()
  const out = resolve(
    values.out ??
      join(
        homedir(),
        'Library/Application Support/Doop Test/bench',
        new Date().toISOString().replace(/[:.]/g, '-') + '-bundle',
      ),
  )
  const temp = await mkdtemp(join(tmpdir(), 'doop-bundle-'))
  try {
    const current = { sha: revision(root), dirty: worktreeDirty(root), ...(await measure(root, join(temp, 'current'))) }
    let baseline: typeof current | null = null
    if (values['base-ref']) {
      const sha = execFileSync('git', ['rev-parse', '--verify', values['base-ref'] + '^{commit}'], {
        encoding: 'utf8',
      }).trim()
      const base = join(temp, 'baseline')
      const tar = join(temp, 'baseline.tar')
      await mkdir(base)
      execFileSync('git', ['archive', '-o', tar, sha])
      execFileSync('tar', ['-xf', tar, '-C', base])
      await symlink(join(root, 'node_modules'), join(base, 'node_modules'), 'dir')
      baseline = { sha, dirty: false, ...(await measure(base, join(temp, 'baseline-dist'))) }
    }
    const deltaBytes =
      baseline &&
      Object.fromEntries(
        ['entry', 'initial'].map((key) => {
          const metric = key as 'entry' | 'initial'
          return [
            key,
            {
              min: current[metric].min - baseline[metric].min,
              gzip: current[metric].gzip - baseline[metric].gzip,
              brotli: current[metric].brotli - baseline[metric].brotli,
            },
          ]
        }),
      )
    const report = { schema: 1, current, baseline, deltaBytes }
    await mkdir(out, { recursive: true })
    await writeFile(join(out, 'bundle.json'), JSON.stringify(report, null, 2) + '\n')
    console.table({
      ...(baseline && { baselineEntry: baseline.entry, baselineInitial: baseline.initial }),
      entry: current.entry,
      initial: current.initial,
    })
    console.table(current.topModules)
    console.log(join(out, 'bundle.json'))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
await main()
