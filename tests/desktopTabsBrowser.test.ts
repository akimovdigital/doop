import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest, serveBuilt, type BuiltServer } from './browser'
import { freePort, startServer, type Server } from './harness'

describe.skipIf(!findBrowserPath())('desktop tab actions', () => {
  const pages = pagePerTest()
  let web: BuiltServer
  let backend: Server
  beforeAll(async () => {
    const port = await freePort()
    web = await serveBuilt({
      '/api': { target: `http://localhost:${port}` },
      '/ws': { target: `ws://localhost:${port}`, ws: true },
    })
    backend = await startServer({ PORT: String(port), BETTER_AUTH_URL: web.origin })
  }, 60_000)
  afterAll(async () => {
    await web?.close()
    backend?.stop()
  })

  it('renames inactive canvases, groups and splits tabs, and safely hands off window moves', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 900, height: 650 })
    await page.evaluateOnNewDocument(() => {
      Object.assign(window, {
        __DOOP_DESKTOP__: '0.0.9',
        __DOOP_DESKTOP_TRAFFIC_LIGHTS__: true,
        __DOOP_TAB_WINDOWS__: true,
        __TAURI__: {
          core: {
            async invoke(command: string, args: unknown) {
              if (sessionStorage.getItem('reject-window')) throw new Error('Simulated unavailable window')
              sessionStorage.setItem('test-native-command', JSON.stringify({ command, args }))
            },
          },
          opener: {
            async openUrl(url: string) {
              sessionStorage.setItem('test-external-url', url)
            },
          },
        },
      })
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async (url: string) => sessionStorage.setItem('test-clipboard', url) },
      })
    })
    await page.goto(web.origin)
    const ids = await page.evaluate(async () => {
      const signup = await fetch('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Tab tester', email: 'desktop-tabs@test.dev', password: 'password12345' }),
      })
      if (!signup.ok) throw new Error(await signup.text())
      const canvases = await Promise.all(
        ['First canvas', 'Second canvas', 'Third canvas'].map(async (name) => {
          const response = await fetch('/api/canvases', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          })
          if (!response.ok) throw new Error(await response.text())
          const { id } = (await response.json()) as { id: string }
          const frame = await fetch(`/api/canvases/${id}/frames`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: `${name} frame`,
              html: '<p>Test frame</p>',
              x: 64,
              y: 64,
              width: 220,
              height: 160,
            }),
          })
          if (!frame.ok) throw new Error(await frame.text())
          return id
        }),
      )
      return canvases
    })
    expect(ids.every(Boolean)).toBe(true)
    const [first, second, third] = ids
    for (const [id, name] of [
      [second, 'Second canvas'],
      [third, 'Third canvas'],
      [first, 'First canvas'],
    ]) {
      await page.goto(`${web.origin}/c/${id}`)
      await page.waitForFunction(
        (id, name) => document.getElementById('desktop-canvas-tab-' + id)?.getAttribute('aria-label') === name,
        {},
        id,
        name,
      )
    }
    const tab = (id: string) => '#desktop-canvas-tab-' + id
    const menu = async (id: string) => {
      await page.click(tab(id), { button: 'right' })
      await page.waitForSelector('[data-slot="context-menu-content"]')
    }
    const item = (name: string) => page.locator(`::-p-aria([name="${name}"][role="menuitem"])`)
    const field = 'input[aria-label="Rename canvas"]'
    await menu(second!)
    await page.waitForFunction(() => {
      const menu = document.querySelector('[data-slot="context-menu-content"]')
      return menu !== null && menu.getAnimations().every((animation) => animation.playState !== 'running')
    })
    const placement = await page.$eval(tab(second!), (node) => {
      const tabRect = node.getBoundingClientRect()
      const menuRect = document.querySelector('[data-slot="context-menu-content"]')!.getBoundingClientRect()
      return { below: menuRect.top >= tabRect.bottom - 3, aligned: Math.abs(menuRect.left - tabRect.left) < 6 }
    })
    expect(placement).toEqual({ below: true, aligned: true })
    await item('Rename canvas').click()
    await page.waitForFunction((field) => document.activeElement?.matches(field), {}, field)
    await page.keyboard.type('Renamed canvas')
    await page.keyboard.press('Enter')
    await page.waitForSelector(tab(second!) + '[aria-label="Renamed canvas"]')
    expect(new URL(page.url()).pathname).toBe('/c/' + first)

    await menu(second!)
    await item('Rename canvas').click()
    await page.waitForFunction((field) => document.activeElement?.matches(field), {}, field)
    await page.keyboard.type('Discard this name')
    await page.keyboard.press('Escape')
    await page.waitForSelector(field, { hidden: true })
    expect(await page.$eval(tab(second!), (node) => node.getAttribute('aria-label'))).toBe('Renamed canvas')
    await page.click(tab(first!) + '[aria-selected="true"]')
    await page.keyboard.down('Shift')
    await page.keyboard.press('F10')
    await page.keyboard.up('Shift')
    await page.waitForSelector('[data-slot="context-menu-content"]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-slot="context-menu-content"]', { hidden: true })

    await menu(second!)
    await item('Add to tab group').hover()
    expect(
      await page.$eval('[data-slot="context-menu-sub-trigger"]', (node) => node.querySelectorAll('svg').length),
    ).toBe(1)
    await item('New group').click()
    await page.locator('input[aria-label="Group name"]').fill('Editorial')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[title="Editorial"]')
    await menu(third!)
    await item('Add to tab group').hover()
    await item('Editorial').click()
    await page.reload()
    await page.waitForSelector('[title="Editorial"]')
    expect(await page.$eval(tab(second!), (node) => node.getAttribute('aria-label'))).toBe('Renamed canvas')
    expect(await page.$$eval('[role=tab]', (nodes) => nodes.map((node) => node.textContent))).toEqual([
      'Renamed canvas',
      'Third canvas',
      'First canvas',
    ])

    const groupPicker = page.locator('button[aria-label="Tab groups"]')
    await page.$eval('button[aria-label="Tab groups"]', (button) => (button as HTMLButtonElement).click())
    await page
      .locator('[role="menuitemradio"][data-state="unchecked"]')
      .filter((node) => node.textContent?.includes('Editorial') === true)
      .click()
    await page.waitForSelector(tab(second!) + '[aria-selected="true"]')
    expect(await page.$(tab(first!))).toBeNull()
    expect(await page.$eval('button[aria-label="Tab groups"]', (node) => node.textContent)).toBe('Editorial2')
    await page.reload()
    await page.waitForSelector('button[aria-label="Tab groups"][title="Editorial"]')
    expect(await page.$(tab(first!))).toBeNull()
    await groupPicker.click()
    await page.locator('::-p-aria([name="All tabs 3"][role="menuitemradio"])').click()
    await page.waitForSelector(tab(first!))
    await page.click(tab(first!))
    await page.waitForSelector(tab(first!) + '[aria-selected="true"]')
    await page.setViewport({ width: 375, height: 650 })
    await page.waitForFunction(
      (id) => {
        const selected = document.getElementById('desktop-canvas-tab-' + id)
        const strip = selected?.closest('[role="tablist"]')
        if (!selected || !strip) return false
        const bounds = selected.getBoundingClientRect()
        const viewport = strip.getBoundingClientRect()
        return bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1
      },
      {},
      first,
    )
    expect(
      await page.$eval('button[aria-label="New canvas"]', (node) => node.getBoundingClientRect().right),
    ).toBeLessThanOrEqual(375)
    await page.setViewport({ width: 900, height: 650 })

    await groupPicker.click()
    await item('New group').click()
    await page.locator('input[aria-label="Group name"]').fill('Inbox')
    await page.keyboard.press('Enter')
    await page.waitForSelector('button[aria-label="Tab groups"][title="Inbox"]')
    expect(await page.$eval('button[aria-label="Tab groups"]', (node) => node.textContent)).toBe('Inbox0')
    expect(await page.$$('[role="tablist"][aria-label="Open canvases"] [role="tab"]')).toHaveLength(0)
    await page.reload()
    await page.waitForSelector('button[aria-label="Tab groups"][title="Inbox"]')
    await groupPicker.click()
    await item('Remove group').click()
    await page.waitForSelector(tab(first!))
    await page.click(tab(first!))
    await page.waitForSelector(tab(first!) + '[aria-selected="true"]')

    await menu(second!)
    await item('Copy link').click()
    await page.waitForFunction(() => sessionStorage.getItem('test-clipboard')?.includes('/c/'))
    expect(new URL((await page.evaluate(() => sessionStorage.getItem('test-clipboard')))!)).toMatchObject({
      pathname: '/c/' + second,
    })

    await menu(second!)
    await item('Open in split view').click()
    await page.waitForSelector('iframe[title="Renamed canvas"]')
    const left = await (await page.waitForSelector('iframe[title="First canvas"]'))?.contentFrame()
    const right = await (await page.waitForSelector('iframe[title="Renamed canvas"]'))?.contentFrame()
    await left?.waitForSelector('[data-doop-frame-shell]')
    await right?.waitForSelector('[data-doop-frame-shell]')
    expect(new URL(left!.url()).pathname).toBe('/c/' + first)
    expect(new URL(right!.url()).pathname).toBe('/c/' + second)
    expect(await right!.$('[role="tablist"][aria-label="Open canvases"]')).toBeNull()
    await page.click('button[aria-label="Close split view"]')
    await page.waitForSelector('iframe[title="Renamed canvas"]', { hidden: true })

    await page.evaluate(() => sessionStorage.setItem('reject-window', '1'))
    await menu(second!)
    await item('Move to new window').click()
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('new window'))
    expect(await page.$(tab(second!))).not.toBeNull()
    await page.evaluate(() => sessionStorage.removeItem('reject-window'))
    await menu(second!)
    await item('Move to new window').click()
    await page.waitForSelector(tab(second!), { hidden: true })
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('test-native-command')!))).toMatchObject({
      command: 'open_canvas_window',
      args: { id: second },
    })
    expect(new URL(page.url()).pathname).toBe('/c/' + first)

    await menu(third!)
    await item('Open in browser').click()
    await page.waitForFunction(() => sessionStorage.getItem('test-external-url')?.includes('/c/'))
    expect(new URL((await page.evaluate(() => sessionStorage.getItem('test-external-url')))!)).toMatchObject({
      pathname: '/c/' + third,
    })
    await menu(third!)
    await item('Pin tab').click()
    await page.waitForFunction(
      (selector) => document.querySelectorAll('[role=tab]')[0]?.matches(selector),
      {},
      tab(third!),
    )
    const pinned = await page.$eval(tab(third!), (node) => node.getBoundingClientRect().toJSON())
    expect(pinned.width).toBeLessThanOrEqual(38)
    expect(pinned.height).toBeGreaterThanOrEqual(36)
    await menu(third!)
    await item('Close other tabs').click()
    await page.waitForFunction((id) => location.pathname === '/c/' + id, {}, third)
    await menu(third!)
    await item('Close all tabs').click()
    await page.waitForFunction(() => location.pathname === '/')
    expect(await page.$$('[role="tablist"][aria-label="Open canvases"] [role="tab"]')).toHaveLength(0)
  }, 60_000)
})
