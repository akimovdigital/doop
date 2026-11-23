import { serializeContextPrompt, type UiElementContext } from '../../shared/uiElementContext'
import { formatComposerContexts } from '../lib/designNotes'
import { useStore, type ComposerSend } from '../lib/store'
import { api, type Allowance } from '../lib/api'
import { posthog } from '../lib/posthog'
import { uploadImageFrames } from '../lib/frameClipboard'
import { arrivedDeliverable } from '../lib/composerFlight'
import { isResidentLimit } from './TeamAllowance'
import { currentRunnerPick } from '../lib/runnerPick'
import { AGENT_ROLES, DEFAULT_ROLE_ID, mentionedRoles } from '../../shared/agents'
import type { CardScope } from '../../shared/types'
import { t as translate } from '@/lib/i18n'

/** How long after a submit a newly created frame still gets the camera. */
const FLY_WINDOW_MS = 3 * 60_000

let cancelPendingFlight: (() => void) | null = null

/**
 * After a submit, the first frame that wasn't on the canvas before gets a
 * camera flight — the deliverable must stream in on-screen, never somewhere
 * off-canvas the user has to go find. A store subscription rather than an
 * effect: the composer lives in a panel tab, and switching tabs (or closing
 * the panel) while the agent works must not cancel the flight. Leaving the
 * canvas does: another canvas's frames are all "new" to this watch, and a
 * flight there would land on something unrelated. A newer submit replaces
 * an older watch. A component's main is not the deliverable: the watch
 * keeps waiting past it rather than pulling the person onto the Components
 * page.
 */
function flyToNextFrame(canvasId: string, extraKnown: string[]) {
  cancelPendingFlight?.()
  const known = new Set([...(useStore.getState().canvas?.frames ?? []).map((f) => f.id), ...extraKnown])
  const unsubscribe = useStore.subscribe((s) => {
    /* null while a canvas loads — only a different canvas ends the watch */
    if (!s.canvas) return
    if (s.canvas.id !== canvasId) return stop()
    const arrived = arrivedDeliverable(s.canvas, known)
    if (!arrived) return
    stop()
    s.requestFlyTo(arrived.id)
  })
  const timer = window.setTimeout(stop, FLY_WINDOW_MS)
  function stop() {
    unsubscribe()
    window.clearTimeout(timer)
    if (cancelPendingFlight === stop) cancelPendingFlight = null
  }
  cancelPendingFlight = stop
}

/** How long the "on it" confirmation stays up after a send. */
const SENT_NOTE_MS = 5000

function setSend(send: ComposerSend | null) {
  useStore.getState().setComposerSend(send)
}

/**
 * The send itself, detached from the component: the composer unmounts with
 * its tab, and a send that fails after the user switched away must still
 * report back when the tab returns. Progress and outcome go to the store;
 * the draft is cleared only once the card is queued, so a failure leaves
 * the text in place for a retry.
 */
export async function sendPrompt(args: {
  canvasId: string
  text: string
  files?: File[]
  contexts?: UiElementContext[]
  agentText?: string
  scope: CardScope | undefined
  allowance: Allowance | null
  clearDraft?: boolean
}): Promise<{ cardId?: string } | undefined> {
  const { canvasId, text, files = [], scope, allowance, clearDraft = true } = args
  const store = useStore.getState()
  if (store.composerSend?.status === 'busy') return
  const draft = store.composerDrafts[canvasId]
  const contexts = args.contexts ?? (clearDraft ? draft?.contexts : undefined) ?? []
  const first = contexts.find((entry) => entry.selector)
  const cardScope = first ? { frameId: first.frameId, selector: first.selector } : scope
  const wireText = serializeContextPrompt(args.agentText ?? formatComposerContexts(text, contexts), text, contexts)
  setSend({ canvasId, status: 'busy' })
  /* known-doomed send: no free tasks and no model account. Open the wall
     up front instead of uploading attachments only to 403 — but confirm
     against the server first, since the cached allowance can be stale
     (an account connected in another tab). The server enforces either
     way, so an unreachable check just falls through. Text stays in place. */
  if (allowance && !allowance.byoModel && allowance.used >= allowance.limit) {
    const fresh = await api.agentAllowance().catch(() => null)
    if (fresh && !fresh.byoModel && fresh.used >= fresh.limit) {
      store.setLimitWall(true)
      setSend(null)
      return
    }
  }
  try {
    /* attachments first: each becomes a reference frame on the canvas, and
       the card carries the frame ids so the agent views them before
       designing. Known-ids include them so the camera saves its flight for
       the agent's deliverable, not the user's own screenshots. */
    const refFrames = files.length ? await uploadImageFrames(canvasId, files, { fallbackName: 'Attached image' }) : []
    /* the composer's pick rides on the card, so the task runs on what the
       picker beside the send button shows */
    const runner = currentRunnerPick()
    /* "@copy tighten the hero" goes to the Copywriter, "@copy @a11y …" to
       both in that order; no mention is Doop's */
    const mentioned = mentionedRoles(text, store.canvas?.team ?? AGENT_ROLES).map((role) => role.id)
    const card = await api.addCard(
      canvasId,
      wireText,
      mentioned.length > 0 ? mentioned : [DEFAULT_ROLE_ID],
      refFrames.map((f) => f.id),
      cardScope,
      runner,
    )
    posthog.capture('prompt_bar_submitted', {
      attachments: refFrames.length,
      agents: mentioned.length,
      scope: cardScope ? (cardScope.selector ? 'element' : 'frame') : 'none',
      runner: runner?.provider ?? 'default',
    })
    flyToNextFrame(
      canvasId,
      refFrames.map((f) => f.id),
    )
    if (clearDraft && useStore.getState().composerDrafts[canvasId] === draft) store.setComposerDraft(canvasId, '', [])
    const sent: ComposerSend = { canvasId, status: 'sent', at: Date.now() }
    setSend(sent)
    window.setTimeout(() => {
      if (useStore.getState().composerSend === sent) setSend(null)
    }, SENT_NOTE_MS)
    return { cardId: card?.id }
  } catch (err) {
    if (isResidentLimit(err)) {
      store.setLimitWall(true)
      setSend(null)
    } else {
      console.error(err)
      setSend({
        canvasId,
        status: 'error',
        message: err instanceof Error ? err.message : translate('panels.promptSendFailed'),
        at: Date.now(),
      })
    }
  } finally {
    /* every meter on screen re-reads the allowance, mounted or not */
    useStore.getState().allowanceChanged()
  }
}
