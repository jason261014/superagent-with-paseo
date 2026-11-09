import { expect, it, vi } from 'vitest'
import { projectPaseoTranscript, readPaseoTranscript } from '../src/paseo/transcript.ts'
import type { PaseoTimelineEntry } from '../src/paseo/client.ts'

const entry = (seqStart: number, item: unknown, seqEnd = seqStart): PaseoTimelineEntry =>
  ({ seqStart, seqEnd, timestamp: '2026-11-06T00:00:00Z', item })

it('retains public messages, combined tool evidence and errors while omitting reasoning and UI items', () => {
  const tool = { type: 'tool_call', callId: 'call-1', name: 'Bash', status: 'completed',
    detail: { type: 'shell', command: 'cat result.txt', output: 'A' }, error: null }
  const result = projectPaseoTranscript('agent-1', 'epoch-1', [
    entry(1, { type: 'user_message', text: 'Choose A' }),
    entry(2, { type: 'reasoning', text: 'internal reasoning' }, 10),
    entry(11, tool, 13),
    entry(14, { type: 'assistant_message', text: 'A done' }, 20),
    entry(21, { type: 'error', message: 'Connection lost' }),
    entry(22, { type: 'notification', message: 'Restored' }),
    entry(23, { type: 'compaction', status: 'completed', trigger: 'auto', preTokens: 100 }),
    entry(24, { type: 'todo', items: [] }),
    entry(25, { type: 'plugin', data: {} }),
  ])
  expect(result.map(item => item.type)).toEqual(['user/message', 'paseo/tool_call', 'assistant/message', 'paseo/error',
    'paseo/notification', 'paseo/compaction'])
  expect(result[0]!.message.content).toEqual([{ type: 'text', text: 'Choose A' }])
  expect(JSON.parse(result[1]!.message.content[0]!.text!)).toEqual({ callId: tool.callId, name: tool.name,
    status: tool.status, detail: tool.detail, error: null })
  expect(JSON.stringify(result)).not.toContain('internal reasoning')
})

it('keeps links stable across stream growth and rejects reuse across epoch or agent changes', () => {
  const original = entry(3, { type: 'assistant_message', text: 'Hello' }, 5)
  const id = projectPaseoTranscript('agent-1', 'epoch-1', [original])[0]!.id
  const next = projectPaseoTranscript('agent-1', 'epoch-1', [entry(1, { type: 'reasoning', text: '' }),
    { ...original, seqEnd: 9, item: { type: 'assistant_message', text: 'Hello again' } },
    entry(10, { type: 'assistant_message', text: 'Next' })])
  expect(next[0]!.id).toBe(id)
  expect(projectPaseoTranscript('agent-2', 'epoch-1', [original])[0]!.id).not.toBe(id)
  expect(projectPaseoTranscript('agent-1', 'epoch-2', [original])[0]!.id).not.toBe(id)
})

it('reports missing bindings and incomplete history instead of returning an empty transcript', async () => {
  const timeline = vi.fn(async () => ({ kind: 'unknown' as const, reason: 'TIMELINE_GAP' }))
  await expect(readPaseoTranscript({ timeline }, undefined)).rejects.toThrow('not bound')
  expect(timeline).not.toHaveBeenCalled()
  await expect(readPaseoTranscript({ timeline }, 'agent-1')).rejects.toThrow('TIMELINE_GAP')
  expect(timeline).toHaveBeenCalledWith('agent-1')
})

it('rejects malformed public messages', () => {
  for (const item of [null, { type: 'user_message' }, { type: 'tool_call' }, { type: 'error', message: null }]) {
    expect(() => projectPaseoTranscript('agent-1', 'epoch-1', [entry(1, item)])).toThrow('Invalid Paseo')
  }
})
