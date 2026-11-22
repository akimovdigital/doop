import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

describe.skipIf(!findBrowserPath())('page strip and zoom layout', () => {
  const pages = pagePerTest()
  const strip = '[data-slot="page-strip"]'
  const zoomLevel = 'button[aria-label="Zoom level"]'

  it.each([375, 768, 1440])('keeps both controls clear and clickable at %ipx', async (width) => {
    const page = await pages.open()
    await page.setViewport({ width, height: 900 })
    await openCanvasPage(page, [canvasFrame({ id: 'board', name: 'Board', x: 0, y: 0, width: 200, height: 150 })], '', {
      pages: [
        { id: 'home', name: 'Home' },
        { id: 'pricing', name: 'Pricing' },
        { id: 'prototype', name: 'Prototyping' },
      ],
    })
    await page.click(zoomLevel)
    const input = 'input[aria-label="Zoom level"]'
    await page.locator(input).fill('100')
    await page.keyboard.press('Enter')
    await page.waitForFunction((selector) => document.querySelector(selector)?.textContent === '100%', {}, zoomLevel)

    const gap = () =>
      page.$eval(
        strip,
        (el, level, stacked) => {
          const pages = el.getBoundingClientRect()
          const zoom = document.querySelector(level)!.closest('[role="toolbar"]')!.getBoundingClientRect()
          return stacked ? zoom.top - pages.bottom : zoom.left - pages.right
        },
        zoomLevel,
        width < 900,
      )
    expect(await gap()).toBeGreaterThan(0)

    await page.click('button[aria-label="Zoom in"]')
    expect(await page.$eval(zoomLevel, (el) => el.textContent)).toBe('125%')
    expect(await gap()).toBeGreaterThan(0)
    await page.click('button[aria-label="Zoom out"]')
    expect(await page.$eval(zoomLevel, (el) => el.textContent)).toBe('100%')

    await page.click(`${strip} button[aria-label="Next page"]`)
    expect(await page.$eval(`${strip} [aria-current="page"]`, (el) => el.textContent)).toBe('Pricing')
    await page.click(`${strip} button[aria-label="Previous page"]`)
    expect(await page.$eval(`${strip} [aria-current="page"]`, (el) => el.textContent)).toBe('Home')
  })
})
