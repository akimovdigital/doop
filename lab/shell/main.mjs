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
const pagesDirectory = path.join(site, 'src/pages')
const children = new Set()
const toolbarHeight = 57
let window, editorView, cookie, account, fixture, active
let ready = false
let busy = false

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
    if (match) await editorView.webContents.session.cookies.set({
      url: doop, name: match[1], value: match[2], path: '/', httpOnly: true, sameSite: 'lax',
    })
  }

  const entry = account.example ?? account
  fixture = await prepareFixture(entry)
  await saveAccount(account)
}

async function prepareFixture(entry) {
  const number = entry.number ?? 1
  const file = number === 1 ? 'index.astro' : 'example-' + number + '.astro'
  const page = path.join(pagesDirectory, file)
  if (!entry.canvasId) {
    entry.canvasId = (await json('/api/canvases', 'POST', { name: 'Пример ' + number + ' · Олень в лесу' })).id
  }
  if (!entry.image) {
    const bytes = await readFile(path.join(lab, 'sample/forest.jpg'))
    const upload = await request('/api/canvases/' + entry.canvasId + '/assets', {
      method: 'POST', body: bytes, headers: { 'content-type': 'image/jpeg' },
    })
    entry.image = (await upload.json()).url
  }

  const template = await readFile(path.join(lab, 'sample/screen.html'), 'utf8')
  const css = await readFile(path.join(lab, 'sample/screen.css'), 'utf8')
  const html = template.replace('<link rel="stylesheet" href="%%STYLES%%">', '<style>\n' + css + '</style>').replace('%%IMAGE%%', entry.image)
  if (!entry.frameId) {
    const frame = await json('/api/canvases/' + entry.canvasId + '/frames', 'POST', {
      name: 'Олень в лесу', width: 1080, height: 800, x: 0, y: 0, html,
    })
    entry.frameId = frame.id
  }
  return {
    canvasId: entry.canvasId, frameId: entry.frameId, image: entry.image,
    number, file, page, html, css, transferred: await exists(page),
  }
}

async function openDesign(example) {
  const target = doop + '/c/' + example.canvasId + '?frame=' + example.frameId
  await loadEditor(target)
}

async function newExample() {
  const entry = { number: fixture.number + 1 }
  const next = await prepareFixture(entry)
  await openDesign(next)
  await saveAccount({ ...account, example: entry })
  account.example = entry
  fixture = next
  select('design')
}

async function saveAccount(account) {
  const temp = credentialsPath + '.next'
  await writeFile(temp, JSON.stringify(account), { mode: 0o600 })
  await rename(temp, credentialsPath)
}

async function transfer() {
  const { number, page } = fixture
  if (await exists(page)) {
    fixture.transferred = true
    await openStudio()
    return
  }
  const canvas = await json('/api/canvases/' + fixture.canvasId)
  const frame = canvas.frames.find(item => item.id === fixture.frameId)
  if (!frame || frame.approval?.status !== 'ready_for_dev') {
    throw new Error('Для переноса нужна отметка Ready for dev.')
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
  const assets = number === 1 ? '' : '/examples/' + number
  const publicDirectory = path.join(site, 'public' + assets)
  const source = frame.html
    .replace('<style>\n' + css + '</style>', '<link rel="stylesheet" href="' + assets + '/screen.css">')
    .replace(fixture.image, assets + '/images/forest.jpg')
  await mkdir(path.join(publicDirectory, 'images'), { recursive: true })
  await copyFile(path.join(lab, 'sample/hills.jpg'), path.join(publicDirectory, 'images/hills.jpg'))
  await writeFile(path.join(publicDirectory, 'images/forest.jpg'), image)
  await writeFile(path.join(publicDirectory, 'screen.css'), css)
  await writeFile(page + '.next', source)
  await rename(page + '.next', page)
  fixture.transferred = true
  await openStudio()
}

function trace(event, data) {
  appendFileSync(path.join(support, 'shell.log'), JSON.stringify({ event, data }) + '\n', { mode: 0o600 })
}

async function openStudio() {
  const target = new URL('/studio', studio)
  if (fixture.number !== 1) target.searchParams.set('file', 'src/pages/' + fixture.file)
  await loadEditor(target.href)
  select('studio')
}

async function loadEditor(target) {
  const contents = editorView.webContents
  if (contents.getURL() === target) return
  await contents.loadURL(target)
  // Ask Chromium for a frame after navigation, including while the window
  // has no keyboard focus. Nothing from the frame is stored.
  try {
    await Promise.race([contents.capturePage(), delay(1500, undefined, { ref: false })])
    contents.invalidate()
  } catch (error) {
    trace('editor-paint', error.message)
  }
}

function layout() {
  const [width, height] = window.getContentSize()
  editorView.setBounds({ x: 0, y: toolbarHeight, width, height: Math.max(0, height - toolbarHeight) })
}

function report(message, error = false) {
  const status = fixture && active === 'design' && !fixture.transferred ? 'Отметь фрейм Ready for dev и нажми Stacki.' : ''
  if (!window.isDestroyed()) window.webContents.send('state', {
    ready, busy, active, message: message ?? status, error,
    example: fixture?.number,
  })
}

function showError(message) {
  ready = false
  editorView.setVisible(false)
  report(message, true)
}

function select(mode) {
  active = mode
  report()
}

async function boot() {
  const doopData = path.join(support, 'Doop')
  await mkdir(doopData, { recursive: true, mode: 0o700 })
  await mkdir(pagesDirectory, { recursive: true })
  const content = path.join(doopData, 'dist')
  if (!await exists(content)) await symlink(path.join(root, 'dist'), content, 'dir')
  await Promise.all([checkPort(48671), checkPort(48672)])
  account = await exists(credentialsPath)
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
  await openDesign(fixture)
  ready = true
  select('design')
}

function createView() {
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:doop-stacki-test', sandbox: true, contextIsolation: true, backgroundThrottling: false,
      preload: path.join(import.meta.dirname, 'studio-preload.cjs'),
    },
  })
  view.setBackgroundColor('#e4efe9')
  view.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error' && view.webContents.getURL().startsWith(studio + '/')) {
      trace('studio-console', details.message)
    }
  })
  view.webContents.on('render-process-gone', (_event, details) => trace('editor-renderer', details))
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  view.webContents.on('will-navigate', (event, url) => {
    const allowed = active === 'studio' ? studio : doop
    if (new URL(url).origin !== allowed) event.preventDefault()
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
  editorView = createView()
  window.contentView.addChildView(editorView)
  window.on('resize', layout)
  window.on('closed', () => editorView.webContents.close())
  layout()

  ipcMain.handle('mode', async (event, mode) => {
    if (event.sender !== window.webContents || !ready || busy) return
    if (mode !== 'design' && mode !== 'studio' && mode !== 'new') return

    busy = true
    const loading = { design: 'Открываю Doop…', studio: 'Открываю Stacki…', new: 'Создаю чистый фрейм в Doop…' }
    report(loading[mode])
    let failure
    try {
      if (mode === 'new') {
        await newExample()
      } else if (mode === 'design') {
        await openDesign(fixture)
        select('design')
      } else {
        await transfer()
      }
    } catch (error) {
      failure = error.message
    } finally {
      busy = false
      report(failure, failure !== undefined)
    }
  })

  window.webContents.on('did-finish-load', () => report(ready ? undefined : 'Запускаю Doop и Stacki…'))
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
