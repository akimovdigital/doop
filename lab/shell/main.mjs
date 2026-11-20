import { app, BrowserWindow, WebContentsView, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const config = JSON.parse(await readFile(new URL('./paths.json', import.meta.url), 'utf8'))
const { root, node } = config
const lab = path.join(root, 'lab')
const site = path.join(lab, 'site')
const host = '127.0.0.1'
const doop = 'http://' + host + ':48671'
const studio = 'http://' + host + ':48672'
const support = path.join(app.getPath('appData'), 'Doop Stacki Test')
const credentialsPath = path.join(support, 'local-account.json')
const page = path.join(site, 'src/pages/index.astro')
const children = new Set()
const toolbarHeight = 57
let window, designView, studioView, currentView, cookie, fixture, active
let ready = false
let transferring = false

app.setPath('userData', path.join(support, 'Chromium'))
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  for (const child of children) child.kill()
})

async function exists(file) {
  try {
    await access(file)
    return true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return false
  }
}

function checkPort(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', () => reject(new Error('Порт ' + port + ' занят. Закрой предыдущую тестовую сборку и открой приложение снова.')))
    probe.listen(port, host, () => probe.close(resolve))
  })
}

function start(name, args, cwd, overrides) {
  const log = createWriteStream(path.join(support, name + '.log'), { mode: 0o600 })
  const env = { PATH: path.dirname(node) + ':/usr/bin:/bin:/opt/homebrew/bin', HOME: app.getPath('home'), ...overrides }
  const child = spawn(node, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  child.on('error', () => {
    if (ready) showError(name + ' не удалось запустить.')
    log.end()
  })
  child.once('close', () => {
    children.delete(child)
    log.end()
    if (ready && children.size > 0) showError(name + ' остановился. Открой приложение снова.')
  })
  return child
}

async function waitFor(url, child, matches) {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (child.exitCode !== null || child.signalCode) break
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(850), redirect: 'error' })
      if (response.ok && await matches(response)) return
    } catch {}
    await delay(400)
  }
  throw new Error('Локальная служба не запустилась. Журнал запуска: ' + support)
}

