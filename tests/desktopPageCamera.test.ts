import { describe, expect, it, vi } from 'vitest'
import { saveDesktopPageCamera, takeDesktopPageCamera } from '../src/lib/desktopPageCamera'

describe('desktop WebContent reload camera', () => {
  const viewport = { x: -120, y: 240, zoom: 1.6 }

  function makeHistory() {
    const history = {
      state: { marker: 1 },
      replaceState: vi.fn((state: typeof history.state) => {
        history.state = state
      }),
    }
    return history
  }

  it('restores the matching page once and preserves other history state', () => {
    const history = makeHistory()
    saveDesktopPageCamera(history, { canvasId: 'c', pageId: 'p', viewport })
    expect(takeDesktopPageCamera(history, 'other', 'p')).toBeUndefined()
    expect(takeDesktopPageCamera(history, 'c', 'other')).toBeUndefined()
    expect(takeDesktopPageCamera(history, 'c', 'p')).toEqual(viewport)
    expect(takeDesktopPageCamera(history, 'c', 'p')).toBeUndefined()
    expect(history.state.marker).toBe(1)
  })

  it('ignores an invalid stored camera or a rejected history write', () => {
    const history = makeHistory()
    saveDesktopPageCamera(history, { canvasId: 'c', pageId: 'p', viewport: { ...viewport, zoom: Infinity } })
    expect(takeDesktopPageCamera(history, 'c', 'p')).toBeUndefined()
    history.replaceState.mockImplementation(() => {
      throw new Error('history rate limit')
    })
    expect(() => saveDesktopPageCamera(history, { canvasId: 'c', pageId: 'p', viewport })).not.toThrow()
  })
})
