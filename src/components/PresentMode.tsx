import type { Interaction } from '../../shared/prototype'
import { PrototypePlayer } from './PrototypePlayer'

/* Full-screen presentation over the editor: the prototype player, starting on
   the frame it was launched from, still connected to the room so edits
   streaming in render live. Esc closes (after any open overlay). */
export function PresentMode({
  frameId,
  interaction,
  onClose,
}: {
  frameId: string
  interaction?: Interaction
  onClose: () => void
}) {
  return <PrototypePlayer key={frameId} startFrameId={frameId} initialInteraction={interaction} onClose={onClose} />
}
