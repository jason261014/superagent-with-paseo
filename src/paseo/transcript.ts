/** Read-only projection of Paseo's public timeline into the existing transcript resources. */
import { key } from '../core/ids.ts'
import type { TranscriptEntry } from '../app/context.ts'
import type { PaseoAdapter, PaseoTimelineEntry } from './client.ts'

function message(item: unknown): Omit<TranscriptEntry, 'id'> | undefined {
  if (!item || typeof item !== 'object' || !('type' in item)) throw new Error('Invalid Paseo timeline item')
  const value = item as Record<string, unknown>
  const text = (type: string, role: string, body: string): Omit<TranscriptEntry, 'id'> =>
    ({ type, message: { role, content: [{ type: 'text', text: body }] } })
  if (value.type === 'user_message' || value.type === 'assistant_message') {
    if (typeof value.text !== 'string') throw new Error('Invalid Paseo message')
    const role = value.type === 'user_message' ? 'user' : 'assistant'
    return text(role + '/message', role, value.text)
  }
  if (value.type === 'tool_call') {
    if (typeof value.callId !== 'string' || typeof value.name !== 'string' || typeof value.status !== 'string' || !value.detail) {
      throw new Error('Invalid Paseo tool call')
    }
    // Paseo combines tool input, output and state; do not invent separate DSH tool-result events.
    return text('paseo/tool_call', 'tool', JSON.stringify({ callId: value.callId, name: value.name,
      status: value.status, detail: value.detail, error: value.error }))
  }
  if (value.type === 'error' || value.type === 'notification') {
    if (typeof value.message !== 'string') throw new Error('Invalid Paseo notification')
    return text('paseo/' + value.type, 'system', value.message)
  }
  if (value.type === 'compaction') return text('paseo/compaction', 'system', JSON.stringify({
    status: value.status, trigger: value.trigger, preTokens: value.preTokens }))
  // Reasoning, task lists and plugin UI items are not transcript messages.
  return undefined
}

export function projectPaseoTranscript(agentId: string, epoch: string, entries: PaseoTimelineEntry[]): TranscriptEntry[] {
  const namespace = key(agentId + ':' + epoch)
  return entries.flatMap(entry => {
    const projected = message(entry.item)
    return projected ? [{ ...projected, id: `paseo-${namespace}-${entry.seqStart}` }] : []
  })
}

export async function readPaseoTranscript(paseo: Pick<PaseoAdapter, 'timeline'>, agentId: string | undefined): Promise<TranscriptEntry[]> {
  if (!agentId) throw new Error('Paseo session is not bound; transcript unavailable')
  const result = await paseo.timeline(agentId)
  if (result.kind !== 'complete') throw new Error('Paseo transcript unavailable: ' + result.reason)
  return projectPaseoTranscript(agentId, result.epoch, result.entries)
}
