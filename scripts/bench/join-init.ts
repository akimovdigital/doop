import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { gunzipSync } from 'node:zlib'
import WebSocket, { type RawData } from 'ws'

async function serverChild(entry: string) {
  process.on('message', (message) => {
    if (message === 'memory') process.send?.(process.memoryUsage())
  })
  await import(pathToFileURL(entry).href)
}

async function freePort() {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  const closed = once(probe, 'close')
  probe.close()
  await closed
  if (!address || typeof address === 'string' || address.port === 4437) {
    throw new Error('Could not reserve an isolated benchmark port')
  }
  return address.port
}

async function ready(child: ChildProcess, base: string, port: number) {
  // Require the child itself to bind, in case somebody else got the probed port.
  let output = ''
  const until = AbortSignal.timeout(180_000)
  const onData = (data: Buffer) => {
    output = (output + data.toString()).slice(-8192)
  }
  child.stdout!.on('data', onData)
  try {
    while (!output.includes(`doop server     http://127.0.0.1:${port}\n`)) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited: ${output}`)
      await delay(50, undefined, { signal: until })
    }
    while (!(await fetch(base + '/healthz', { signal: until }).catch(() => null))?.ok) {
      await delay(50, undefined, { signal: until })
    }
  } catch (error) {
    throw new Error(`Benchmark server not ready on ${base}: ${output.trim() || '(no stdout)'}`, { cause: error })
  } finally {
    child.stdout!.off('data', onData)
    child.stdout!.resume()
  }
}

async function seed(base: string) {
  // Same email signup and in-memory cookie jar as tests/harness.ts.
  const cookies = new Map<string, string>()
  async function write(path: string, body: unknown, method = 'POST') {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(), Origin: base },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0]!
      cookies.set(pair.slice(0, pair.indexOf('=')), pair)
    }
    return (await response.json()) as { id: string; html?: string }
  }
  const cookieHeader = () => [...cookies.values()].join('; ')
  await write('/api/auth/sign-up/email', {
    email: 'join-bench@test.dev',
    password: 'password12345',
    name: 'Join benchmark',
  })
  const { id } = await write('/api/canvases', { name: 'Synthetic 26 MiB canvas' })
  const frames = 64
  const frameBytes = (26 * 1024 * 1024) / frames
  let htmlBytes = 0
  let firstFrame: { id: string; html: string } | undefined
  for (let frame = 0; frame < frames; frame++) {
    // Mix shared markup with deterministic, frame-specific content.
    const rows = Array.from({ length: 1900 }, (_, row) => {
      const tag = createHash('sha256').update(`${frame}:${row}`).digest('hex').slice(0, 32)
      return `<p class="detail" data-record="${tag}">This is a repeatable design benchmark with typical headings, body copy, layout and styles.</p>\n`
    })
    const html = '<main>' + (rows.join('') + rows.join('')).slice(0, frameBytes - 20) + '</main>'
    const result = await write(`/api/canvases/${id}/frames`, { name: `Frame ${frame + 1}`, html })
    firstFrame ??= { id: result.id, html: result.html ?? html }
    htmlBytes += Buffer.byteLength(result.html ?? '')
  }
  const frame = firstFrame!
  const editFrame = async (revision: number) => {
    const html = frame.html.replace('<main>', `<main data-rev="${String(revision).padStart(8, '0')}">`)
    await write(`/api/frames/${frame.id}`, { html }, 'PATCH')
  }
  return { id, cookie: cookieHeader(), htmlBytes, frames, editFrame }
}

async function measureJoin(base: string, cookie: string, canvasId: string, i: number, gzip: boolean) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', {
    headers: { Cookie: cookie },
    handshakeTimeout: 5000,
  })
  ws.on('error', () => {}) // once() reports transport errors; terminate() can also emit one on cleanup.
  const signal = AbortSignal.timeout(15_000)
  try {
    const [[upgrade]] = await Promise.all([once(ws, 'upgrade', { signal }), once(ws, 'open', { signal })])
    const { socket } = upgrade as IncomingMessage
    let firstByte = NaN
    let start = 0
    socket.prependOnceListener('data', () => {
      firstByte = performance.now() - start
    })
    const message = once(ws, 'message', { signal })
    start = performance.now()
    ws.send(
      JSON.stringify({
        type: 'join',
        canvasId,
        clientId: `bench-${i}`,
        ...(gzip ? { initEncoding: 'gzip' } : {}),
      }),
    )
    const [raw] = (await message) as [RawData, boolean]
    const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)
    const json = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : data
    const init = JSON.parse(json.toString())
    const parsed = performance.now() - start
    if (!Number.isFinite(firstByte) || init.type !== 'init' || init.canvas.id !== canvasId) {
      throw new Error('Unexpected room initialisation')
    }
    const closed = once(ws, 'close', { signal })
    ws.close()
    await closed
    return { firstByte, parsed, payloadBytes: data.length, jsonBytes: json.length }
  } finally {
    ws.terminate()
  }
}

async function memory(child: ChildProcess): Promise<NodeJS.MemoryUsage> {
  const response = once(child, 'message', { signal: AbortSignal.timeout(5000) })
  child.send('memory')
  return (await response)[0] as NodeJS.MemoryUsage
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
  return { median, p95: sorted[Math.ceil(sorted.length * 0.95) - 1]! }
}

function joinSummary(samples: Awaited<ReturnType<typeof measureJoin>>[]) {
  return {
    jsonBytes: samples[0]!.jsonBytes,
    payloadBytes: summary(samples.map((sample) => sample.payloadBytes)),
    firstByteMs: summary(samples.map((sample) => sample.firstByte)),
    fullyParsedMs: summary(samples.map((sample) => sample.parsed)),
  }
}

async function benchmark() {
  const { values } = parseArgs({
    options: {
      'server-root': { type: 'string', default: process.cwd() },
      joins: { type: 'string', default: '20' },
      warmup: { type: 'string', default: '3' },
      plain: { type: 'boolean' },
    },
  })
  const repeats = Number(values.joins)
  const warmup = Number(values.warmup)
  if (!Number.isSafeInteger(repeats) || repeats < 1 || !Number.isSafeInteger(warmup) || warmup < 0) {
    throw new Error('Pass positive --joins and nonnegative --warmup integers')
  }
  const root = resolve(values['server-root'])
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const dataDir = await mkdtemp(join(tmpdir(), 'doop-bench-join-'))
  // The server matches Doop Dev's Bun runtime. Node exposes the upgraded TCP socket for first-byte timing.
  const child = spawn('bun', [fileURLToPath(import.meta.url), '--server-child', join(root, 'server/index.ts')], {
    cwd: dataDir,
    env: {
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: String(port),
      BETTER_AUTH_URL: base,
      REQUIRE_EMAIL_VERIFICATION: 'false',
    },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  })
  const stopped = once(child, 'exit')
  try {
    await ready(child, base, port)
    const canvas = await seed(base)
    const gzip = !values.plain
    const heapBefore = await memory(child)
    for (let i = 0; i < warmup; i++) await measureJoin(base, canvas.cookie, canvas.id, i, gzip)
    const misses = []
    const hits = []
    const serverHeap = []
    for (let i = 0; i < repeats; i++) {
      await canvas.editFrame(i)
      misses.push(await measureJoin(base, canvas.cookie, canvas.id, warmup + 2 * i, gzip))
      hits.push(await measureJoin(base, canvas.cookie, canvas.id, warmup + 2 * i + 1, gzip))
      serverHeap.push(await memory(child))
    }
    console.log(
      JSON.stringify(
        {
          serverRoot: root,
          encoding: gzip ? 'gzip' : 'plain',
          joinsPerCase: repeats,
          warmup,
          frames: canvas.frames,
          htmlBytes: canvas.htmlBytes,
          miss: joinSummary(misses),
          hit: joinSummary(hits),
          serverMemoryBeforeWarmupBytes: heapBefore,
          serverHeapUsedBytes: summary(serverHeap.map((sample) => sample.heapUsed)),
          serverExternalBytes: summary(serverHeap.map((sample) => sample.external)),
          serverRssBytes: summary(serverHeap.map((sample) => sample.rss)),
        },
        null,
        2,
      ),
    )
  } finally {
    child.kill()
    const force = setTimeout(() => child.kill('SIGKILL'), 5000)
    try {
      await stopped
    } finally {
      clearTimeout(force)
      await rm(dataDir, { recursive: true, force: true })
    }
  }
}

if (process.argv[2] === '--server-child') await serverChild(process.argv[3]!)
else await benchmark()
