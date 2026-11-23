import { agentPromptText, readContextPrompt } from '../shared/uiElementContext'
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
  prototypeInteractivity: WeakMap<Window, boolean>
  seed: (canvas: Canvas) => void
  play: (frameId: string) => void
  playSynced: (frameId: string) => void
  mockDesignSends: () => void
  showDesignChat: () => void
  designSends: unknown[][]
  designUploads: { name: string; type: string; width: number; height: number }[]
  designSendDelay?: number
  designSendError?: string
  designCropHasMarkup: boolean
  readDesignDraft: (canvasId: string) => string
  writeDesignDraft: (canvasId: string, text: string) => void
  editFrame: (id: string, html: string) => void
  setDesignTasks: (tasks: AgentTask[]) => void
}

const address = '[data-preview-toolbar] input[role=combobox]'
const field = '[data-design-note-field]'
const capsule = '[data-preview-chat]'
const chatField = '[data-preview-chat-field]'
const control = (label: string) => `button[aria-label="${label}"]`
const secondClick = { button: 'left', clickCount: 2 } as const
const pin = (number: number) => `[data-design-pin="${number}"]`

describe.skipIf(!findBrowserPath())('prototype design mode', { timeout: 35_000 }, () => {
  const pages = pagePerTest()
  let page: Page
  let firstMount: boolean

  beforeEach(async () => {
    page = await pages.open()
    firstMount = true
    await page.setViewport({ width: 1000, height: 760, deviceScaleFactor: 1 })
  })

  async function mount(data = canvas, synced = false, mac = false) {
    await page.goto(fixtureUrl('prototype.html'))
    await page.waitForFunction(() => (window as unknown as Fixture).fixtureReady)
    await page.evaluate(
      (data, synced, reset, mac) => {
        const fixture = window as unknown as Fixture
        if (reset) localStorage.clear()
        if (mac) Object.assign(window, { __DOOP_DESKTOP__: '0.14.0', __DOOP_DESKTOP_TRAFFIC_LIGHTS__: true })
        fixture.mockDesignSends()
        fixture.seed(data)
        if (synced) fixture.playSynced(data.frames[0]!.id)
        else fixture.play(data.frames[0]!.id)
      },
      data,
      synced,
      firstMount,
      mac,
    )
    firstMount = false
    const id = data.frames[0]!.id
    const frame = await screen(id)
    await waitForInteractivity(id, true)
    return frame
  }

  async function screen(id: string): Promise<BrowserFrame> {
    const iframe = await page.waitForSelector(`iframe[data-doop-proto-frame="${id}"]`, { visible: true })
    const frame = await iframe!.contentFrame()
    await frame!.waitForSelector('body > :not(script)', { visible: true })
    return frame!
  }

  // The player's DOM changes before the sandboxed runtime acknowledges the switch.
  async function waitForInteractivity(id: string, enabled: boolean) {
    await page.waitForFunction(
      (id, enabled) => {
        const iframe = document.querySelector<HTMLIFrameElement>(`iframe[data-doop-proto-frame="${CSS.escape(id)}"]`)
        const win = iframe?.contentWindow
        return !!win && (window as unknown as Fixture).prototypeInteractivity.get(win) === enabled
      },
      {},
      id,
      enabled,
    )
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

  async function enter(id = 'home') {
    await page.click(control('Annotate'))
    await page.waitForSelector('[data-design-shield]', { visible: true })
    await waitForInteractivity(id, false)
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

  async function beginTextEdit(frame: BrowserFrame) {
    const { x, y } = await location(frame, '#title')
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.up()
    // The real first click can open its note before the second mouse press.
    await page.waitForSelector(`${field}:focus`)
    await page.mouse.down(secondClick)
    await page.mouse.up(secondClick)
    await frame.waitForSelector('#title[contenteditable="plaintext-only"]:focus')
    await page.waitForFunction(() =>
      document.querySelector('[data-design-hint]')?.textContent?.includes('Return to save'),
    )
  }

  async function capture(name: string) {
    if (process.env.DOOP_DESIGN_SHOTS !== '1') return
    const dir = join(homedir(), 'doop-element-comments')
    await mkdir(dir, { recursive: true })
    await page.screenshot({ path: join(dir, `${name}.png`) })
  }

  async function pick(frame: BrowserFrame, selector: string) {
    await clickAt(frame, selector)
    await page.waitForSelector(field, { visible: true })
    expect(await page.$('[role="switch"]')).toBeNull()
  }

  async function addBatch(frame: BrowserFrame, selector: string, comment: string, first = false) {
    await pick(frame, selector)
    await page.keyboard.type(comment)
    if (first) {
      await page.click('[role="switch"]')
      await page.focus(field)
    }
    await page.keyboard.press('Enter')
    await page.waitForSelector(field, { hidden: true })
  }

  const sent = () => page.evaluate(() => (window as unknown as Fixture).designSends)
  const draft = () => page.evaluate((id) => (window as unknown as Fixture).readDesignDraft(id), canvas.id)

  it('keeps full-window prototype controls outside the macOS traffic lights', async () => {
    await mount(canvas, false, true)
    const toolbar = '[data-preview-toolbar]'
    expect(await page.$eval(toolbar, (el) => getComputedStyle(el).paddingLeft)).toBe('76px')
    await enter()
    expect(await page.$eval(toolbar, (el) => getComputedStyle(el).paddingLeft)).toBe('76px')
  })

  it('toggles with ⌘⇧D inside the iframe, highlights a parent, and follows the Esc chain', async () => {
    const frame = await mount()
    await frame.focus('#go')
    await chord('D', true)
    await page.waitForSelector('[data-preview-toolbar] [data-design-hint]', { visible: true })
    expect(await page.$(address)).toBeNull()
    expect(await page.$eval('[data-design-hint]', (el) => el.textContent)).toBe(
      'Click or drag to select · Hold Space to use page · ↑↓ to adjust',
    )
    const at = await location(frame, '#go')
    await page.mouse.move(at.x, at.y)
    await page.waitForSelector('[data-design-hover="#go"]')
    expect(await page.$eval('[data-design-hover="#go"]', (el) => el.textContent)).toBe('button')
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
    await page.waitForSelector(address)
  })

  it('edits a text-only heading in place, queues it with batch off, reapplies after reload and clears it', async () => {
    await page.setViewport({ width: 1440, height: 960 })
    let frame = await mount()
    await enter()
    await pick(frame, '#title')
    expect(await page.$eval('[data-design-hint] span', (el) => el.textContent)).toBe(
      'Double-click to edit text · Hold Space to use page · Esc to cancel',
    )
    await beginTextEdit(frame)
    expect(await frame.evaluate(() => getSelection()?.toString())).toBe('A sample heading')
    await page.keyboard.type('Edited heading')
    await capture('dm-12-text-edit-active')
    await page.keyboard.press('Enter')
    await page.waitForSelector(pin(1))
    await frame.waitForFunction(() => document.querySelector('#title')?.textContent === 'Edited heading')
    expect(await sent()).toEqual([])
    await page.click(control('1 pending; show details'))
    await page.waitForSelector('[data-design-queue-note="pending"]')
    expect(await page.$eval('[data-design-queue-note="pending"]', (el) => el.textContent)).toContain(
      '“Edited heading”T',
    )
    await capture('dm-13-text-edit-queued')
    frame = await mount()
    await frame.waitForFunction(() => document.querySelector('#title')?.textContent === 'Edited heading')
    await page.click(control('1 pending; show details'))
    await page.click(control('Clear All'))
    await frame.waitForFunction(() => document.querySelector('#title')?.textContent === 'A sample heading')
  })

  it('reverts a text edit before closing the note and hands a subsequent edit to chat with ⌘L', async () => {
    const frame = await mount()
    await enter()
    await pick(frame, '#title')
    await beginTextEdit(frame)
    await page.keyboard.type('Discard me')
    await page.keyboard.press('Escape')
    await page.waitForSelector(field, { visible: true })
    expect(await frame.$eval('#title', (el) => el.textContent)).toBe('A sample heading')
    await page.keyboard.press('Escape')
    await page.waitForSelector(field, { hidden: true })
    const wrapper = await location(frame, '#wrap', 0.95, 0.95)
    await page.mouse.click(wrapper.x, wrapper.y)
    await page.waitForSelector(`${field}:focus`)
    await page.mouse.down(secondClick)
    await page.mouse.up(secondClick)
    await page.waitForSelector(`${field}:focus`)
    expect(await frame.$('[contenteditable="plaintext-only"]')).toBeNull()
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-design-shield]:focus')
    await beginTextEdit(frame)
    await page.keyboard.type('Send later')
    await chord('l')
    await page.waitForSelector(chatField)
    await page.waitForSelector(`${capsule} [data-context-chip]`)
    expect(await draft()).toBe('')
    expect(await sent()).toEqual([])
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-preview-chat-send="sent"]')
    const prompt = String((await sent())[0]?.[1])
    const change = 'change text to “Send later” (was “A sample heading”)'
    expect(agentPromptText(prompt)).toContain(change)
    expect(readContextPrompt(prompt).contexts[0]?.changes).toEqual([change])
    expect((await sent())[0]?.[3]).toEqual(['Design note 1'])
    expect(await page.$(control('Send 1 to agent'))).toBeNull()
  })

  it('previews CSS on the heading, keeps CSS-only pending edits and reverts them on delete', async () => {
    await page.setViewport({ width: 1440, height: 960 })
    let frame = await mount()
    await enter()
    await pick(frame, '#title')
    const selection = '[data-design-selection]'
    const card = '[data-design-card]'
    const previousHeight = await page.$eval(selection, (el) => el.getBoundingClientRect().height)
    const previousTop = await page.$eval(card, (el) => el.getBoundingClientRect().top)
    const original = await frame.$eval('#title', (el) => getComputedStyle(el).color)
    await page.click(control('Edit CSS properties'))
    const filter = 'input[aria-label="Filter properties"]'
    const color = 'input[aria-label="color"]'
    await page.waitForSelector(filter, { visible: true })
    await page.type(filter, 'color')
    await page.waitForSelector(color, { visible: true })
    await page.locator(filter).fill('font-size')
    const fontSize = 'input[aria-label="font-size"]'
    await page.locator(fontSize).fill('48px')
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#title')!).fontSize === '48px')
    const top = await location(frame, '#title', 0, 0)
    const bottom = await location(frame, '#title', 0, 1)
    const expectedHeight = bottom.y - top.y
    await page.waitForFunction(
      (selection, card, height, top) => {
        const ring = document.querySelector(selection)?.getBoundingClientRect()
        const note = document.querySelector(card)?.getBoundingClientRect()
        return !!ring && !!note && Math.abs(ring.height - height) < 1 && note.top > top
      },
      {},
      selection,
      card,
      expectedHeight,
      previousTop,
    )
    expect(expectedHeight).toBeGreaterThan(previousHeight)
    await page.locator(filter).fill('color')
    await capture('dm-14-css-inspector')
    await page.focus(color)
    await page.$eval(color, (el) => (el as HTMLInputElement).select())
    await page.keyboard.type('#da1376')
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#title')!).color === 'rgb(218, 19, 118)')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-design-css-inspector]', { hidden: true })
    expect(await frame.$eval('#title', (el) => getComputedStyle(el).color)).toBe('rgb(218, 19, 118)')
    await page.click('[role="switch"]')
    await page.click(control('Add to stack'))
    await page.waitForSelector(pin(1))
    await page.click(control('1 pending; show details'))
    await page.waitForSelector('[data-design-queue-note="pending"]')
    expect(await page.$eval('[data-design-queue-note="pending"]', (el) => el.textContent)).toContain('CSS changes')
    await capture('dm-15-css-edited-note')
    expect(await sent()).toEqual([])
    frame = await mount()
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#title')!).color === 'rgb(218, 19, 118)')
    await page.click(control('1 pending; show details'))
    await page.click(control('Remove annotation 1'))
    await frame.waitForFunction(
      (original) => getComputedStyle(document.querySelector('#title')!).color === original,
      {},
      original,
    )
    expect(await frame.$eval('#title', (el) => el.getAttribute('style'))).toBeNull()
  })

  it('sends CSS-only notes with batch off and restores inline styles on exit', async () => {
    const frame = await mount()
    await enter()
    const changeColor = async () => {
      await pick(frame, '#title')
      await page.click(control('Edit CSS properties'))
      const filter = 'input[aria-label="Filter properties"]'
      await page.waitForSelector(filter)
      await page.type(filter, 'color')
      const color = 'input[aria-label="color"]'
      await page.focus(color)
      await page.$eval(color, (el) => (el as HTMLInputElement).select())
      await page.keyboard.type('red')
      await frame.waitForFunction(() => getComputedStyle(document.querySelector('#title')!).color === 'rgb(255, 0, 0)')
    }
    await changeColor()
    await page.click(control('Exit Design Mode'))
    await frame.waitForFunction(() => !document.querySelector('#title')?.hasAttribute('style'))
    await enter()
    await changeColor()
    await page.keyboard.press('Escape')
    await page.click(control('Send note'))
    await page.waitForSelector('[data-design-pin][data-status="sent"]')
    expect((await sent())[0]?.[1]).toContain('CSS edits — color: rgb(0, 0, 0) → red')
  })

  it('draws outside the region, undoes a stroke, cancels another and saves an ellipse with the pin', async () => {
    await page.setViewport({ width: 1440, height: 960 })
    const frame = await mount()
    await enter()
    const at = await page.$eval('[data-design-shield]', (el) => {
      const rect = el.getBoundingClientRect()
      return { x: rect.left + rect.width * 0.61, y: rect.top + rect.height * 0.25 }
    })
    const draw = async (x: number, y: number, dx: number, dy: number) => {
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + dx, y + dy, { steps: 5 })
      await page.mouse.up()
    }
    await draw(at.x, at.y, 190, 140)
    await page.waitForSelector('[data-design-region]')
    const tools = '[data-design-markup-tool]'
    expect(await page.$$eval(tools, (buttons) => buttons.map((button) => button.getAttribute('aria-label')))).toEqual([
      'Draw',
      'Ellipse',
      'Rectangle',
      'Arrow',
    ])
    expect(await page.$(`${tools}[aria-pressed="true"]`)).toBeNull()
    await draw(at.x + 15, at.y + 20, 10, 5)
    expect(await page.$('[data-design-markup]')).toBeNull()
    await capture('dm-16-markup-tools')
    await page.click(control('Arrow'))
    await draw(at.x + 105, at.y + 30, -140, 40)
    await page.waitForSelector('[data-markup-status="draft"] [data-markup-tool="arrow"]')
    await chord('z')
    await page.waitForSelector('[data-design-markup]', { hidden: true })
    await page.mouse.move(at.x + 15, at.y + 20)
    await page.mouse.down()
    await page.mouse.move(at.x + 130, at.y + 50, { steps: 4 })
    await page.waitForSelector('[data-markup-tool="arrow"]')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.waitForSelector('[data-design-markup]', { hidden: true })
    expect(await page.$(field)).not.toBeNull()
    await page.click(control('Ellipse'))
    await draw(at.x + 30, at.y + 25, 124, 70)
    await page.waitForSelector('[data-markup-tool="ellipse"]')
    await page.click('[role="switch"]')
    await page.click(control('Add to stack'))
    await page.waitForSelector(pin(1))
    const ellipse = '[data-markup-status="pending"] [data-markup-tool="ellipse"]'
    await page.waitForSelector(ellipse)
    await capture('dm-17-markup-saved')
    const priorTop = await page.$eval(ellipse, (el) => el.getBoundingClientRect().top)
    await frame.evaluate(() => window.scrollTo(0, 40))
    await page.waitForFunction(
      (selector, top) => document.querySelector(selector)!.getBoundingClientRect().top < top - 20,
      {},
      ellipse,
      priorTop,
    )
    await mount()
    await enter()
    await page.waitForSelector(ellipse)
    await page.click(control('Send 1 to agent'))
    await page.waitForSelector(address)
    expect(agentPromptText(String((await sent())[0]?.[1]))).toMatch(
      /^Screenshot region \d+ × \d+ with markup: 1 ellipse$/,
    )
    expect((await sent())[0]?.[3]).toEqual(['Design note 1'])
    expect(await page.evaluate(() => (window as unknown as Fixture).designCropHasMarkup)).toBe(true)
  })

  it('temporarily re-enables page clicks while Space is held and resumes picking after iframe keyup', async () => {
    const frame = await mount()
    await enter()
    await waitForInteractivity('home', false)
    await page.keyboard.down('Space')
    await page.waitForSelector('[data-design-shield]', { hidden: true })
    await waitForInteractivity('home', true)
    await clickAt(frame, '#go')
    const next = await screen('next')
    await next.$eval('h1', (el) => {
      el.tabIndex = -1
      el.focus()
    })
    await page.keyboard.up('Space')
    await page.waitForSelector('[data-design-shield]', { visible: true })
    await pick(next, 'h1')
    await page.keyboard.type('Keep this')
    expect(await page.$eval(field, (el) => (el as HTMLTextAreaElement).value)).toBe('Keep this')
  })

  it('sends the exact note and element scope, intercepting the hotspot until exit', async () => {
    const frame = await mount()
    await enter()
    const at = await location(frame, '#go')
    await page.mouse.move(at.x, at.y)
    await page.waitForSelector('[data-design-hover="#go"]', { visible: true })
    await page.mouse.click(at.x, at.y, { delay: 120 })
    await page.waitForSelector(field, { visible: true })
    expect(await page.$('[data-design-region]')).toBeNull()
    expect(await page.$('[data-proto-screen="next"]')).toBeNull()
    await page.keyboard.type('Move this')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-design-pin][data-status="sent"]')
    const [[canvasId, prompt, , attachments, scope]] = (await sent()) as [unknown[]]
    expect(canvasId).toBe(canvas.id)
    expect(agentPromptText(String(prompt))).toBe(
      '<button> — “Open now”: Move this\n\nElement context:\n' +
        '[1] DOM Path: #go\nPosition: top=50px, left=40px, width=160px, height=60px\n' +
        'HTML Element: <button id="go" data-doop-on="click" data-doop-action="navigate:next">Open now</button>\n' +
        'Styles: color: rgb(0, 0, 0); background-color: rgb(255, 255, 255); font-size: 16px; font-family: Arial; display: block; position: static\nFrame: Home (home)',
    )
    expect(attachments).toEqual(['Design note 1'])
    expect(scope).toEqual({ frameId: 'home', selector: '#go' })
    await waitForInteractivity('home', false)
    await page.click(control('Exit Design Mode'))
    await page.waitForSelector(address, { visible: true })
    await waitForInteractivity('home', true)
    await clickAt(frame, '#go')
    const next = await screen('next')
    expect(await next.$eval('h1', (el) => el.textContent)).toBe('The second screen')
    expect(await page.$('[data-design-pin]')).toBeNull()
  })

  it('opens the note on mouseup when the pointerup is lost', async () => {
    await page.evaluateOnNewDocument(() => {
      window.addEventListener('pointerup', (event) => event.stopImmediatePropagation(), { capture: true })
    })
    const frame = await mount()
    await enter()
    const at = await location(frame, '#go')
    await page.mouse.click(at.x, at.y, { delay: 120 })
    await page.waitForSelector(field, { visible: true })
    expect(await page.$('[data-design-region]')).toBeNull()
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
    await page.waitForSelector(address)
    expect(await page.$(pin(1))).toBeNull()
    await page.waitForSelector(control('Send 2 to agent'))
    expect(await page.$eval(control('2 pending; show details'), (el) => el.getAttribute('title'))).toBe(
      'Show pending annotations',
    )
    frame = await mount()
    await chord('D', true)
    await page.waitForSelector(pin(1))
    await page.click(pin(1))
    await page.waitForSelector(field)
    expect(await page.$eval(field, (input) => (input as HTMLTextAreaElement).value)).toBe('Move button')
    await page.keyboard.press('End')
    await page.keyboard.type(' left')
    await page.keyboard.press('Enter')
    await page.waitForSelector(field, { hidden: true })
    await page.click(control('Send 2 to agent'))
    await page.waitForSelector(address)
    expect(await page.$('[data-design-pin]')).toBeNull()
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
    await enter()
    await page.waitForSelector('[data-design-pin][data-status="sent"]')
    await page.click(control('Annotation queue'))
    const queue = '[data-design-queue]'
    await page.waitForSelector(`${queue} ${control('Clear All')}:disabled`, { visible: true })
    await page.click(`${queue} [data-design-queue-note="sent"]:first-child ${control('Resolve')}`)
    await page.waitForSelector(pin(1), { hidden: true })
    await page.click(`${queue} label:has(input[type="checkbox"])`)
    await page.waitForSelector('[data-design-queue-note="resolved"]')
    await page.click(`${queue} ${control('Remove annotation 2')}`)
    await page.waitForSelector(pin(2), { hidden: true })
    expect(await frame.$('#go')).not.toBeNull()
  })

  it('summarizes a multi-element edit in the split Send popover and clears it', async () => {
    const frame = await mount()
    await enter()
    await pick(frame, '#go')
    await clickAt(frame, '#title', 'Shift')
    await page.waitForFunction(() => document.querySelectorAll('[data-design-selection]').length === 2)
    const comment = 'Align both elements and keep the left edges level when the heading wraps onto a second line.'
    await page.keyboard.type(comment)
    await page.click('[role="switch"]')
    await page.click(control('Add to stack'))
    await page.waitForSelector(pin(1))
    await page.click(control('1 pending; show details'))
    const queue = '[data-preview-toolbar] [data-design-queue]'
    const clear = `${queue} header ${control('Clear All')}`
    await page.waitForSelector(clear, { visible: true })
    expect(await page.$eval(`${queue} header h2`, (el) => el.textContent)).toBe('1 edits')
    expect(await page.$eval(`${queue} li`, (el) => el.textContent)).toContain(`button“Open now”${comment}+1`)
    const layout = await page.$eval(
      queue,
      (el, comment) => {
        const header = el.querySelector('header')!
        const heading = header.querySelector('h2')!.getBoundingClientRect()
        const clear = header.querySelector('button')!
        const action = clear.getBoundingClientRect()
        const row = el.querySelector('li')!
        const text = Array.from(row.querySelectorAll('span')).find((span) => span.textContent === comment)!
        const bounds = el.getBoundingClientRect()
        return {
          clearVisible: clear.textContent === 'Clear All' && action.left > heading.right && action.right < bounds.right,
          rowFits:
            row.getBoundingClientRect().right < bounds.right &&
            row.scrollWidth === row.clientWidth &&
            el.scrollWidth === el.clientWidth,
          commentTruncates:
            text.clientWidth > 0 &&
            text.scrollWidth > text.clientWidth &&
            getComputedStyle(text).textOverflow === 'ellipsis',
        }
      },
      comment,
    )
    expect(layout).toEqual({ clearVisible: true, rowFits: true, commentTruncates: true })
    await page.click(clear)
    await page.waitForSelector(queue, { hidden: true })
    expect(await page.$(pin(1))).toBeNull()
    expect(await page.$(control('Send 1 to agent'))).toBeNull()
    expect(await page.$('[data-design-hint]')).not.toBeNull()
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
    expect(await page.$$eval('[data-design-token] span', (els) => els.map((el) => el.textContent))).toEqual([
      'button',
      'h1',
    ])
    expect(await page.$eval('[data-design-hint] span', (el) => el.textContent)).toBe(
      'Hold Space to use page · Esc to cancel',
    )
    await page.keyboard.type('Match both')
    await chord('l')
    await page.waitForSelector(field, { hidden: true })
    expect(await draft()).toBe('Existing draft\n\nMatch both')
    expect(await page.$$(`${capsule} [data-context-chip]`)).toHaveLength(2)
    await enter()
    await clickAt(frame, '#go', 'Alt')
    await page.waitForSelector('[data-design-hint]', { hidden: true })
    expect(await draft()).toBe('Existing draft\n\nMatch both')
    expect(await page.$$(`${capsule} [data-context-chip]`)).toHaveLength(3)
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
    const grabber = await page.$eval('[data-preview-chat-handle]', (el) => {
      const { width, height } = el.querySelector('span')!.getBoundingClientRect()
      return { width, height, text: el.textContent }
    })
    expect(grabber).toEqual({ width: 70, height: 5, text: '' })
    await page.click(`${capsule} ${control('Ask Doop…')}`)
    await page.waitForSelector(chatField)
    expect(await page.$eval(chatField, (el) => el.getAttribute('placeholder'))).toBe(
      'Create, plan or research… @ to attach, / for skills',
    )
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
    await page.hover('[data-preview-chat-handle]')
    await page.waitForSelector(chatField)
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
    await page.waitForSelector('[data-preview-chat] [data-context-chip]')
    expect(await page.$eval('[data-preview-chat-reply]', (el) => el.textContent)).toBe('I updated the header.')
    expect(await page.$(control('Open chat'))).toBeNull()
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-preview-chat-send="busy"]')
    await page.waitForSelector('[data-preview-chat-send="sent"]')
    expect((await sent())[0]?.[4]).toEqual({ frameId: 'home', selector: '#go' })
    expect(await draft()).toBe('')
    expect(await page.$('[data-preview-chat] [data-context-chip]')).toBeNull()
    await page.evaluate(() => {
      ;(window as unknown as Fixture).designSendError = 'Test send failure'
    })
    await page.type(chatField, 'Keep on failure')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-preview-chat-send="error"]')
    expect(await draft()).toBe('Keep on failure')
  })

  it('puts Option-click context in a removable chip and keeps the technical brief out of the sent message', async () => {
    const frame = await mount()
    await enter()
    await clickAt(frame, '#title', 'Alt')
    const chip = `${capsule} [data-context-chip]`
    await page.waitForSelector(chip)
    expect(await page.$eval(chip, (el) => el.textContent)).toBe('<h1> A sample heading')
    expect(await draft()).toBe('')
    await page.locator(`${chip} button[aria-label^="Remove"]`).click()
    await page.waitForSelector(chip, { hidden: true })
    await enter()
    await clickAt(frame, '#title', 'Alt')
    await page.waitForSelector(chip)
    await page.type(chatField, 'Move the heading')
    const thumbnail = `${chip} [data-context-thumbnail]`
    await page.waitForFunction(
      (selector) => {
        const image = document.querySelector<HTMLImageElement>(selector)
        return image?.complete && image.naturalWidth > 0
      },
      {},
      thumbnail,
    )
    const dir = join(homedir(), 'doop-element-comments')
    if (process.env.DOOP_DESIGN_SHOTS === '1') {
      await mkdir(dir, { recursive: true })
      await page.screenshot({ path: join(dir, 'chat-06-chips-in-composer.png') })
      await page.screenshot({ path: join(dir, 'dm-18-crop-thumb-in-chip.png') })
    }
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-preview-chat-send="sent"]')
    expect((await sent())[0]?.[1]).toContain('DOM Path: #title')
    await page.evaluate(() => (window as unknown as Fixture).showDesignChat())
    const message = '[data-chat-message]'
    await page.waitForSelector(`${message} [data-context-chip]`)
    expect(await page.$eval(`${message} p`, (el) => el.textContent)).toBe('Move the heading')
    expect(await page.$eval(message, (el) => el.textContent)).not.toContain('DOM Path:')
    if (process.env.DOOP_DESIGN_SHOTS === '1')
      await page.screenshot({ path: join(dir, 'chat-07-chips-in-sent-card.png') })
  })

  it('attaches one padded PNG per queued note in annotation order', async () => {
    const frame = await mount()
    await enter()
    await addBatch(frame, '#go', 'Move button', true)
    await addBatch(frame, '#title', 'Change heading')
    await page.click(control('Send 2 to agent'))
    await page.waitForSelector('[data-preview-toolbar] input[role=combobox]')
    const payload = (await sent())[0]
    expect(payload?.[3]).toEqual(['Design note 1', 'Design note 2'])
    const uploads = await page.evaluate(() => (window as unknown as Fixture).designUploads)
    expect(uploads).toEqual(
      expect.arrayContaining([
        { name: 'Design note 1.png', type: 'image/png', width: 176, height: 76 },
        expect.objectContaining({ name: 'Design note 2.png', type: 'image/png' }),
      ]),
    )
  })

  it('dictates into the note and capsule with interim text and keeps the editor open on Escape', async () => {
    const frame = await mount()
    await page.evaluate(() => {
      class FakeRecognition extends EventTarget {
        start() {
          const result = Object.assign(new Event('result'), {
            results: [{ isFinal: false, 0: { transcript: 'make it wider' } }],
          })
          this.dispatchEvent(result)
        }
        stop() {
          this.dispatchEvent(new Event('end'))
        }
        abort() {
          this.stop()
        }
      }
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeRecognition })
    })
    await enter()
    await pick(frame, '#title')
    const mic = '[data-design-card] [data-dictate]'
    expect(await page.$(mic)).toBeNull()
    await page.keyboard.type('Please')
    await page.waitForSelector(mic)
    await page.click(mic)
    await page.waitForSelector(`${mic}[data-recording="true"]`)
    expect(await page.$eval(field, (el) => (el as HTMLTextAreaElement).value)).toBe('Please make it wider')
    if (process.env.DOOP_DESIGN_SHOTS === '1') {
      const dir = join(homedir(), 'doop-element-comments')
      await mkdir(dir, { recursive: true })
      await page.screenshot({ path: join(dir, 'dm-19-dictation-listening.png') })
    }
    await page.keyboard.press('Escape')
    await page.waitForSelector(`${mic}[aria-pressed="false"]`)
    await page.focus(field)
    await chord('l')
    await page.waitForSelector(chatField)
    const capsuleMic = `${capsule} [data-dictate]`
    await page.waitForSelector(capsuleMic)
    await page.click(capsuleMic)
    await page.waitForSelector(`${capsuleMic}[data-recording="true"]`)
    expect(await draft()).toBe('Please make it wider make it wider')
    await page.keyboard.press('Escape')
    await page.waitForSelector(`${capsuleMic}[aria-pressed="false"]`)

    await enter()
    await pick(frame, '#title')
    await page.click(control('Edit CSS properties'))
    const filter = 'input[aria-label="Filter properties"]'
    await page.waitForSelector(filter)
    await page.type(filter, 'color')
    const color = 'input[aria-label="color"]'
    await page.$eval(color, (el) => (el as HTMLInputElement).select())
    await page.keyboard.type('red')
    await page.waitForSelector(mic)
    expect(await page.$eval(field, (el) => (el as HTMLTextAreaElement).value)).toBe('')
    await page.click(mic)
    await page.waitForSelector(`${mic}[data-recording="true"]`)
    expect(await page.$eval(field, (el) => (el as HTMLTextAreaElement).value)).toBe('make it wider')
    await page.keyboard.press('Escape')
    await page.waitForSelector(`${mic}[aria-pressed="false"]`)
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
      await page.waitForSelector('[data-preview-chat-handle]', { visible: true })
      await shot('chat-05-capsule-handle')
      await enter()
      await shot('dm-02-on-hint-row')
      await shot('dm-11-hint-row-in-address')
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
      await chord('D', true)
      await page.waitForSelector(pin(2))
      await shot('dm-09-after-reload-pins')
      await page.click(control('Send 2 to agent'))
      await page.waitForSelector(address)
      await enter()
      await page.waitForSelector('[data-design-pin][data-status="sent"]')
      await page.click(control('Annotation queue'))
      await page.waitForSelector('[data-design-queue-note="sent"]')
      await shot('dm-10-sent-dimmed')
      await page.keyboard.press('Escape')
      await page.click(control('Exit Design Mode'))
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