async function request(route, options = {}) {
  const headers = { origin: doop, ...options.headers }
  if (cookie) headers.cookie = cookie
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json'
  const response = await fetch(doop + route, { ...options, headers, redirect: 'error', signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error('Ошибка Doop (' + response.status + ') при обращении к ' + route)
  return response
}

const json = (route, method, body) => request(route, { method, body: body === undefined ? undefined : JSON.stringify(body) }).then(response => response.json())

async function prepareDesign(account) {
  const identity = { email: 'fixture@doop-stacki.test', password: account.password }
  const method = account.registered ? 'sign-in' : 'sign-up'
  const response = await request('/api/auth/' + method + '/email', {
    method: 'POST',
    body: JSON.stringify({ ...identity, name: 'Тестировщик' }),
  })
  const cookies = response.headers.getSetCookie()
  cookie = cookies.map(header => header.split(';')[0]).join('; ')
  if (!cookie) throw new Error('Doop не вернул локальный сеанс.')
  account.registered = true
  await saveAccount(account)

  for (const header of cookies) {
    const match = /^([^=]+)=([^;]*)/.exec(header)
    if (match) await designView.webContents.session.cookies.set({
      url: doop, name: match[1], value: match[2], path: '/', httpOnly: true, sameSite: 'lax',
    })
  }

  if (!account.canvasId) {
    account.canvasId = (await json('/api/canvases', 'POST', { name: 'Тест Astro · Олень в лесу' })).id
    await saveAccount(account)
  }
  if (!account.image) {
    const bytes = await readFile(path.join(lab, 'sample/forest.jpg'))
    const upload = await request('/api/canvases/' + account.canvasId + '/assets', {
      method: 'POST', body: bytes, headers: { 'content-type': 'image/jpeg' },
    })
    account.image = (await upload.json()).url
    await saveAccount(account)
  }

  const template = await readFile(path.join(lab, 'sample/screen.html'), 'utf8')
  const css = await readFile(path.join(lab, 'sample/screen.css'), 'utf8')
  const html = template.replace('<link rel="stylesheet" href="%%STYLES%%">', '<style>\n' + css + '</style>').replace('%%IMAGE%%', account.image)
  if (!account.frameId) {
    const frame = await json('/api/canvases/' + account.canvasId + '/frames', 'POST', {
      name: 'Олень в лесу', width: 1080, height: 800, x: 0, y: 0, html,
    })
    account.frameId = frame.id
    await saveAccount(account)
  }
  fixture = { canvasId: account.canvasId, frameId: account.frameId, image: account.image, html, css }
}

async function saveAccount(account) {
  const temp = credentialsPath + '.next'
  await writeFile(temp, JSON.stringify(account), { mode: 0o600 })
  await rename(temp, credentialsPath)
}

async function transfer() {
  if (await exists(page)) {
    await openStudio()
    return
  }
  const canvas = await json('/api/canvases/' + fixture.canvasId)
  const frame = canvas.frames.find(item => item.id === fixture.frameId)
  if (!frame || frame.approval?.status !== 'ready_for_dev') {
    throw new Error('Выбери фрейм в Doop и отметь его Ready for dev.')
  }
  // The test exporter accepts only the reviewed static fixture. It must never
  // turn arbitrary Doop HTML into executable Astro templates.
  if (frame.html.trim() !== fixture.html.trim() || frame.width !== 1080 || frame.height !== 800) {
    throw new Error('Перенос поддерживает исходный тестовый фрейм 1080 × 800.')
  }
  const asset = await request(new URL(fixture.image).pathname)
  const image = Buffer.from(await asset.arrayBuffer())
  const baseline = await readFile(path.join(lab, 'sample/forest.jpg'))
  if (!image.equals(baseline)) throw new Error('Фотография Doop отличается от тестового ресурса.')
  const css = fixture.css
  const source = frame.html
    .replace('<style>\n' + css + '</style>', '<link rel="stylesheet" href="/screen.css">')
    .replace(fixture.image, '/images/forest.jpg')
  await mkdir(path.join(site, 'public/images'), { recursive: true })
  await copyFile(path.join(lab, 'sample/hills.jpg'), path.join(site, 'public/images/hills.jpg'))
  await writeFile(path.join(site, 'public/images/forest.jpg'), image)
  await writeFile(path.join(site, 'public/screen.css'), css)
  await writeFile(page + '.next', source)
  await rename(page + '.next', page)
  await openStudio()
}

function trace(event, data) {
  appendFileSync(path.join(support, 'shell.log'), JSON.stringify({ event, data }) + '\n', { mode: 0o600 })
}

async function openStudio() {
  select('studio')
  if (!studioView.webContents.getURL().startsWith(studio + '/studio')) {
    await studioView.webContents.loadURL(studio + '/studio')
    trace('studio-loaded', { bounds: studioView.getBounds(), url: studioView.webContents.getURL() })
    setTimeout(async () => {
      try {
        const dom = await studioView.webContents.executeJavaScript('({title: document.title, length: document.body?.innerText.length, root: !!document.getElementById("root"), state: document.readyState, size: [innerWidth, innerHeight]})')
        trace('studio-document', dom)
      } catch (error) {
        trace('studio-eval', error.message)
      }
    }, 1000).unref()
  }
}

function layout() {
  const [width, height] = window.getContentSize()
  for (const view of [designView, studioView]) view.setBounds({ x: 0, y: toolbarHeight, width, height: Math.max(0, height - toolbarHeight) })
}

function report(message = '', error = false) {
  if (!window.isDestroyed()) window.webContents.send('state', { ready, active, message, error })
}

function showError(message) {
  ready = false
  if (currentView) window.contentView.removeChildView(currentView)
  currentView = undefined
  report(message, true)
}

function select(mode) {
  active = mode
  const nextView = mode === 'design' ? designView : studioView
  if (currentView !== nextView) {
    if (currentView) window.contentView.removeChildView(currentView)
    window.contentView.addChildView(nextView)
    currentView = nextView
    layout()
  }
  report()
}

async function boot() {
  const doopData = path.join(support, 'Doop')
  await mkdir(doopData, { recursive: true, mode: 0o700 })
  await mkdir(path.dirname(page), { recursive: true })
  const content = path.join(doopData, 'dist')
  if (!await exists(content)) await symlink(path.join(root, 'dist'), content, 'dir')
  await Promise.all([checkPort(48671), checkPort(48672)])
  const account = await exists(credentialsPath)
    ? JSON.parse(await readFile(credentialsPath, 'utf8'))
    : { password: randomBytes(32).toString('base64url'), secret: randomBytes(32).toString('hex') }
  await saveAccount(account)
  const doopProcess = start('doop', ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), path.join(root, 'server/index.ts')], doopData, {
    NODE_ENV: 'production', HOST: host, PORT: '48671', BETTER_AUTH_URL: doop, BETTER_AUTH_SECRET: account.secret,
    REQUIRE_EMAIL_VERIFICATION: 'false',
  })
  const studioProcess = start('stacki', [path.join(site, 'node_modules/astro/bin/astro.mjs'), 'dev', '--host', host, '--port', '48672', '--ignore-lock'], site, {
    ASTRO_TELEMETRY_DISABLED: '1', STACKI_TELEMETRY_DISABLED: '1',
  })
  await Promise.all([
    waitFor(doop + '/healthz', doopProcess, async response => (await response.json()).ok === true).then(() => prepareDesign(account)),
    waitFor(studio + '/studio/api/session', studioProcess, async response => (await response.json()).editing === 'source'),
  ])
  await designView.webContents.loadURL(doop + '/c/' + fixture.canvasId + '?frame=' + fixture.frameId)
  ready = true
  select('design')
}

