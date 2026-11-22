#!/usr/bin/env node
/* global document, requestAnimationFrame, WheelEvent */
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const URL = 'http://127.0.0.1:4437/c/NGUsXEPoD3'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const cookieLine = readFileSync('/tmp/doop-nikita-cookie', 'utf8').trim().split('\n')[0]
const [, cookieVal] = cookieLine.split('=', 2)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--window-size=1440,900',
    '--user-data-dir=/tmp/dd40-chrome-profile',
  ],
  defaultViewport: { width: 1440, height: 900 },
})

const page = await browser.newPage()
await page.setCookie({
  name: 'better-auth.session_token',
  value: decodeURIComponent(cookieVal),
  domain: '127.0.0.1',
  path: '/',
  httpOnly: true,
})

const tNav = performance.now()
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 120_000 })
const navigationMs = performance.now() - tNav

await page.waitForFunction(
  () => document.querySelector('[data-testid="stage"]') || document.querySelector('.stage'),
  { timeout: 60_000 },
).catch(() => null)

const metrics = await page.evaluate(async () => {
  const stage =
    document.querySelector('[data-testid="stage"]') ||
    document.querySelector('main') ||
    document.body
  const deltas = []
  let last = performance.now()
  await new Promise((resolve) => {
    const end = last + 3000
    function tick(now) {
      const d = now - last
      if (d > 0) deltas.push(d)
      last = now
      if (now < end) requestAnimationFrame(tick)
      else resolve(undefined)
    }
    requestAnimationFrame(tick)
  })
  deltas.sort((a, b) => a - b)
  const p = (q) => deltas[Math.min(deltas.length - 1, Math.ceil((q / 100) * deltas.length) - 1)] ?? 0
  const panDeltas = []
  const wheel = (dx, dy) =>
    stage.dispatchEvent(new WheelEvent('wheel', { deltaX: dx, deltaY: dy, bubbles: true, cancelable: true }))
  let t = performance.now()
  for (let i = 0; i < 40; i++) {
    const n = performance.now()
    wheel(24, 0)
    panDeltas.push(n - t)
    t = n
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
  }
  panDeltas.sort((a, b) => a - b)
  const panP95 = panDeltas[Math.min(panDeltas.length - 1, Math.ceil(0.95 * panDeltas.length) - 1)] ?? 0
  const jankRatio = deltas.filter((d) => d > 33.3).length / Math.max(1, deltas.length)
  const iframes = document.querySelectorAll('iframe').length
  return {
    rafMedianMs: p(50),
    rafP95Ms: p(95),
    rafJankOver33msRatio: jankRatio,
    panWheelP95Ms: panP95,
    iframeCount: iframes,
    heapMB: performance.memory ? Math.round((performance.memory.usedJSHeapSize / 1e6) * 10) / 10 : null,
  }
})

console.log(JSON.stringify({ navigationMs: Math.round(navigationMs), chrome: CHROME, url: URL, ...metrics }, null, 2))
await browser.close()