import { describe, expect, it, vi } from 'vitest'
import type { AgentTask, Presence } from '../shared/types'
import { canvasTabAgentBusy } from '../src/lib/canvasTabAgentBusy'

vi.mock('../src/lib/ws', () => ({
  joinedCanvasId: () => 'room-a',
}))

const base = {
  canvas: { id: 'room-a' } as const,
  tasks: [] as AgentTask[],
  presences: {} as Record<string, Presence>,
  composerSend: null,
}

const openTask: AgentTask = {
  id: 't1',
  agentName: 'Claude',
  color: '#000',
  status: 'Designing',
  startedAt: 1,
}

const agentBusy: Presence = {
  clientId: 'a1',
  name: 'Claude',
  color: '#000',
  kind: 'agent',
  status: 'Designing',
}

describe('canvasTabAgentBusy', () => {
  it('stays idle on inactive tabs even when the room is busy', () => {
    expect(canvasTabAgentBusy({ ...base, tasks: [openTask] }, 'room-a', false)).toBe(false)
  })

  it('shows busy for open agent tasks on the active tab', () => {
    expect(canvasTabAgentBusy({ ...base, tasks: [openTask] }, 'room-a', true)).toBe(true)
  })

  it('shows busy for agent set_status without an open task row yet', () => {
    expect(canvasTabAgentBusy({ ...base, presences: { a1: agentBusy } }, 'room-a', true)).toBe(true)
  })

  it('shows busy while the Agents composer send is in flight', () => {
    expect(
      canvasTabAgentBusy(
        { ...base, composerSend: { canvasId: 'room-a', status: 'busy' } },
        'room-a',
        true,
      ),
    ).toBe(true)
  })

  it('does not leak busy state to a different canvas tab', () => {
    expect(canvasTabAgentBusy({ ...base, tasks: [openTask] }, 'room-b', true)).toBe(false)
  })

  it('ignores ended tasks', () => {
    expect(canvasTabAgentBusy({ ...base, tasks: [{ ...openTask, endedAt: 2 }] }, 'room-a', true)).toBe(false)
  })
})