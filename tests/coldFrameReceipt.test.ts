import { describe, expect, it, vi } from 'vitest'
import { coldFrameReceipt } from '../src/lib/coldFrameReceipt'

describe('cold frame receipt', () => {
  it('does not reveal at timeout and recovers the document from a later application', () => {
    const complete = vi.fn()
    const receipt = coldFrameReceipt(complete)
    receipt.settled(false)
    expect(complete).not.toHaveBeenCalled()
    receipt.applied()
    expect(complete).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('waits for the RPC outcome and reuses its normal bookkeeping for a timely ACK', () => {
    const complete = vi.fn()
    const receipt = coldFrameReceipt(complete)
    receipt.applied()
    expect(complete).not.toHaveBeenCalled()
    receipt.settled(true)
    receipt.applied()
    expect(complete).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('ignores a late application to a cancelled request and leaves its replacement independent', () => {
    const previous = vi.fn()
    const current = vi.fn()
    const old = coldFrameReceipt(previous)
    const next = coldFrameReceipt(current)
    old.settled(false)
    old.cancel()
    old.applied()
    next.settled(true)
    expect(previous).not.toHaveBeenCalled()
    expect(current).not.toHaveBeenCalled()
    next.applied()
    expect(current).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('does not finish when the renderer applied HTML just before the request was cancelled', () => {
    const complete = vi.fn()
    const receipt = coldFrameReceipt(complete)
    receipt.applied()
    receipt.cancel()
    receipt.settled(false)
    expect(complete).not.toHaveBeenCalled()
  })
})
