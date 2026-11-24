import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer, { type Browser } from 'puppeteer-core'
import { findBrowserPath } from '../../server/screenshot'
import { windowSize, type RunSample } from '../../tests/perf/protocol'
import { exec } from './site'

export type Engine = 'webkit' | 'chromium'
export interface Driver {
  version: string
  mode: string
  run(url: URL, timeout: number, screenshot?: string, diagnostics?: ProbeOptions): Promise<RunSample>
  close(): Promise<void>
}

type ProbeOptions = { captureDirectory?: string; trace: boolean; renderMode: string }

async function webkit(): Promise<Driver> {
  if (process.platform !== 'darwin') throw new Error('WKWebView requires macOS')
  const source = fileURLToPath(new URL('../../tests/perf/webkit/WKProbe.swift', import.meta.url))
  const version = (await exec('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim()
  const framework = '/System/Library/Frameworks/WebKit.framework/Versions/A/Resources/Info.plist'
  const webkitVersion = (
    await exec('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleVersion', framework])
  ).stdout.trim()
  const key = createHash('sha256')
    .update(await readFile(source))
    .update(version)
    .digest('hex')
    .slice(0, 16)
  const cache = join(homedir(), 'Library/Caches/doop-bench')
  const probe = join(cache, `WKProbe-${key}`)
  await mkdir(cache, { recursive: true })
  try {
    await access(probe)
  } catch {
    const build = probe + '.' + process.pid
    try {
      await exec(
        '/usr/bin/xcrun',
        ['swiftc', '-O', '-module-cache-path', join(cache, 'swift-modules'), source, '-o', build],
        { timeout: 60_000 },
      )
      await rename(build, probe)
    } finally {
      await rm(build, { force: true })
    }
  }
  return {
    version: `WebKit ${webkitVersion} / macOS ${version}`,
    mode: 'non-activating WKWebView',
    async run(url, timeout, screenshot, diagnostics) {
      if (screenshot) await mkdir(dirname(screenshot), { recursive: true })
      const capture = diagnostics?.captureDirectory
      if (capture) await mkdir(capture, { recursive: true })
      const { stdout } = await exec(
        probe,
        [
          url.href,
          String(timeout / 1000),
          screenshot ?? '',
          capture ?? '',
          diagnostics?.trace ? '1' : '0',
          diagnostics?.renderMode ?? 'baseline',
        ],
        { timeout: timeout + 2000, maxBuffer: 2 * 1024 * 1024 },
      )
      return JSON.parse(stdout) as RunSample
    },
    async close() {},
  }
}

async function launchChromium(
  executablePath: string,
  headed: boolean,
  profile: string,
  realScene: boolean,
): Promise<Browser> {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--password-store=basic',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    ...(realScene ? [] : ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']),
    '--window-size=1280,888',
  ]
  if (!headed) {
    return puppeteer.launch({
      executablePath,
      headless: true,
      userDataDir: profile,
      timeout: 15_000,
      args,
      ...(realScene ? { protocolTimeout: 300_000 } : {}),
    })
  }
  if (process.platform !== 'darwin') throw new Error('--headed requires the background macOS launcher')
  const app = executablePath.match(/^(.*\.app)\/Contents\/MacOS\//)?.[1]
  if (!app) throw new Error('--headed requires a browser installed as a macOS .app')
  await mkdir(profile, { recursive: true })
  await exec(
    '/usr/bin/open',
    [
      '-g',
      '-n',
      '-F',
      '-a',
      app,
      '--args',
      ...args,
      '--no-startup-window',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
    ],
    { timeout: 10_000 },
  )
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    const active = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')
    const [port, path] = active.trim().split('\n')
    if (port && path) {
      return puppeteer.connect({
        browserWSEndpoint: `ws://127.0.0.1:${port}${path}`,
        defaultViewport: null,
        ...(realScene ? { protocolTimeout: 300_000 } : {}),
      })
    }
    await sleep(100)
  }
  throw new Error('Background Chrome did not start its DevTools endpoint')
}

async function chromium(headed: boolean, profile: string, realScene: boolean): Promise<Driver> {
  const path = findBrowserPath()
  if (!path) throw new Error('No local Chrome/Chromium found. Set CHROME_PATH to an executable.')
  const browser = await launchChromium(path, headed, profile, realScene)
  try {
    const version = await browser.version()
    const native = headed ? await browser.target().createCDPSession() : null
    return {
      version,
      mode: headed ? 'windowed Chromium (background launch)' : 'headless Chromium',
      async run(url, timeout, screenshot) {
        const context = await browser.createBrowserContext()
        try {
          let page
          if (native) {
            await native.send('Target.createTarget', {
              url: 'about:blank',
              newWindow: true,
              background: true,
              browserContextId: context.id,
              width: windowSize.width,
              height: windowSize.height + 88,
            })
            const target = await browser.waitForTarget(
              (target) => target.browserContext() === context && target.type() === 'page',
            )
            page = await target.page()
            if (!page) throw new Error('Background Chrome target has no page')
            const session = await page.createCDPSession()
            const { windowId } = await session.send('Browser.getWindowForTarget')
            await native.send('Browser.setContentsSize', {
              windowId,
              width: windowSize.width,
              height: windowSize.height,
            })
            await session.detach()
          } else {
            page = await context.newPage()
            await page.setViewport({
              width: windowSize.width,
              height: windowSize.height,
              deviceScaleFactor: windowSize.dpr,
            })
          }
          const diagnostics: string[] = []
          page.on('pageerror', (error) => diagnostics.push(String(error)))
          const response = await page.goto(url.href, { waitUntil: 'load', timeout })
          if (!response?.ok()) throw new Error(`Fixture HTTP ${response?.status() ?? 'unavailable'}`)
          await page
            .waitForFunction(() => window.perfBenchResult !== undefined, { timeout })
            .catch((error: unknown) => {
              throw new Error(`Fixture did not start: ${diagnostics.join('; ')}`, { cause: error })
            })
          const sample = await page.evaluate(() => window.perfBenchResult)
          if (headed && (await page.evaluate(() => document.hasFocus()))) {
            throw new Error('Background Chrome acquired page focus')
          }
          if (screenshot) {
            await mkdir(dirname(screenshot), { recursive: true })
            await page.screenshot({ path: screenshot })
          }
          return sample
        } finally {
          await context.close()
        }
      },
      close: () => browser.close(),
    }
  } catch (error) {
    await browser.close()
    throw error
  }
}

export function startEngine(engine: Engine, headed: boolean, profile: string, realScene = false) {
  return engine === 'webkit' ? webkit() : chromium(headed, profile, realScene)
}
