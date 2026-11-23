import { expect, it } from 'vitest'
import type { Canvas, CanvasPageLayout, Frame } from '../shared/types.ts'
import { sectionContainsFrame, sectionForFrame } from '../shared/sections.ts'
import { Client, startServer } from './harness.ts'

async function json<T>(response: Promise<Response>): Promise<T> {
  const res = await response
  const body = await res.json()
  expect(res.status, JSON.stringify(body)).toBe(200)
  return body as T
}

it('moves sections with their frames and consolidates pages durably', async () => {
  let server = await startServer()
  try {
    const owner = await new Client(server).signUp('sections@test.dev', 'Sections Owner')
    const canvas = await json<Canvas>(owner.post('/api/canvases', { name: 'Section board' }))
    const api = `/api/canvases/${canvas.id}`
    const [main] = canvas.pages!
    const other = { id: 'second', name: 'Sketches' }
    const empty = { id: 'third', name: 'Future work' }
    await json(owner.put(`${api}/pages`, { expectedPages: canvas.pages, pages: [main, other, empty] }))
    const home = await json<Frame>(
      owner.post(`${api}/frames`, { name: 'Home', pageId: main!.id, width: 80, height: 40, x: 7, y: 13 }),
    )
    const linked = await json<Frame>(
      owner.post(`${api}/frames`, {
        name: 'Linked screen',
        pageId: other.id,
        x: 12,
        y: 12,
        width: 48,
        height: 30,
        rotation: 10,
      }),
    )
    const outside = await json<Frame>(
      owner.post(`${api}/frames`, {
        name: 'Partly outside',
        pageId: other.id,
        x: 88,
        y: 32,
        width: 60,
        height: 30,
      }),
    )
    await json(owner.put(`${api}/pages/${main!.id}/flow-start`, { frameId: home.id }))
    const sectionPath = `${api}/pages/${other.id}/sections/tight-group`
    const section = { id: 'tight-group', name: 'Flow', x: 0, y: 0, width: 100, height: 100 }
    const outer = { ...section, id: 'big-group', width: 200, height: 200 }
    expect(sectionForFrame([outer, section], linked)?.id).toBe(section.id)
    expect(sectionContainsFrame(section, outside)).toBe(false)
    expect(await json<CanvasPageLayout>(owner.put(sectionPath, section))).toMatchObject({
      frameMoves: [],
      pages: [expect.any(Object), { sections: [section] }, empty],
    })
    const appearance = {
      fill: '#405c7a',
      fillOpacity: 85,
      stroke: '#182937',
      strokeWidth: 3,
      strokeOpacity: 70,
      strokeAlign: 'outside',
      cornerRadius: 12,
      lockAspectRatio: true,
    }
    expect(await json<CanvasPageLayout>(owner.patch(sectionPath, appearance))).toMatchObject({
      frameMoves: [],
      pages: [expect.any(Object), { sections: [{ ...section, ...appearance }] }, empty],
    })
    expect((await owner.patch(sectionPath, { fillOpacity: 101 })).status).toBe(400)
    expect((await owner.patch(sectionPath, { stroke: 'invalid' })).status).toBe(400)
    expect(await json<CanvasPageLayout>(owner.put(sectionPath, section))).toMatchObject({
      pages: [expect.any(Object), { sections: [{ ...section, ...appearance }] }, empty],
    })
    const expected = { x: 0, y: 0 }
    const moved = await json<CanvasPageLayout>(owner.post(`${sectionPath}/move`, { x: -110, y: 20, expected }))
    expect(moved.frameMoves).toMatchObject([{ id: linked.id, pageId: other.id, x: -98, y: 32 }])
    expect(moved.frameMoves[0]!.updatedAt).toBeGreaterThan(linked.updatedAt)
    expect((await owner.post(`${sectionPath}/move`, { x: 110, y: 20, expected })).status).toBe(409)
    expect(await json<CanvasPageLayout>(owner.post(`${sectionPath}/move`, { x: -110, y: 20, expected }))).toMatchObject(
      {
        frameMoves: [],
      },
    )
    const extra = `${api}/pages/${other.id}/sections/temporary`
    await json(owner.put(extra, { ...section, name: 'Temporary' }))
    await json(owner.delete(extra))
    await json(owner.put(`${api}/guides/sample-guide`, { pageId: other.id, axis: 'v', at: 12 }))

    // A debounced HTML save that precedes consolidation must reach disk too.
    const html = `<a data-doop-on="click" data-doop-action="navigate:${home.id}">Home</a>`
    const saved = await json<Frame>(
      owner.patch(`/api/frames/${linked.id}`, { html, expectedUpdatedAt: moved.frameMoves[0]!.updatedAt }),
    )
    expect(saved.html).toContain(`navigate:${home.id}`)
    const consolidated = await json<CanvasPageLayout>(
      owner.post(`${api}/pages/${main!.id}/consolidate`, { name: 'Main page' }),
    )
    expect(consolidated.pages).toMatchObject([{ id: main!.id, name: 'Main page', startFrameId: home.id }])
    expect(consolidated.pages[0]!.landingSectionId).toBe(consolidated.pages[0]!.sections![0]!.id)
    expect(consolidated.pages[0]!.sections!.map((s) => s.name)).toEqual([main!.name, 'Sketches', 'Flow', 'Future work'])
    expect(consolidated.frameMoves.map((f) => f.id).sort()).toEqual([home.id, linked.id, outside.id].sort())
    expect(consolidated.frameMoves.every((f) => f.pageId === main!.id)).toBe(true)
    const restoredLink = consolidated.frameMoves.find((f) => f.id === linked.id)!
    const restoredOutside = consolidated.frameMoves.find((f) => f.id === outside.id)!
    expect(restoredOutside.x - restoredLink.x).toBeCloseTo(186)
    expect(restoredOutside.y - restoredLink.y).toBe(0)

    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer({}, dataDir)
    const restored = await json<Canvas>(owner.get(api))
    expect(restored.frames).toHaveLength(3)
    expect(restored.frames.find((f) => f.id === linked.id)).toMatchObject({ ...restoredLink, html: saved.html })
    expect(restored.pages?.[0]?.sections?.find((s) => s.id === section.id)).toMatchObject(appearance)
    expect(restored.pages).toEqual(consolidated.pages)
    expect(restored.guides).toMatchObject([{ id: 'sample-guide', pageId: main!.id, at: 12 + restoredLink.x + 98 }])

    const [landingPage] = restored.pages!
    const copy = await json<{ page: NonNullable<Canvas['pages']>[number] }>(
      owner.post(`${api}/pages/${main!.id}/duplicate`),
    )
    expect(copy.page.landingSectionId).toBe(copy.page.sections![0]!.id)
    expect(copy.page.landingSectionId).not.toBe(landingPage!.landingSectionId)
  } finally {
    server.stop()
  }
}, 150_000)

