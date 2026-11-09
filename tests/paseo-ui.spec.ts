import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProviderEvent, ProviderInput, ProviderConnection } from '@getpaseo/plugin/server/provider'
import { createConversationConnection } from '../src/paseo-ui/connection.ts'
import { pendingInputs } from '../src/paseo-ui/pending.ts'
import type { PendingInputs } from '../src/paseo-ui/pending.ts'
import type { ConversationTransport } from '../src/paseo-ui/transport.ts'
import type { HostStatus } from '../src/hosts/lifecycle.ts'
import { ConversationBinding, conversationRequestId, conversationTextHash, type ConversationInput,
  type ConversationEvent, type ConversationReceiptView } from '../src/local/protocol.ts'

const binding = ConversationBinding.parse({ version: 1, hostId: 'a'.repeat(32), conversationId: 'b'.repeat(32) })
const connections: ProviderConnection[] = [], dirs: string[] = []
afterEach(async () => { for (const connection of connections.splice(0)) await connection.close(); vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const config = { cwd: '/tmp', env: {}, mcpServers: {}, settings: {}, persist: true }
function setup(hostStatus?: () => HostStatus) {
  const intents = new Map<string, ConversationInput>(), receipts = new Map<string, ConversationReceiptView>(), rows: ConversationEvent[] = []
  const pending: PendingInputs = {
    put(input) { const id = input.clientMessageId, old = intents.get(id); if (old && old.text !== input.text) throw new Error('LOCAL_REQUEST_CONFLICT'); intents.set(id, input) },
    list: () => [...intents.values()], remove: input => { intents.delete(input.clientMessageId) },
  }
  const transport: ConversationTransport = {
    binding: vi.fn(async () => binding),
    submit: vi.fn(async input => {
      const requestId = conversationRequestId(binding, input.clientMessageId), old = receipts.get(requestId)
      if (old) { if (old.textHash !== conversationTextHash(input.text)) throw new Error('LOCAL_REQUEST_CONFLICT'); return old }
      const value: ConversationReceiptView = { requestId, textHash: conversationTextHash(input.text), triggerId: input.clientMessageId,
        clientMessageId: input.clientMessageId, seq: rows.length + 1, at: '2026-11-06T00:00:00.000Z', result: 'stored', routing: 'pending' }
      receipts.set(requestId, value); rows.push({ seq: value.seq, id: 'user:' + value.triggerId, type: 'user', text: input.text,
        clientMessageId: input.clientMessageId, triggerId: value.triggerId, at: value.at }); return value
    }),
    receipt: vi.fn(async id => ({ binding, receipt: receipts.get(id) ?? null })),
    events: vi.fn(async (after, through = rows.length) => ({ binding, items: rows.slice(after, through), nextCursor: through, highWater: through, hasMore: false })),
  }
  const connection = createConversationConnection({ transport, pending, capabilities: ['prompt.message', 'session.persistence', 'session.can_stop_runtime'], pollMs: 10, hostStatus })
  connections.push(connection)
  const events: ProviderEvent[] = []; connection.onEvent(event => events.push(event))
  const open = (persistence?: { version: number; data: Record<string, unknown> }) => connection.send({ type: 'session.open', requestId: 'open', sessionId: 'ui',
    config, history: persistence ? 'replay' : 'skip', ...(persistence ? { persistence } : {}) } as ProviderInput)
  const send = (text = 'hello', clientMessageId = 'm1', extra = {}) => connection.send({ type: 'session.prompt', sessionId: 'ui',
    prompt: { clientMessageId, delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text }] }, ...extra } } as ProviderInput)
  return { transport, pending, rows, receipts, intents, events, connection, open, send }
}
const items = (events: ProviderEvent[]) => events.filter((event): event is Extract<ProviderEvent, { type: 'timeline.item' }> => event.type === 'timeline.item')

it('restores a managed conversation when rolling back to the same single host', async () => {
  const fixture = setup()
  await fixture.open({ version: 2, data: { projectId: 'legacy', binding } })
  expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'session.opened',
    persistence: { version: 1, data: binding } }))
  const other = setup()
  await other.open({ version: 2, data: { projectId: 'legacy', binding: { ...binding, hostId: 'c'.repeat(32) } } })
  expect(other.events).toContainEqual(expect.objectContaining({ type: 'request.failed',
    error: { message: 'LOCAL_CONVERSATION_MISMATCH' } }))
  expect(other.transport.submit).not.toHaveBeenCalled()
})

