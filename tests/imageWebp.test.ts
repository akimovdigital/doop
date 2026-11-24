import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { toWebpIfSmaller } from '../server/imageWebp.ts'
import { optimizeImportedImages } from '../server/inlineImageWebp.ts'
import { dibIcon } from './icoFixture.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/images/${name}`, import.meta.url))

describe('image asset encoding', () => {
  it.each([
    ['photo.jpg', 'image/jpeg'],
    ['photo.png', 'image/png'],
  ])('reduces %s without changing its dimensions', async (name, mime) => {
    const input = fixture(name)
    const result = await toWebpIfSmaller(input, mime)
    expect(result).toMatchObject({
      converted: true,
      mime: 'image/webp',
      before: input.length,
      after: result.buffer.length,
    })
    expect(result.after).toBeLessThan(result.before)
    expect(await sharp(result.buffer).metadata()).toMatchObject({ format: 'webp', width: 384, height: 256 })
  })

  it('preserves the decoded colors and alpha of a transparent PNG', async () => {
    const input = fixture('transparent-ui.png')
    const result = await toWebpIfSmaller(input, 'image/png')
    expect(result.converted).toBe(true)
    expect(result.after).toBeLessThan(input.length)
    expect(await sharp(result.buffer).metadata()).toMatchObject({ hasAlpha: true, format: 'webp' })
    expect(
      (await sharp(result.buffer).ensureAlpha().raw().toBuffer()).equals(
        await sharp(input).ensureAlpha().raw().toBuffer(),
      ),
    ).toBe(true)
  })

  it.each([
    ['tiny.png', 'image/png'],
    ['tiny.webp', 'image/webp'],
    ['icon.gif', 'image/gif'],
    ['icon.svg', 'image/svg+xml'],
  ])('keeps %s byte-for-byte', async (name, mime) => {
    const input = fixture(name)
    expect(await toWebpIfSmaller(input, mime)).toEqual({
      buffer: input,
      mime,
      converted: false,
      before: input.length,
      after: input.length,
    })
  })

  it.each([
    [dibIcon(2, 32, () => [255, 0, 0, 255]), 'image/x-icon'],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
  ])('keeps ICO and undecodable raster bytes', async (input, mime) => {
    const result = await toWebpIfSmaller(input, mime)
    expect(result).toMatchObject({ buffer: input, mime, converted: false })
  })

  it('does not flatten APNG even when the decoder only exposes the first frame', async () => {
    const input = fixture('photo.png')
    const animationControl = Buffer.from('000000086163544c0000000200000000f38d9370', 'hex')
    const animated = Buffer.concat([input.subarray(0, 33), animationControl, input.subarray(33)])
    expect(await toWebpIfSmaller(animated, 'image/png')).toMatchObject({ buffer: animated, converted: false })
  })
})

it('optimizes CSS and image data URLs in a new import with the same byte rule', async () => {
  const data = `data:image/png;base64,${fixture('transparent-ui.png').toString('base64')}`
  const gif = `data:image/gif;base64,${fixture('icon.gif').toString('base64')}`
  const html =
    `<style>div{background:url("${data}")}</style><svg><image href="${data}"/></svg>` +
    `<img src="/a/legacy.png"><img src="${gif}"><script>const src="${data}"</script>`
  const result = await optimizeImportedImages(html)
  expect(result.match(/data:image\/webp;base64,/g)).toHaveLength(2)
  expect(result).toContain('src="/a/legacy.png"')
  expect(result).toContain(gif)
  expect(result).toContain(`<script>const src="${data}"</script>`)
})
