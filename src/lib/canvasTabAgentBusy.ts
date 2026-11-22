import type { AgentTask, Presence } from '../../shared/types'
import type { ComposerSend } from './store'
import { joinedCanvasId } from './ws'

function activeAgent(p: Presence): boolean {
  return p.kind === 'agent' && !!p.status
}

type TabAgentState = {
  canvas: { id: string } | null
  tasks: AgentTask[]
  presences: Record<string, Presence>
  composerSend: ComposerSend | null
}

function openAgentTasks(tasks: AgentTask[]): AgentTask[] {
  return tasks.filter((t) => t.agentName && !t.endedAt && !t.failedAt)
}

/** Whether the selected canvas tab should show the OpenCode 5×5 busy grid.
 *  Store tasks and presences belong to the open room only; inactive tabs stay idle. */
export function canvasTabAgentBusy(state: TabAgentState, canvasId: string, activeTab: boolean): boolean {
  if (!activeTab) return false
  const roomId = state.canvas?.id ?? joinedCanvasId()
  if (roomId !== canvasId) return false
  if (state.composerSend?.canvasId === canvasId && state.composerSend.status === 'busy') return true
  if (openAgentTasks(state.tasks).length > 0) return true
  return Object.values(state.presences).some(activeAgent)
}