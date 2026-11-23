import { z } from 'zod'

export const contextStyleNames = [
  'color',
  'background-color',
  'font-size',
  'font-family',
  'display',
  'position',
] as const

const contextSchema = z.object({
  kind: z.enum(['element', 'region']),
  label: z.string(),
  selector: z.string(),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  html: z.string(),
  styles6: z.record(z.enum(contextStyleNames), z.string()),
  component: z.string().optional(),
  url: z.string(),
  noteId: z.string(),
  number: z.number(),
  frameId: z.string(),
  frameName: z.string(),
})

export type UiElementContext = z.infer<typeof contextSchema>

const payloadSchema = z.object({ text: z.string(), contexts: z.array(contextSchema).min(1) })
const start = '\n\n<doop-context>\n'
const end = '\n</doop-context>'

export function serializeContextPrompt(agentText: string, text: string, contexts: UiElementContext[]): string {
  if (!contexts.length) return agentText
  const payload = JSON.stringify({ text, contexts }).replaceAll('<', '\\u003c')
  return agentText + start + payload + end
}

function unpack(value: string) {
  if (!value.endsWith(end)) return
  const offset = value.lastIndexOf(start)
  if (offset < 0) return
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(value.slice(offset + start.length, -end.length)))
    if (parsed.success) return { agentText: value.slice(0, offset), ...parsed.data }
  } catch {
    // A prompt typed before the context format (or with malformed metadata) is plain text.
  }
}

export function readContextPrompt(value: string): { text: string; contexts: UiElementContext[] } {
  const result = unpack(value)
  return result ? { text: result.text, contexts: result.contexts } : { text: value, contexts: [] }
}

export function agentPromptText(value: string): string {
  return unpack(value)?.agentText ?? value
}
