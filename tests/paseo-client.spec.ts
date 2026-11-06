import { describe, expect, it, vi } from 'vitest'
import type { PaseoClient } from '@getpaseo/client'
import { buildStopArgs, createPaseoAdapter } from '../src/paseo/client.ts'

function fixture() {
  const state = {
    pages: [] as unknown[], history: [] as unknown[], agent: { id: 'agent-001', cwd: '/tmp/work', status: 'idle' } as unknown,
  }
  const handle = {
    id: 'agent-001',
    refresh: vi.fn(async () => ({ agent: state.agent })), current: vi.fn(() => state.agent),
    send: vi.fn(async () => {}), archive: vi.fn(async () => ({ archivedAt: '2026-01-01' })),
    timeline: { refetch: vi.fn(async () => state.history.shift()) },
  }
  const client = {
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    agents: { ref: vi.fn(() => handle), create: vi.fn(async () => handle), list: vi.fn(async () => {
      const page = state.pages.shift()
      if (page instanceof Error) throw page
      return page
    }) },
  }
  const exec = vi.fn(async () => {})
  const adapter = createPaseoAdapter({ url: 'ws://127.0.0.1:6767/ws',
    createClient: () => client as unknown as PaseoClient, exec })
  return { state, client, handle, exec, adapter }
}

const page = (entries: unknown[], hasMore: boolean, nextCursor: string | null = null) => ({ entries, pageInfo: { hasMore, nextCursor } })
const entry = (id: string, task = 'task-1') => ({ agent: { id, cwd: '/tmp/work', labels: { task } } })
const history = (entries: unknown[], hasOlder: boolean, startCursor: unknown = null, extra: object = {}) =>
  ({ entries, hasOlder, startCursor, epoch: 'e1', gap: false, staleCursor: false, ...extra })
const timelineEntry = (seqStart: number, seqEnd = seqStart) =>
  ({ seqStart, seqEnd, timestamp: '2026-11-06T00:00:00Z', item: { type: 'assistant_message', text: `Message ${seqStart}` } })