it.each([
  ['starting', '正在启动'], ['needs_setup', '需要完成配置'], ['stopping', '正在停止'], ['stopped', '已停止'], ['error', '启动失败'],
] as const)('reports the %s host before opening or accepting input', async (phase, text) => {
  let status: HostStatus = { phase, detail: 'test host state' }
  const h = setup(() => status)
  await h.open()
  expect(h.transport.binding).not.toHaveBeenCalled()
  expect(h.events).toContainEqual(expect.objectContaining({ type: 'request.failed', error: { message: expect.stringContaining(text) } }))
  status = { phase: 'ready' }
  await h.open()
  status = { phase, detail: 'test host state' }
  await h.send()
  expect(h.transport.submit).not.toHaveBeenCalled()
  expect(h.intents.size).toBe(0)
  expect(h.events).toContainEqual(expect.objectContaining({ type: 'session.prompt_result', result: { type: 'failed', error: { message: expect.stringContaining(text) } } }))
  status = { phase: 'ready' }
  await h.send()
  expect(h.rows).toHaveLength(1)
})

it('completes input after durable receipt and emits a later reply without another model turn', async () => {
  vi.useFakeTimers()
  const h = setup(); await h.open(); await h.send()
  expect(h.events).toContainEqual(expect.objectContaining({ type: 'session.prompt_result', result: { type: 'completed' } }))
  expect(h.intents.size).toBe(0)
  h.rows.push({ seq: 2, id: 'reply:outbox-1', type: 'assistant', text: 'done', at: '2026-11-06T00:00:01.000Z' })
  await vi.advanceTimersByTimeAsync(10)
  expect(items(h.events).map(event => event.item.id)).toEqual(['user:m1', 'reply:outbox-1'])
  expect(h.events.filter(event => event.type === 'session.turn')).toHaveLength(0)
  await h.send('another', 'm2')
  expect(items(h.events).map(event => event.item.id)).toContain('user:m2')
})
it('turns asynchronous status rows into Paseo timeline notifications', async () => {
  vi.useFakeTimers()
  const h = setup(); await h.open(); await h.send()
  h.rows.push({ seq: 2, id: 'status:ticket-1', type: 'status', text: 'Ticket 已创建', at: '2026-11-06T00:00:01.000Z', level: 'info', kind: 'ticket.created' })
  await vi.advanceTimersByTimeAsync(10)
  expect(items(h.events).at(-1)).toMatchObject({ type: 'timeline.item', item: { type: 'notification', level: 'info', message: 'Ticket 已创建' } })
})
it('reconciles a lost submit response with the same identity and rejects changed replay text', async () => {
  const original = setup()
  await original.open()
  const implementation = vi.mocked(original.transport.submit).getMockImplementation()!
  vi.mocked(original.transport.submit).mockImplementationOnce(async input => { await implementation(input); throw new Error('timeout') })
  await original.send()
  expect(original.transport.submit).toHaveBeenCalledTimes(1)
  expect(original.transport.receipt).toHaveBeenCalledTimes(1)
  expect(original.rows).toHaveLength(1)
  await original.send('changed')
  expect(original.events).toContainEqual(expect.objectContaining({ type: 'session.prompt_result', result: { type: 'failed', error: { message: 'LOCAL_REQUEST_CONFLICT' } } }))
})
it('retains unknown submissions and retries the original identity on recovery', async () => {
  vi.useFakeTimers()
  const h = setup(); await h.open()
  vi.mocked(h.transport.submit).mockRejectedValueOnce(new Error('offline'))
  vi.mocked(h.transport.receipt).mockRejectedValueOnce(new Error('offline'))
  await h.send()
  expect(h.intents.size).toBe(1)
  await vi.advanceTimersByTimeAsync(10)
  expect(h.intents.size).toBe(0)
  expect(h.rows).toHaveLength(1)
  expect(h.transport.submit).toHaveBeenLastCalledWith(expect.objectContaining({ clientMessageId: 'm1' }))
})
it('rejects unsupported attachments before persistence and never retries an explicit disabled source', async () => {
  vi.useFakeTimers()
  const h = setup(); await h.open()
  await h.send('', 'attachment', { input: { type: 'message', content: [{ type: 'image', url: 'data:test' }] } })
  expect(h.transport.submit).not.toHaveBeenCalled()
  vi.mocked(h.transport.submit).mockRejectedValueOnce(new Error('LOCAL_SOURCE_DISABLED'))
  await h.send()
  expect(h.intents.size).toBe(0)
  await vi.advanceTimersByTimeAsync(100)
  expect(h.transport.submit).toHaveBeenCalledTimes(1)
})
it('replays history before ready and rejects mismatched restore bindings and malformed pages', async () => {
  const h = setup()
  h.rows.push({ seq: 1, id: 'reply:old', at: '2026-11-06T00:00:00.000Z', type: 'assistant', text: 'old' })
  await h.open({ version: 1, data: binding })
  expect(h.transport.binding).toHaveBeenCalledWith(false)
  expect(h.events.findIndex(event => event.type === 'timeline.item')).toBeLessThan(h.events.findIndex(event => event.type === 'session.ready'))
  const wrong = setup(); await wrong.open({ version: 1, data: { ...binding, hostId: 'c'.repeat(32) } })
  expect(wrong.events).toContainEqual(expect.objectContaining({ type: 'request.failed', error: { message: 'LOCAL_CONVERSATION_MISMATCH' } }))
  const gap = setup(); vi.mocked(gap.transport.events).mockResolvedValue({ binding, items: [], nextCursor: 2, highWater: 2, hasMore: false })
  await gap.open({ version: 1, data: binding })
  expect(gap.events).toContainEqual(expect.objectContaining({ type: 'request.failed', error: { message: 'LOCAL_CONVERSATION_GAP' } }))
})
it('interrupts only UI waiting, retains accepted work and releases polling on close', async () => {
  vi.useFakeTimers()
  const h = setup(); await h.open()
  const deferred = Promise.withResolvers<ConversationReceiptView>(), implementation = vi.mocked(h.transport.submit).getMockImplementation()!
  vi.mocked(h.transport.submit).mockImplementationOnce(() => deferred.promise)
  const send = h.send(); await Promise.resolve(); await Promise.resolve()
  await h.connection.send({ type: 'session.interrupt', sessionId: 'ui', requestId: 'interrupt' })
  deferred.resolve(await implementation({ binding, clientMessageId: 'm1', text: 'hello' })); await send
  expect(h.rows).toHaveLength(1)
  expect(h.events.filter(event => event.type === 'session.prompt_result')).toHaveLength(1)
  await h.connection.send({ type: 'session.can_stop_runtime', sessionId: 'ui', requestId: 'cleanup' })
  expect(h.events).toContainEqual({ type: 'session.can_stop_runtime', sessionId: 'ui', requestId: 'cleanup', canStop: false })
  await h.connection.close(); const count = h.events.length
  await vi.advanceTimersByTimeAsync(100)
  expect(h.events).toHaveLength(count)
})
it('persists transport intents before sending and rejects symlink journals and conflicting identities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-ui-pending-')); dirs.push(dir)
  const pending = pendingInputs(dir), input = { binding, clientMessageId: 'one', text: 'hello' }
  pending.put(input); pending.put(input)
  expect(pendingInputs(dir).list(binding)).toEqual([input])
  expect(() => pending.put({ ...input, text: 'changed' })).toThrow('LOCAL_REQUEST_CONFLICT')
  expect(() => pending.list({ ...binding, hostId: 'c'.repeat(32) })).toThrow('LOCAL_CONVERSATION_MISMATCH')
  pending.remove(input); expect(pending.list(binding)).toEqual([])
  const unsafe = mkdtempSync(join(tmpdir(), 'sa-ui-unsafe-')); dirs.push(unsafe)
  symlinkSync(dir, join(unsafe, 'paseo-ui-pending'))
  expect(() => pendingInputs(unsafe)).toThrow('LOCAL_UNSAFE_UI_JOURNAL')
})