it('unwraps in place and durably deletes only the selected section subtree', async () => {
  let server = await startServer()
  try {
    const owner = await new Client(server).signUp('section-delete@test.dev', 'Tester')
    const canvas = await json<Canvas>(owner.post('/api/canvases', { name: 'Section deletion fixture' }))
    const api = `/api/canvases/${canvas.id}`
    const page = canvas.pages![0]!
    const path = `${api}/pages/${page.id}`
    const outer = { id: 'outer', name: 'Outer', x: 0, y: 0, width: 800, height: 500 }
    const nested = { ...outer, id: 'nested', name: 'Nested', x: 30, y: 30, width: 300, height: 300 }
    const overlap = { ...outer, id: 'overlap', name: 'Overlap', x: 700, width: 200, height: 200 }
    for (const section of [outer, nested, overlap]) await json(owner.put(`${path}/sections/${section.id}`, section))
    async function createFrame(name: string, x: number, y: number, html?: string) {
      return json<Frame>(owner.post(`${api}/frames`, { name, pageId: page.id, x, y, width: 50, height: 50, html }))
    }
    const frame = await createFrame('Nested artboard', 60, 60)
    const shape = await createFrame('Shape', 360, 60, '<body data-doop-canvas-element="true"><svg></svg></body>')
    const group = await createFrame(
      'Group',
      450,
      60,
      '<body data-doop-canvas-element="true"><div><b>A</b><i>B</i></div></body>',
    )
    const other = await createFrame('In the tighter overlap', 725, 80)
    const partial = await createFrame('Only crosses the outer edge', 785, 300)
    await json(owner.put(`${path}/flow-start`, { frameId: frame.id }))
    // Landing sections are evaluated on the section route just like ordinary sections.
    const landing = await json<CanvasPageLayout>(owner.post(`${path}/consolidate`, { name: page.name }))
    expect(landing.pages[0]!.landingSectionId).toBe(outer.id)

    const remove = (keepContents: boolean) =>
      json<CanvasPageLayout>(
        owner.req(`${path}/sections/${outer.id}`, { method: 'DELETE', body: JSON.stringify({ keepContents }) }),
      )
    const before = await json<Canvas>(owner.get(api))
    const unwrap = await remove(true)
    expect(unwrap.frameMoves).toEqual([])
    expect(unwrap.frameDeletes).toBeUndefined()
    expect(unwrap.pages[0]!.sections?.map((section) => section.id)).toEqual([nested.id, overlap.id])
    expect(unwrap.pages[0]!.landingSectionId).toBeUndefined()
    expect((await json<Canvas>(owner.get(api))).frames).toEqual(before.frames)

    await json(owner.put(`${path}/sections/${outer.id}`, outer))
    const deleted = await remove(false)
    expect(deleted.frameDeletes?.sort()).toEqual([frame.id, shape.id, group.id].sort())
    expect(deleted.pages[0]!.sections).toEqual([overlap])
    expect(deleted.pages[0]!.startFrameId).toBeUndefined()
    await remove(false)

    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer({}, dataDir)
    const restored = await json<Canvas>(owner.get(api))
    expect(restored.pages).toEqual(deleted.pages)
    expect(restored.frames.map((item) => item.id).sort()).toEqual([other.id, partial.id].sort())
  } finally {
    server.stop()
  }
}, 150_000)