describe('Paseo session adapter', () => {
  it('accepts only loopback URLs and safe, exact stop targets', () => {
    expect(() => createPaseoAdapter({ url: 'ws://10.0.0.1:6767/ws' })).toThrow('INVALID_PASEO_URL')
    expect(() => createPaseoAdapter({ url: 'ws://localhost:6767/ws?other=1' })).toThrow('INVALID_PASEO_URL')
    expect(buildStopArgs('127.0.0.1:6767', 'agent-001', 'agent-001')).toEqual(['stop', 'agent-001', '--host', '127.0.0.1:6767', '--json'])
    expect(() => buildStopArgs('127.0.0.1:6767', '--all', '--all')).toThrow('INVALID_STOP_TARGET')
    expect(() => buildStopArgs('127.0.0.1:6767', 'agent', 'agent-001')).toThrow('INVALID_STOP_TARGET')
  })

  it('creates only with an explicit mode, and sends a caller-stable message ID', async () => {
    const { adapter, handle, client } = fixture()
    await expect(adapter.create({ cwd: '/tmp/work', config: { provider: 'codex/test' } })).rejects.toThrow('INVALID_CREATE_OPTIONS')
    await expect(adapter.create({ cwd: '/tmp/work', config: { provider: 'codex/test', modeId: 'default' }, prompt: 'hello' })).rejects.toThrow('INITIAL_MESSAGE_ID_REQUIRED')
    await expect(adapter.create({ cwd: '/tmp/work', config: { provider: 'codex/test', modeId: 'default' }, labels: { task: 'task-1' } }))
      .resolves.toEqual({ agentId: 'agent-001', cwd: '/tmp/work' })
    await adapter.send('agent-001', 'hello', 'message-001')
    expect(handle.send).toHaveBeenCalledWith('hello', { messageId: 'message-001' })
    await expect(adapter.send('agent-001', 'hello', '')).rejects.toThrow('INVALID_MESSAGE_ID')
    expect(client.connect).toHaveBeenCalledTimes(1)
    await adapter.close()
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it('waits for the same connection before concurrent operations', async () => {
    const { adapter, client, handle } = fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    client.connect.mockImplementation(() => gate)
    const one = adapter.send('agent-001', 'a', 'm-1')
    const two = adapter.send('agent-001', 'b', 'm-2')
    await Promise.resolve()
    expect(client.connect).toHaveBeenCalledTimes(1)
    expect(handle.send).not.toHaveBeenCalled()
    release()
    await Promise.all([one, two])
    expect(handle.send).toHaveBeenCalledTimes(2)
  })

  it('reads all label pages, includes archived, validates and deduplicates exact matches', async () => {
    const { adapter, state, client } = fixture()
    state.pages.push(page([entry('agent-001'), entry('agent-002', 'other')], true, 'next'),
      page([entry('agent-001'), entry('agent-003')], false))
    expect(await adapter.findByLabels({ task: 'task-1' })).toEqual({ kind: 'complete', matches: [
      { agentId: 'agent-001', cwd: '/tmp/work', labels: { task: 'task-1' } },
      { agentId: 'agent-003', cwd: '/tmp/work', labels: { task: 'task-1' } },
    ] })
    expect(client.agents.list).toHaveBeenNthCalledWith(1, { filter: { labels: { task: 'task-1' }, includeArchived: true }, page: { limit: 50 } })
    expect(client.agents.list).toHaveBeenNthCalledWith(2, { filter: { labels: { task: 'task-1' }, includeArchived: true }, page: { limit: 50, cursor: 'next' } })
  })

  it('does not turn missing pagination information, repeated cursor or errors into absence', async () => {
    for (const pages of [
      [{ entries: [] }],
      [page([], true, null)],
      [page([], true, 'a'), page([], true, 'a')],
      [page([entry('agent-001')], true, 'next'), new Error('offline')],
      [page([{ agent: { id: 'bad id', labels: {} } }], false)],
    ]) {
      const { adapter, state } = fixture(); state.pages.push(...pages)
      expect((await adapter.findByLabels({ task: 'task-1' })).kind).toBe('unknown')
    }
  })

  it('distinguishes a known message from complete, gapped and partial histories', async () => {
    const { adapter, state } = fixture()
    const cursor = { epoch: 'e1', seq: 7 }
    state.history.push(history([], true, cursor), history([{ item: { type: 'user_message', messageId: 'm-1' } }], false))
    expect((await adapter.findMessage('agent-001', 'm-1')).kind).toBe('present')
    state.history.push(history([], false))
    expect((await adapter.findMessage('agent-001', 'm-1')).kind).toBe('absent_confirmed')
    state.history.push(history([], false, null, { gap: true }))
    expect((await adapter.findMessage('agent-001', 'm-1')).kind).toBe('unknown')
    state.history.push(history([], true, cursor), history([], false, null, { epoch: 'e2' }))
    expect((await adapter.findMessage('agent-001', 'm-1')).kind).toBe('unknown')
    state.history.push(history([], true, cursor), history([], true, cursor))
    expect((await adapter.findMessage('agent-001', 'm-1')).kind).toBe('unknown')
  })

  it('keeps a failed or timed-out stop request outcome unknown', async () => {
    const { adapter, exec } = fixture()
    await adapter.snapshot('agent-001')
    exec.mockRejectedValueOnce(new Error('timeout'))
    expect(await adapter.interrupt('agent-001')).toMatchObject({ requestSent: null })
  })

  it('reads the full timeline chronologically and deduplicates identical page overlap', async () => {
    const { adapter, state, handle } = fixture()
    const cursor = { epoch: 'e1', seq: 7 }
    state.history.push(history([timelineEntry(7, 9), timelineEntry(10)], true, cursor),
      history([timelineEntry(1, 6), timelineEntry(7, 9)], false))
    expect(await adapter.timeline('agent-001')).toEqual({ kind: 'complete', epoch: 'e1',
      entries: [timelineEntry(1, 6), timelineEntry(7, 9), timelineEntry(10)] })
    expect(handle.timeline.refetch).toHaveBeenNthCalledWith(2, { direction: 'before', cursor, limit: 200 })
    state.history.push(history([], false))
    expect(await adapter.timeline('agent-001')).toEqual({ kind: 'complete', epoch: 'e1', entries: [] })
  })

  it('never publishes an incomplete, reset, changing or malformed transcript as complete', async () => {
    const cursor = { epoch: 'e1', seq: 7 }
    for (const pages of [
      [history([], false, null, { gap: true })],
      [history([], false, null, { reset: true })],
      [history([], false, null, { staleCursor: true })],
      [history([], false, null, { error: 'missing' })],
      [history([], true, cursor), history([], false, null, { epoch: 'e2' })],
      [history([], true, cursor), history([], true, cursor)],
      [history([], true, cursor), history([], true, { epoch: 'e1', seq: 8 })],
      [history([], true, { epoch: 'e2', seq: 7 })],
      [history([], true)],
      [history([timelineEntry(-1)], false)],
      [history([timelineEntry(1, 0)], false)],
      [history([timelineEntry(1, 4), timelineEntry(3, 5)], false)],
      [history([timelineEntry(7)], true, cursor), history([timelineEntry(7, 9)], false)],
      [history([timelineEntry(7)], true, cursor), history([{ ...timelineEntry(7), item: { type: 'assistant_message', text: 'changed' } }], false)],
      [history([timelineEntry(7)], true, cursor)],
      Array.from({ length: 20 }, (_, i) => history([timelineEntry(100 - i)], true, { epoch: 'e1', seq: 100 - i })),
    ]) {
      const { adapter, state } = fixture(); state.history.push(...pages)
      expect((await adapter.timeline('agent-001')).kind).toBe('unknown')
    }
  })

  it('never stops or archives an ID that was only supplied or returned as another ID', async () => {
    const { adapter, exec, state, handle } = fixture()
    await adapter.send('agent-001', 'hello', 'm-1')
    await expect(adapter.interrupt('agent-001')).rejects.toThrow('UNKNOWN_AGENT')
    state.agent = { id: 'agent-001-full', cwd: '/tmp/work', status: 'running' }
    await adapter.snapshot('agent-001')
    await expect(adapter.interrupt('agent-001')).rejects.toThrow('UNKNOWN_AGENT')
    expect(exec).not.toHaveBeenCalled()
    state.agent = { id: 'agent-001', cwd: '/tmp/work', status: 'running' }
    await adapter.snapshot('agent-001')
    expect(await adapter.interrupt('agent-001')).toMatchObject({ requestSent: true, runtime: { status: 'running', unknownChildren: true } })
    expect(exec).toHaveBeenCalledWith('paseo', ['stop', 'agent-001', '--host', '127.0.0.1:6767', '--json'], { timeout: 10_000, shell: false })
    await adapter.archive('agent-001')
    expect(handle.archive).toHaveBeenCalledTimes(1)
  })
})
