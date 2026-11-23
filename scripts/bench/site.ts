import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { access, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { makeRealScene } from '../../tests/perf/scene'
import type { Memory } from '../../tests/perf/protocol'

export const exec = promisify(execFile)
const fixture = '/tests/fixtures/perfCanvas.html'
const metadata = 'bench-build.json'

export function revision(cwd: string) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
}

export function worktreeDirty(cwd: string) {
  return !!execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim()
}

export async function buildSite(source: string, output: string) {
  const cwd = resolve(source)
  await access(join(cwd, 'tests/fixtures/perfCanvas.html')).catch((error: unknown) => {
    throw new Error(`No perf fixture in ${cwd}. Use a worktree containing the harness or a prebuilt site.`, {
      cause: error,
    })
  })
  const build = { sha: revision(cwd), dirty: worktreeDirty(cwd), source: cwd }
  if (build.dirty) {
    const patch = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd, maxBuffer: 32 * 1024 * 1024 })
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd,
      encoding: 'utf8',
    })
    const hash = createHash('sha256').update(patch)
    for (const file of untracked.split('\0').filter(Boolean)) {
      hash
        .update(file)
        .update('\0')
        .update(readFileSync(join(cwd, file)))
        .update('\0')
    }
    Object.assign(build, { diffSha256: hash.digest('hex') })
  }
  try {
    await exec(
      join(cwd, 'node_modules/.bin/vite'),
      ['build', '--config', 'tests/fixtures.vite.config.ts', '--outDir', output],
      { cwd, timeout: 60_000, env: { ...process.env, NODE_ENV: 'production', DOOP_BENCH_ONLY: '1' } },
    )
  } catch (error) {
    throw new Error(`Fixture build failed in ${cwd}: ${String(error)}`, { cause: error })
  }
  await writeFile(join(output, metadata), JSON.stringify(build, null, 2) + '\n')
  return { dir: output, ...build }
}

export async function siteFrom(source: string, output: string) {
  const dir = await realpath(source)
  if (
    await stat(join(dir, 'tests/fixtures.vite.config.ts')).then(
      (entry) => entry.isFile(),
      () => false,
    )
  ) {
    return buildSite(dir, output)
  }
  if (
    await stat(join(dir, fixture)).then(
      (entry) => entry.isFile(),
      () => false,
    )
  ) {
    const saved = await readFile(join(dir, metadata), 'utf8').then(
      (raw) =>
        JSON.parse(raw) as {
          sha?: string
          dirty?: boolean
          diffSha256?: string
        },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      },
    )
    return {
      dir,
      source: dir,
      sha: saved?.sha ?? null,
      dirty: saved?.dirty ?? null,
      diffSha256: saved?.diffSha256 ?? null,
    }
  }
  throw new Error(`Expected a Doop worktree or a built perf fixture site: ${dir}`)
}

export function vmStat(): Memory {
  if (process.platform !== 'darwin') return { Swapins: 0, Swapouts: 0 }
  const raw = execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2000 })
  const counter = (name: string) => {
    const match = raw.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))
    if (!match) throw new Error(`vm_stat did not report ${name}`)
    return Number(match[1])
  }
  return { Swapins: counter('Swapins'), Swapouts: counter('Swapouts') }
}

const contentTypes: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  wasm: 'application/wasm',
  woff2: 'font/woff2',
  png: 'image/png',
  webp: 'image/webp',
}
const csp =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; worker-src 'self' blob:"

export async function loadScene(path: string) {
  const data = await readFile(path)
  const sha256 = createHash('sha256').update(data).digest('hex')
  const { frames, source } = makeRealScene(JSON.parse(data.toString('utf8')), sha256)
  return { data, sha256, source, ids: new Set(frames.map((frame) => frame.id)) }
}
type ExportedScene = Awaited<ReturnType<typeof loadScene>>
const realCsp = csp.replace(/(?:style|img|font)-src [^;]+/g, '$& https:') + "; media-src 'self' https:"

export async function serve(dir: string, scene?: ExportedScene) {
  let navigationMemory: Memory | undefined
  const root = await realpath(dir)
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      res.setHeader('Cache-Control', 'no-store')
      if (path === '/__memory' && req.method === 'GET') {
        const memory = url.searchParams.has('initial') ? navigationMemory : vmStat()
        if (!memory) {
          res.writeHead(409).end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(memory))
        return
      }
      if (scene && path === '/__scene.json' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Scene-SHA256': scene.sha256 }).end(scene.data)
        return
      }
      if (
        req.method === 'PATCH' &&
        (scene
          ? path.startsWith('/api/frames/') && scene.ids.has(decodeURIComponent(path.slice('/api/frames/'.length)))
          : /^\/api\/frames\/f\d+$/.test(path))
      ) {
        req.resume()
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
        return
      }
      if (req.method !== 'GET' || (path !== fixture && !path.startsWith('/assets/'))) {
        res.writeHead(404).end()
        return
      }
      if (path === fixture && url.searchParams.get('scenario') === 'open') navigationMemory = vmStat()
      const file = await realpath(join(root, decodeURIComponent(path))).catch(() => null)
      if (!file?.startsWith(root + sep)) {
        res.writeHead(404).end()
        return
      }
      const data = await readFile(file)
      res
        .writeHead(200, {
          'Content-Type': contentTypes[file.split('.').at(-1) ?? ''] ?? 'application/octet-stream',
          'Content-Security-Policy': scene ? realCsp : csp,
        })
        .end(data)
    })().catch((error: unknown) => {
      res.writeHead(500).end(String(error))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server has no loopback address')
  return { url: new URL(fixture, `http://127.0.0.1:${address.port}`), close: () => server.close() }
}
