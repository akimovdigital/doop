import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Frame as BrowserFrame, KeyInput, Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import type { AgentTask, Canvas } from '../shared/types'
import { fixtureUrl, pagePerTest } from './browser'

const canvas: Canvas = {
  id: 'design-preview',
  name: 'Design Preview',
  createdAt: 1,
  updatedAt: 1,
  frames: [
    {
      id: 'home',
      canvasId: 'design-preview',
      name: 'Home',
      x: 0,
      y: 0,
      width: 1000,
      height: 700,
      createdAt: 1,
      updatedAt: 1,
      updatedBy: 'Test',
      html: `<!doctype html><style>*{box-sizing:border-box}body{margin:0}
        #wrap{position:absolute;left:40px;top:50px;width:360px;height:260px}
        #go{display:block;width:160px;height:60px;color:rgb(0,0,0);background-color:rgb(255,255,255);font:16px Arial}
        #title{margin:24px 0} #more{position:absolute;top:1100px}
        </style><main id="wrap"><button id="go" data-doop-on="click" data-doop-action="navigate:next">Open now</button>
        <h1 id="title">A sample heading</h1></main><p id="more">Scroll target</p>`,
    },
    {
      id: 'next',
      canvasId: 'design-preview',
      name: 'Next',
      x: 1100,
      y: 0,
      width: 460,
      height: 320,
      createdAt: 1,
      updatedAt: 1,
      updatedBy: 'Test',
      html: '<!doctype html><h1>The second screen</h1>',
    },
  ],
}
type Fixture = {
  fixtureReady: boolean
  seed: (canvas: Canvas) => void
  play: (frameId: string) => void
  playSynced: (frameId: string) => void
  mockDesignSends: () => void
  designSends: unknown[][]
  designSendDelay?: number
  designSendError?: string
  readDesignDraft: (canvasId: string) => string
  writeDesignDraft: (canvasId: string, text: string) => void
  editFrame: (id: string, html: string) => void
  setDesignTasks: (tasks: AgentTask[]) => void
}

const field = '[data-design-note-field]'
const capsule = '[data-preview-chat]'
const chatField = '[data-preview-chat-field]'
const control = (label: string) => `button[aria-label="${label}"]`
const pin = (number: number) => `[data-design-pin="${number}"]`