function createView(origin) {
  const view = new WebContentsView({ webPreferences: { partition: 'persist:doop-stacki-test', sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  if (origin === studio) {
    view.setBackgroundColor('#e4efe9')
    view.webContents.on('console-message', (_event, details) => {
      if (details.level === 'error') trace('studio-console', details.message)
    })
    view.webContents.on('render-process-gone', (_event, details) => trace('studio-renderer', details))
  }
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  view.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault()
  })
  return view
}

async function createWindow() {
  window = new BrowserWindow({
    title: 'Doop + Stacki Test · ' + app.getVersion(),
    width: 1390, height: 940, minWidth: 680, minHeight: 500, show: false,
    webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  designView = createView(doop)
  studioView = createView(studio)
  window.on('resize', layout)
  window.on('closed', () => {
    for (const view of [designView, studioView]) view.webContents.close()
  })
  layout()

  ipcMain.handle('mode', async (event, mode) => {
    if (event.sender !== window.webContents || !ready || transferring) return
    if (mode === 'design') select(mode)
    else if (mode === 'studio') {
      transferring = true
      report('Открываю Stacki…')
      try {
        await transfer()
      } catch (error) {
        select('design')
        report(error.message, true)
      } finally {
        transferring = false
      }
    }
  })

  window.webContents.on('did-finish-load', () => report(ready ? '' : 'Запускаю Doop и Stacki…'))
  await window.loadFile(path.join(import.meta.dirname, 'index.html'))
  if (process.argv.includes('--background-test')) window.showInactive()
  else window.show()
  report('Запускаю Doop и Stacki…')
  boot().catch(error => {
    for (const child of children) child.kill()
    showError(error.message)
  })
}

app.whenReady().then(createWindow).catch(error => {
  console.error(error)
  app.exit(1)
})
