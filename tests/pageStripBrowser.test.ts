import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

describe.skipIf(!findBrowserPath())('canvas tools match the bar pill', () => {
  const pages = pagePerTest()
  const zoomLevel = 'button[aria-label="Zoom level"]'

  it('hides the page chip and sizes the tool strip like a bar pill', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 1440, height: 900 })
    await openCanvasPage(page, [canvasFrame({ id: 'board', name: 'Board', x: 0, y: 0, width: 200, height: 150 })])
    expect(await page.$('[data-slot="page-strip"]')).toBeNull()
    const box = await page.$eval('[aria-label="Canvas tools"]', (el) => {
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return { height: rect.height, radius: style.borderTopLeftRadius }
    })
    expect(box.height).toBe(36)
    expect(box.radius).toBe('10px')
    await page.click(zoomLevel)
    await page.locator('input[aria-label="Zoom level"]').fill('100')
    await page.keyboard.press('Enter')
    await page.waitForFunction((selector) => document.querySelector(selector)?.textContent === '100%', {}, zoomLevel)
  })
})
