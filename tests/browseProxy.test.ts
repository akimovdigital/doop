import { describe, expect, it, vi } from 'vitest'
import { loadBrowsePage } from '../server/browseProxy'

describe('browser frame proxy', () => {
  it.each(['file:///etc/passwd', 'http://127.0.0.1:4400/', 'http://169.254.169.254/', 'http://[::ffff:7f00:1]/'])(
    'rejects %s before fetching',
    async (url) => {
      await expect(loadBrowsePage(url, '')).rejects.toMatchObject({ status: 400 })
    },
  )

  it('strips upstream framing policy and cookies, injecting the base and the annotation runtime', async () => {
    const request = vi.fn().mockResolvedValue(
      new Response('<base href="https://wrong.example/"><h1>Hello</h1><script>foreignScript()</script>', {
        headers: {
          'content-type': 'text/html',
          'content-security-policy': "frame-ancestors 'none'",
          'x-frame-options': 'DENY',
          'set-cookie': 'upstream=1',
        },
      }),
    )
    const page = await loadBrowsePage('http://127.0.0.1:8747/docs/', '', request)
    expect(page.headers['content-security-policy']).toContain('sandbox allow-scripts')
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'self'")
    expect(page.headers).not.toHaveProperty('x-frame-options')
    expect(page.headers).not.toHaveProperty('set-cookie')
    const html = page.body.toString()
    expect(html).toContain('<base href="http://127.0.0.1:8747/docs/">')
    expect(html).toContain('doop:hover-result')
    expect(html).toContain('<h1>Hello</h1>')
    expect(html).not.toContain('foreignScript()')
    expect(html).not.toContain('https://wrong.example/')
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty('headers.cookie')
  })

  it('rejects a streamed response above 10 MB without relying on Content-Length', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(10_000_001))
        controller.close()
      },
    })
    const request = vi.fn().mockResolvedValue(new Response(body))
    await expect(loadBrowsePage('http://127.0.0.1:8747/', '', request)).rejects.toMatchObject({ status: 413 })
  })
})

describe('browser proxy upstream handling', () => {
  it('checks every redirect and denies jumps from a public page to a development origin', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8747/private' } }))
    await expect(loadBrowsePage('https://site.example/', '', request)).rejects.toMatchObject({ status: 400 })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('uses the final URL for relative resources and drops meta refresh', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/docs/' } }))
      .mockResolvedValueOnce(
        new Response('<meta http-equiv="refresh" content="0;url=https://wrong.example/"><a href="../next">Next</a>', {
          headers: { 'content-type': 'text/html' },
        }),
      )
    const page = await loadBrowsePage('https://site.example/start', '', request)
    expect(request.mock.calls[1]?.[0].href).toBe('https://site.example/docs/')
    expect(page.body.toString()).toContain('<base href="https://site.example/docs/">')
    expect(page.body.toString()).not.toContain('https://wrong.example/')
  })

  it('rejects an oversized Content-Length before consuming the body', async () => {
    const request = vi.fn().mockResolvedValue(new Response('short', { headers: { 'content-length': '10000001' } }))
    await expect(loadBrowsePage('http://127.0.0.1:8747/', '', request)).rejects.toMatchObject({ status: 413 })
  })

  it('ends a stalled fetch or DNS lookup at the overall deadline', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn(
        (_target: unknown, _init?: { signal?: AbortSignal | null }) => new Promise<Response>(() => {}),
      )
      const rejected = expect(loadBrowsePage('http://127.0.0.1:8747/', '', request)).rejects.toMatchObject({
        status: 504,
      })
      await vi.advanceTimersByTimeAsync(15_000)
      await rejected
      expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('serves non-HTML bytes as inert data and preserves no upstream headers', async () => {
    const data = '<svg xmlns="http://www.w3.org/2000/svg"><script>danger()</script></svg>'
    const request = vi.fn().mockResolvedValue(
      new Response(data, {
        headers: { 'content-type': 'image/svg+xml', 'set-cookie': 'x=1', 'x-frame-options': 'DENY' },
      }),
    )
    const page = await loadBrowsePage('http://127.0.0.1:8747/', '', request)
    expect(page.body.toString()).toBe(data)
    expect(page.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment',
      'x-content-type-options': 'nosniff',
    })
    expect(page.headers).not.toHaveProperty('set-cookie')
  })
})