describe.skipIf(!findBrowserPath())('prototype design mode', { timeout: 35_000 }, () => {
  const pages = pagePerTest()
  let page: Page
  let firstMount: boolean

  beforeEach(async () => {
    page = await pages.open()
    firstMount = true
    await page.setViewport({ width: 1000, height: 760 })
  })

  async function mount(data = canvas, synced = false) {
    await page.goto(fixtureUrl('prototype.html'))
    await page.waitForFunction(() => (window as unknown as Fixture).fixtureReady)
    await page.evaluate(
      (data, synced, reset) => {
        const fixture = window as unknown as Fixture
        if (reset) localStorage.clear()
        fixture.mockDesignSends()
        fixture.seed(data)
        if (synced) fixture.playSynced(data.frames[0]!.id)
        else fixture.play(data.frames[0]!.id)
      },
      data,
      synced,
      firstMount,
    )
    firstMount = false
    await page.waitForFunction(() =>
      (window as unknown as { messages: { type: string; on?: boolean }[] }).messages.some(
        (message) => message.type === 'doop:proto-result' && message.on,
      ),
    )
    return screen(data.frames[0]!.id)
  }

  async function screen(id: string): Promise<BrowserFrame> {
    const iframe = await page.waitForSelector(`iframe[data-doop-proto-frame="${id}"]`, { visible: true })
    const frame = await iframe!.contentFrame()
    await frame!.waitForSelector('body > :not(script)', { visible: true })
    return frame!
  }

  async function location(frame: BrowserFrame, selector: string, fx = 0.5, fy = 0.5) {
    const [rect, parent] = await Promise.all([
      frame.$eval(selector, (el) => {
        const rect = el.getBoundingClientRect()
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      }),
      page.$eval('iframe[data-doop-proto-frame]', (el) => {
        const iframe = el as HTMLIFrameElement
        const rect = iframe.getBoundingClientRect()
        return { x: rect.x, y: rect.y, scale: rect.width / iframe.offsetWidth }
      }),
    ])
    return {
      x: parent.x + (rect.left + rect.width * fx) * parent.scale,
      y: parent.y + (rect.top + rect.height * fy) * parent.scale,
    }
  }

  async function chord(key: KeyInput, shift = false) {
    await page.keyboard.down('Meta')
    if (shift) await page.keyboard.down('Shift')
    try {
      await page.keyboard.press(key)
    } finally {
      if (shift) await page.keyboard.up('Shift')
      await page.keyboard.up('Meta')
    }
  }

  async function enter() {
    await page.click(control('Annotate'))
    await page.waitForSelector('[data-design-shield]', { visible: true })
  }

  async function clickAt(frame: BrowserFrame, selector: string, modifier?: 'Shift' | 'Alt') {
    const { x, y } = await location(frame, selector)
    if (modifier) await page.keyboard.down(modifier)
    try {
      await page.mouse.click(x, y)
    } finally {
      if (modifier) await page.keyboard.up(modifier)
    }
  }

  async function pick(frame: BrowserFrame, selector: string) {
    await clickAt(frame, selector)
    await page.waitForSelector(field, { visible: true })
  }

  async function addBatch(frame: BrowserFrame, selector: string, comment: string, first = false) {
    await pick(frame, selector)
    if (first) {
      await page.click('[role="switch"]')
      await page.focus(field)
    }
    await page.keyboard.type(comment)
    await page.keyboard.press('Enter')
    await page.waitForSelector(field, { hidden: true })
  }

  const sent = () => page.evaluate(() => (window as unknown as Fixture).designSends)
  const draft = () => page.evaluate((id) => (window as unknown as Fixture).readDesignDraft(id), canvas.id)

  it('toggles with ⌘⇧D inside the iframe, highlights a parent, and follows the Esc chain', async () => {
    const frame = await mount()
    await frame.focus('#go')
    await chord('D', true)
    await page.waitForSelector('[data-design-hint]')
    const at = await location(frame, '#go')
    await page.mouse.move(at.x, at.y)
    await page.waitForSelector('[data-design-hover="#go"]')
    await page.keyboard.press('ArrowUp')
    await page.waitForSelector('[data-design-hover="#wrap"]')
    await page.keyboard.press('ArrowDown')
    await page.waitForSelector('[data-design-hover="#go"]')
    await page.mouse.click(at.x, at.y)
    await page.waitForSelector(field)
    await page.keyboard.press('Escape')
    await page.waitForSelector(field, { hidden: true })
    expect(await page.$('[data-design-hint]')).not.toBeNull()
    await page.mouse.move(at.x + 550, at.y + 180)
    await page.mouse.down()
    await page.mouse.move(at.x + 660, at.y + 270)
    await page.waitForSelector('[data-design-region]')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.waitForSelector('[data-design-region]', { hidden: true })
    expect(await page.$('[data-design-hint]')).not.toBeNull()
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-design-hint]', { hidden: true })
  })

  it('sends the exact note and element scope, intercepting the hotspot until exit', async () => {
    const frame = await mount()
    await enter()
    await pick(frame, '#go')
    expect(await page.$('[data-proto-screen="next"]')).toBeNull()
    await page.keyboard.type('Move this')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-design-pin][data-status="sent"]')
    const [[canvasId, prompt, , attachments, scope]] = (await sent()) as [unknown[]]
    expect(canvasId).toBe(canvas.id)
    expect(prompt).toBe(
      '<button> — “Open now”: Move this\n\nElement context:\n' +
        '[1] DOM Path: #go\nPosition: top=50px, left=40px, width=160px, height=60px\n' +
        'HTML Element: <button id="go" data-doop-on="click" data-doop-action="navigate:next">Open now</button>\n' +
        'Styles: color: rgb(0, 0, 0); background-color: rgb(255, 255, 255); font-size: 16px; font-family: Arial; display: block; position: static\nFrame: Home (home)',
    )
    expect(attachments).toEqual([])
    expect(scope).toEqual({ frameId: 'home', selector: '#go' })
    await page.click(control('Exit Design Mode'))
    await frame.$eval('#go', (button) => (button as HTMLElement).click())
    await screen('next')
    expect(await page.$('[data-design-pin]')).toBeNull()
  })

  it('queues, edits and reloads pins, sends one batch and manages sent notes', async () => {
    let frame = await mount()
    await enter()
    await addBatch(frame, '#go', 'Move button', true)
    await addBatch(frame, '#title', 'Change heading')
    await page.waitForSelector(pin(1))
    await page.waitForSelector(pin(2))
    expect(await sent()).toHaveLength(0)
    await page.click(control('Exit Design Mode'))
    await page.waitForSelector(control('Send 2 to agent'))
    frame = await mount()
    await page.waitForSelector(pin(1))
    await page.click(pin(1))
    await page.waitForSelector(field)
    expect(await page.$eval(field, (input) => (input as HTMLTextAreaElement).value)).toBe('Move button')
    await page.keyboard.press('End')
    await page.keyboard.type(' left')
    await page.keyboard.press('Enter')
    await page.waitForSelector(field, { hidden: true })
    await page.click(control('Send 2 to agent'))
    await page.waitForSelector('[data-design-pin][data-status="sent"]')
    await page.waitForSelector('[data-design-hint]', { hidden: true })
    expect(await sent()).toHaveLength(1)
    expect((await sent())[0]?.[1]).toMatch(
      /^1\. <button> — “Open now”: Move button left\n2\. <h1> — “A sample heading”: Change heading\n\nElement context:/,
    )
    const persisted = await page.evaluate(
      (id) => JSON.parse(localStorage.getItem('doop.designNotes.' + id)!).notes,
      canvas.id,
    )
    expect(persisted).toEqual(
      expect.arrayContaining([expect.objectContaining({ cardId: 'annotation-card', status: 'sent' })]),
    )
    await page.click(control('Annotation queue'))
    const queue = '[data-design-queue]'
    await page.click(`${queue} [data-design-queue-note="sent"]:first-child ${control('Resolve')}`)
    await page.waitForSelector(pin(1), { hidden: true })
    await page.click(`${queue} label:has(input[type="checkbox"])`)
    await page.waitForSelector('[data-design-queue-note="resolved"]')
    await page.click(`${queue} ${control('Remove annotation 2')}`)
    await page.waitForSelector(pin(2), { hidden: true })
    expect(await frame.$('#go')).not.toBeNull()
  })

  it('follows scroll and preserves the last location of a missing anchor', async () => {
    const frame = await mount()
    await enter()
    await addBatch(frame, '#go', 'Move button', true)
    await page.waitForSelector(pin(1))
    const top = () => page.$eval(pin(1), (el) => el.getBoundingClientRect().top)
    const original = await top()
    await frame.evaluate(() => window.scrollTo(0, 28))
    await page.waitForFunction(
      (y) => document.querySelector('[data-design-pin]')!.getBoundingClientRect().top < y - 20,
      {},
      original,
    )
    const scrolled = await top()
    await page.evaluate(
      (html) => (window as unknown as Fixture).editFrame('home', html.replace(/<button.*?<\/button>/, '')),
      canvas.frames[0]!.html,
    )
    await page.waitForFunction(() =>
      document.querySelector('[data-design-pin]')?.getAttribute('title')?.includes('Element not found'),
    )
    expect(await top()).toBeCloseTo(scrolled, 0)
  })

  it('selects multiple elements, marks regions, and appends both chat shortcuts', async () => {
    const frame = await mount()
    await page.evaluate((id) => (window as unknown as Fixture).writeDesignDraft(id, 'Existing draft'), canvas.id)
    await enter()
    await pick(frame, '#go')
    await clickAt(frame, '#title', 'Shift')
    await page.waitForFunction(() => document.querySelectorAll('[data-design-selection]').length === 2)
    expect(await page.$eval('[data-design-token]', (el) => el.textContent)).toBe('Selected <button>, plus 1 more')
    await page.keyboard.type('Match both')
    await chord('l')
    await page.waitForSelector(field, { hidden: true })
    expect(await draft()).toMatch(/^Existing draft\n\n<button> — “Open now” \+ <h1> — “A sample heading”: Match both/)
    await enter()
    await clickAt(frame, '#go', 'Alt')
    await page.waitForSelector('[data-design-hint]', { hidden: true })
    expect(await draft()).toMatch(/Frame: Home \(home\)\n\n<button> — “Open now”\n\nElement context:/)
    await enter()
    const at = await page.$eval('[data-design-shield]', (el) => {
      const rect = el.getBoundingClientRect()
      return { x: rect.left + rect.width * 0.65, y: rect.top + rect.height * 0.1 }
    })
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 140, at.y + 80, { steps: 4 })
    await page.mouse.up()
    await page.waitForSelector('[data-design-region]')
    await page.waitForSelector(field)
    expect(await page.$eval('[data-design-token]', (el) => el.textContent)).toMatch(/^Region \d+ × \d+$/)
  })

  it.each(['view', 'comment'] as const)('hides editing controls from %s viewers', async (role) => {
    await mount({ ...canvas, role }, true)
    await chord('D', true)
    expect(await page.$(control('Annotate'))).toBeNull()
    expect(await page.$('[data-design-hint]')).toBeNull()
    expect(await page.$(capsule)).toBeNull()
  })

  it('expands and collapses the capsule, keeping the side-panel draft, pending count and per-canvas state', async () => {
    const frame = await mount()
    await page.waitForSelector(`${capsule}[data-chat-state="collapsed"]`)
    await page.click(`${capsule} ${control('Ask Doop…')}`)
    await page.waitForSelector(chatField)
    await page.keyboard.type('Keep this draft')
    expect(await draft()).toBe('Keep this draft')
    await page.keyboard.press('Escape')
    await page.waitForSelector(chatField)
    await page.keyboard.press('Escape')
    await page.waitForSelector(`${capsule}[data-chat-state="collapsed"]`)
    await chord('/')
    await page.waitForSelector(chatField)
    expect(await page.$eval(chatField, (el) => (el as HTMLTextAreaElement).value)).toBe('Keep this draft')
    const outside = await location(frame, '#title')
    await page.mouse.click(outside.x, outside.y)
    await page.waitForSelector(chatField, { hidden: true })
    await chord('l')
    await page.waitForSelector(chatField)
    await enter()
    await page.waitForSelector(chatField, { hidden: true })
    await addBatch(frame, '#go', 'Move button', true)
    await page.click(`${capsule} ${control('1 pending')}`)
    await page.waitForSelector('[data-design-queue]')
    await page.keyboard.press('Escape')
    await page.click(control('Exit Design Mode'))
    await chord('/')
    await page.waitForSelector(chatField)
    expect(await draft()).toBe('Keep this draft')
    await mount()
    await page.waitForSelector(chatField)
    expect(await page.$(`${capsule} [data-preview-chat-pending]`)).not.toBeNull()
  })

  it('shows the target, agent reply and working, sending, sent and error states', async () => {
    const frame = await mount(canvas, true)
    await page.evaluate(() => {
      const app = window as unknown as Fixture
      app.setDesignTasks([
        {
          id: 'done',
          agentName: 'Doop',
          color: '',
          status: 'Original prompt',
          queuedBy: 'Test',
          startedAt: 1,
          endedAt: 2,
          reply: 'I updated the header.',
        },
        { id: 'working', agentName: 'Doop', color: '', status: 'Current task', startedAt: 3 },
      ])
      app.designSendDelay = 350
    })
    await page.waitForSelector(`${capsule} [aria-label="Agent working"]`)
    await enter()
    await clickAt(frame, '#go', 'Alt')
    await page.waitForSelector('[data-preview-chat-scope]')
    expect(await page.$eval('[data-preview-chat-reply]', (el) => el.textContent)).toBe('I updated the header.')
    expect(await page.$(control('Open chat'))).toBeNull()
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-preview-chat-send="busy"]')
    await page.waitForSelector('[data-preview-chat-send="sent"]')
    expect((await sent())[0]?.[4]).toEqual({ frameId: 'home', selector: '#go' })
    expect(await draft()).toBe('')
    expect(await page.$('[data-preview-chat-scope]')).toBeNull()
    await page.evaluate(() => {
      ;(window as unknown as Fixture).designSendError = 'Test send failure'
    })
    await page.type(chatField, 'Keep on failure')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-preview-chat-send="error"]')
    expect(await draft()).toBe('Keep on failure')
  })

  it.runIf(process.env.DOOP_DESIGN_SHOTS === '1')(
    'captures the design mode states at 1440 × 960',
    { timeout: 90_000 },
    async () => {
      await page.setViewport({ width: 1440, height: 960 })
      const origin = 'http://127.0.0.1:8747/'
      let html: string
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(3000) })
        if (!response.ok) throw new Error(String(response.status))
        html = (await response.text()).replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}<base href="${origin}">`)
        console.info('Design Mode screenshots: local site', origin)
      } catch {
        html = (await readFile('tests/fixtures/prototype.html', 'utf8')).replace(
          /<script type="module">[\s\S]*?<\/script>/,
          canvas.frames[0]!.html,
        )
        console.info('Design Mode screenshots: tests/fixtures/prototype.html fallback')
      }
      const data = { ...canvas, frames: [{ ...canvas.frames[0]!, width: 1440, height: 900, html }, canvas.frames[1]!] }
      const dir = join(homedir(), 'doop-element-comments')
      await mkdir(dir, { recursive: true })
      const shot = (name: string) => page.screenshot({ path: join(dir, `${name}.png`) })
      const frame = await mount(data)
      await frame.evaluate(() => document.fonts.ready.then(() => true))
      await shot('dm-01-off-annotate-button')
      await shot('chat-01-capsule-collapsed')
      await enter()
      await shot('dm-02-on-hint-row')
      const candidates = await frame.evaluate(() => {
        const viewport = document.documentElement.clientHeight
        return [...document.querySelectorAll('h1, h2, a[href], button')].flatMap((el) => {
          const r = el.getBoundingClientRect()
          const center = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          if (
            r.width < 45 ||
            r.height < 18 ||
            r.top < 30 ||
            r.bottom > viewport - 50 ||
            !center ||
            !el.contains(center)
          )
            return []
          return [{ x: r.left + r.width / 2, y: r.top + r.height / 2 }]
        })
      })
      const first = candidates[0]!
      const second = candidates.find((target) => Math.abs(target.y - first.y) > 60 && target.x < 950) ?? candidates[1]!
      const move = async (point: { x: number; y: number }) => {
        const position = await page.$eval(
          '[data-design-shield]',
          (el, point) => {
            const rect = el.getBoundingClientRect()
            return { x: rect.left + (point.x * rect.width) / 1440, y: rect.top + (point.y * rect.height) / 900 }
          },
          point,
        )
        await page.mouse.move(position.x, position.y)
        return position
      }
      const one = await move(first)
      await page.waitForSelector('[data-design-hover]')
      await shot('dm-03-hover-ring')
      await page.mouse.click(one.x, one.y)
      await page.waitForSelector(field)
      await page.keyboard.type('Give this more breathing room.')
      await shot('dm-04-note-card')
      const two = await move(second)
      await page.keyboard.down('Shift')
      await page.mouse.click(two.x, two.y)
      await page.keyboard.up('Shift')
      await page.waitForFunction(() => document.querySelectorAll('[data-design-selection]').length === 2)
      await shot('dm-05-multi-select')
      await page.click('[role="switch"]')
      await page.focus(field)
      await page.keyboard.press('Enter')
      await page.waitForSelector(pin(1))
      await move({ x: 820, y: 440 })
      await page.mouse.down()
      await move({ x: 1140, y: 620 })
      await page.mouse.up()
      await page.waitForSelector('[data-design-region]')
      await page.keyboard.type('Align the elements in this area.')
      await shot('dm-06-region')
      await page.keyboard.press('Enter')
      await page.waitForSelector(pin(2))
      await shot('dm-07-pins-batch-send-pill')
      await shot('chat-02-capsule-pending-badge')
      await page.click(control('2 pending; show details'))
      await page.waitForSelector('[data-design-queue]')
      await shot('dm-08-queue-list')
      await mount(data)
      await page.waitForSelector(pin(2))
      await shot('dm-09-after-reload-pins')
      await page.click(control('Send 2 to agent'))
      await page.waitForSelector('[data-design-pin][data-status="sent"]')
      await page.click(control('Annotation queue'))
      await page.waitForSelector('[data-design-queue-note="sent"]')
      await shot('dm-10-sent-dimmed')
      await page.keyboard.press('Escape')
      await page.evaluate(() => {
        const app = window as unknown as Fixture
        app.setDesignTasks([
          {
            id: 'done',
            agentName: 'Doop',
            color: '',
            status: 'Original prompt',
            queuedBy: 'Test',
            startedAt: 1,
            endedAt: 2,
            reply: 'I reviewed the first screen. Tell me what you would like to adjust next.',
          },
        ])
        app.designSendDelay = 1000
      })
      await page.click(`${capsule} ${control('Ask Doop…')}`)
      await page.waitForSelector(chatField)
      await page.type(chatField, 'Tighten the spacing around the introduction.')
      await shot('chat-03-capsule-expanded')
      await page.keyboard.press('Enter')
      await page.waitForSelector('[data-preview-chat-send="busy"]')
      await shot('chat-04-capsule-sending-or-sent')
      await page.waitForSelector('[data-preview-chat-send="sent"]')
      for (const width of [768, 375]) {
        await page.setViewport({ width, height: 760 })
        await shot(`chat-responsive-${width}`)
        await page.click(control('Annotate'))
        await page.waitForSelector('[data-design-hint]')
        await shot(`dm-responsive-${width}`)
        await page.click(control('Exit Design Mode'))
        await page.click(`${capsule} ${control('Ask Doop…')}`)
        await page.waitForSelector(chatField)
      }
    },
  )
})
