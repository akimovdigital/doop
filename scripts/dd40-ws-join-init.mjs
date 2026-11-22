#!/usr/bin/env node
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import WebSocket from 'ws'

const CANVAS = 'NGUsXEPoD3'
const HOST = process.env.DD40_WS_HOST ?? '127.0.0.1:4437'
const RUNS = Number(process.env.DD40_RUNS ?? 6)
const LABEL = process.env.DD40_LABEL ?? 'run'
const CLIENT_ID = process.env.DD40_CLIENT_ID
const cookie = readFileSync('/tmp/doop-nikita-cookie', 'utf8').trim().split('\n')[0]

function percentile(sorted, p) {
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))]
}

function median(sorted) {
  return percentile(sorted, 50)
}

async function oneJoin(clientId, initEncoding) {
  const t0 = performance.now()
  const ws = new WebSocket(`ws://${HOST}/ws`, { headers: { Cookie: cookie } })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const handshakeMs = performance.now() - t0
  const joinSent = performance.now()
  const initPromise = new Promise((resolve, reject) => {
    const onMessage = (data) => {
      const buf = data instanceof Buffer ? data : Buffer.from(data)
      const gzipped = buf[0] === 0x1f && buf[1] === 0x8b
      try {
        const json = gzipped ? gunzipSync(buf).toString() : buf.toString()
        const msg = JSON.parse(json)
        if (msg.type === 'init') {
          ws.off('message', onMessage)
          resolve(data)
        }
      } catch {
        /* wait for init frame */
      }
    }
    ws.on('message', onMessage)
    ws.once('error', reject)
  })
  ws.send(
    JSON.stringify({
      type: 'join',
      canvasId: CANVAS,
      clientId,
      name: 'Bench',
      kind: 'user',
      pageLayoutMoves: true,
      ...(initEncoding ? { initEncoding: 'gzip' } : {}),
    }),
  )
  const raw = await initPromise
  const initMs = performance.now() - joinSent
  const buf = raw instanceof Buffer ? raw : Buffer.from(raw)
  const gzipped = buf[0] === 0x1f && buf[1] === 0x8b
  let json
  try {
    json = gzipped ? gunzipSync(buf).toString() : buf.toString()
  } catch {
    json = buf.toString()
  }
  const msg = JSON.parse(json)
  if (msg.type !== 'init') throw new Error(`expected init, got ${msg.type}`)
  ws.close()
  return {
    handshakeMs,
    joinToInitMs: initMs,
    bytes: buf.length,
    gzipped,
    frames: msg.canvas?.frames?.length ?? 0,
  }
}

const joinTimes = []
const handshakeTimes = []
for (let i = 0; i < RUNS; i++) {
  const clientId = CLIENT_ID ?? `dd40-${LABEL}-${i}`
  const r = await oneJoin(clientId, true)
  joinTimes.push(r.joinToInitMs)
  handshakeTimes.push(r.handshakeMs)
  if (i === 0) {
    console.log(
      JSON.stringify({
        label: LABEL,
        sample: r,
        host: HOST,
        canvas: CANVAS,
      }),
    )
  }
}

joinTimes.sort((a, b) => a - b)
handshakeTimes.sort((a, b) => a - b)
console.log(
  JSON.stringify({
    label: LABEL,
    runs: RUNS,
    joinToInitMs: {
      values: joinTimes.map((v) => Math.round(v * 10) / 10),
      median: Math.round(median(joinTimes) * 10) / 10,
      p95: Math.round(percentile(joinTimes, 95) * 10) / 10,
    },
    handshakeMs: {
      median: Math.round(median(handshakeTimes) * 10) / 10,
    },
  }),
)