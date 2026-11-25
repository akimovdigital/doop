/** A cold frame can outlive the editor's normal HTML RPC. Only an application
 *  receipt from that document's private port can advance the skeleton. */
export function coldFrameReceipt(complete: (recoverDocument: boolean) => void) {
  let applied = false
  let rpc: 'pending' | 'acknowledged' | 'expired' = 'pending'
  let active = true
  function finish() {
    if (!active || !applied || rpc === 'pending') return
    active = false
    complete(rpc === 'expired')
  }
  return {
    applied() {
      applied = true
      finish()
    },
    settled(acknowledged: boolean) {
      rpc = acknowledged ? 'acknowledged' : 'expired'
      finish()
    },
    cancel() {
      active = false
    },
  }
}
