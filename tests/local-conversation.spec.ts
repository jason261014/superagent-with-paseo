import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { LocalConversation } from '../src/local/conversation.ts'
import { conversationRequestId } from '../src/local/protocol.ts'
import { createLocalSource, localTrigger } from '../src/sources/local.ts'
import { KV } from '../src/kv.ts'

const dirs: string[] = [], stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sa-conversation-')); dirs.push(dir)
  const db = join(dir, 'state.sqlite'), store = new Store(db); stores.push(store)
  const conversation = new LocalConversation(store), binding = conversation.bind()
  const local = createLocalSource(store, message => conversation.recordReply(message))
  const receive = vi.fn(request => local.receive(request, trigger => { store.triggers.save(trigger); return 'stored' }))
  return { store, conversation, binding, local, receive, db }
}
it('deduplicates normalized inputs, rejects conflicts and gives each message an independent task thread', () => {
  const { conversation, binding, receive, store } = setup()
  const input = { binding, clientMessageId: 'm-1', text: '  hello  ' }
  const one = conversation.receive(input, receive)
  expect(one.requestId).toBe(conversationRequestId(binding, input.clientMessageId))
  expect(conversation.receive({ ...input, text: 'hello' }, receive)).toMatchObject({ result: 'duplicate', seq: one.seq })
  expect(() => conversation.receive({ ...input, text: 'different' }, receive)).toThrow('LOCAL_REQUEST_CONFLICT')
  const two = conversation.receive({ ...input, clientMessageId: 'm-2', text: 'new task' }, receive)
  expect(store.triggers.get(one.triggerId)!.threads).not.toEqual(store.triggers.get(two.triggerId)!.threads)
  expect(receive).toHaveBeenCalledTimes(2)
  const events = conversation.events().items
  expect(events.filter(item => item.type !== 'status').map(item => item.text)).toEqual(['hello', 'new task'])
  expect(events.filter(item => item.type === 'status').map(item => item.kind)).toEqual(['request.pending', 'request.pending'])
  expect(() => conversation.receive({ ...input, binding: { ...binding, hostId: '0'.repeat(32) } }, receive)).toThrow('LOCAL_CONVERSATION_MISMATCH')
  expect(() => conversation.receive({ ...input, actor: 'fake' } as never, receive)).toThrow()
})
it('rolls back admission and persists reply indexing atomically across database reopen', async () => {
  const { store, conversation, binding, receive, local, db } = setup()
  expect(() => conversation.receive({ binding, clientMessageId: 'failed', text: 'fail' }, () => { throw new Error('admission') })).toThrow('admission')
  expect(conversation.events().highWater).toBe(0)
  const receipt = conversation.receive({ binding, clientMessageId: 'ok', text: 'hello' }, receive)
  const trigger = store.triggers.get(receipt.triggerId)!
  const reply = { id: 'reply-1', channel: trigger.channel!, text: 'done', kind: 'reply' as const }
  const send = () => local.kind.channel!.send({} as never, reply)
  await send(); await send()
  expect(conversation.events().items.filter(item => item.type !== 'status')).toHaveLength(2)
  await local.kind.channel!.send({} as never, { ...reply, id: 'other', channel: localTrigger({ requestId: 'cli', text: 'cli' }).channel! })
  expect(conversation.events().items.filter(item => item.type !== 'status')).toHaveLength(2)
  const reopened = new Store(db); stores.push(reopened)
  const again = new LocalConversation(reopened)
  expect(again.binding()).toEqual(binding)
  expect(again.events()).toEqual(conversation.events())
  expect(again.receipt(receipt.requestId)).toMatchObject({ seq: 1, routing: 'pending' })
})
it('records status notifications once and replays them with the user messages', () => {
  const { conversation } = setup()
  const status = { id: 'status-1', at: '2026-11-09T00:00:00.000Z', text: 'Ticket 已创建', level: 'info' as const, kind: 'ticket.created' }
  expect(conversation.recordStatus(status)).toBe(1)
  expect(conversation.recordStatus(status)).toBeUndefined()
  expect(conversation.events().items).toEqual([expect.objectContaining({ type: 'status', text: 'Ticket 已创建', level: 'info', kind: 'ticket.created' })])
})
it('pages under a fixed upper bound, rejects gaps and invalid cursors, and limits response bytes', () => {
  const { conversation, binding, receive, store } = setup()
  for (let i = 0; i < 10; i++) conversation.receive({ binding, clientMessageId: `m-${i}`, text: '\u0001'.repeat(60_000) }, receive)
  const page = conversation.events(0, 10, 100)
  expect(page.items.length).toBeGreaterThan(0)
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(512 * 1024)
  expect(page.hasMore).toBe(true)
  expect(conversation.events(0, 1, 1)).toMatchObject({ highWater: 1, nextCursor: 1, hasMore: false })
  const highWater = conversation.events().highWater
  expect(() => conversation.events(highWater + 1)).toThrow('LOCAL_CONVERSATION_CURSOR')
  expect(() => conversation.events(0, highWater + 1)).toThrow('LOCAL_CONVERSATION_CURSOR')
  store.delete(KV.conversation.event(2))
  expect(() => conversation.events(1, 3)).toThrow('LOCAL_CONVERSATION_GAP')
})
