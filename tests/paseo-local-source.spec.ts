import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Engine, type Assessor, type Executor } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { localKind, localTrigger } from '../src/sources/local.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { createLocalSource } from '../src/sources/local.ts'
import { Effects } from '../src/app/effects.ts'
import { Outbox } from '../src/app/outbox.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { Commands } from '../src/infra/commands.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function setup(acceptRequests: boolean, allowActor: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'local-source-')); dirs.push(dir)
  const db = join(dir, 'state.sqlite')
  const store = new Store(db, () => {})
  const actor = localTrigger({ requestId: 'probe', text: 'probe' }).actor.id
  store.saveSettings(SettingsSchema.parse({ sources: { local: { enabled: true, config: { acceptRequests } } },
    policy: { sources: { local: { allowed: allowActor ? [{ id: actor }] : [] } } } }))
  const sources = new SourceRegistry(() => store.settings()); sources.register(localKind)
  const assessor: Assessor = { request: vi.fn() }
  const executor: Executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const outbox = { send: vi.fn(), status: vi.fn(), withdraw: vi.fn() }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  return { store, engine, sources, executor, db }
}
const request = { requestId: 'request-1', text: 'Investigate the issue' }
const accept = { kind: 'accept' as const, title: 'Investigate', scope: 'Investigate the issue', reason: 'Explicit local request', name: 'investigate' }

describe('local source primitives', () => {
  it('is closed by default, rejects claimed identity and uses an OS account only', () => {
    expect(localKind.scope!({ meta: {} }, localKind.schema.parse({})).listened).toBe(false)
    const trigger = localTrigger(request)
    expect(trigger.actor).toEqual({ source: 'local', id: `uid:${process.getuid!()}` })
    expect(trigger).toMatchObject({ human: true, addressed: 'direct', source: 'local' })
    expect(() => localTrigger({ ...request, actor: 'someone-else' } as never)).toThrow()
    expect(() => localTrigger({ ...request, text: 'a'.repeat(65_537) })).toThrow()
  })

  it('records a closed source as filtered and never starts a task', () => {
    const { engine, executor, store } = setup(false, true)
    const trigger = localTrigger(request)
    expect(engine.receive(trigger)).toBe('filtered')
    expect(store.triggers.disposition(trigger.id)?.filtered?.code).toBe('source_disabled')
    expect(executor.start).not.toHaveBeenCalled()
    store.close()
  })

  it('requires the local account allowlist before a request can be accepted', () => {
    const { engine, executor, store } = setup(true, false)
    const trigger = localTrigger(request)
    expect(engine.receive(trigger)).toBe('stored')
    expect(() => engine.decide(trigger.id, accept)).toThrow()
    expect(executor.start).not.toHaveBeenCalled()
    store.close()
  })

  it('uses the real Engine transaction and Policy to persist one explicit decision', () => {
    const { engine, executor, store, db } = setup(true, true)
    const trigger = localTrigger(request, '2026-01-01T00:00:00.000Z')
    expect(engine.receive(trigger)).toBe('stored')
    expect(engine.receive(trigger)).toBe('duplicate')
    const decision = engine.decide(trigger.id, accept)
    expect(decision.kind).toBe('accept')
    expect(executor.start).toHaveBeenCalledTimes(1)
    const ticketId = decision.ticketId!
    expect(store.tickets.get(ticketId)?.mandate).toMatchObject({ strength: 'explicit', actor: trigger.actor })
    store.close()
    const reopened = new Store(db, () => {})
    expect(reopened.triggers.get(trigger.id)?.text).toBe(request.text)
    expect(reopened.tickets.get(ticketId)?.mandate.actor).toEqual(trigger.actor)
    reopened.close()
  })

  it('runs local questions, follow-ups and results through the original Engine and Outbox', async () => {
    const h = setup(true, true)
    const sources = new SourceRegistry(() => h.store.settings())
    const source = createLocalSource(h.store); sources.register(source.kind)
    const effects = new Effects(h.store, new HealthBoard())
    const commands = new Commands(() => { throw new Error('Local channel must not need deployment') }, {}, new AbortController().signal)
    const outbox = new Outbox({ store: h.store, effects, sources, commands, paused: () => false })
    const engine = new Engine({ repo: h.store, scope: sources, policy: () => settingsPolicy(h.store.settings(), sources),
      assessor: { request: vi.fn() }, executor: h.executor, outbox })
    let closed = false
    try {
      const first = { requestId: 'question-1', threadId: 'conversation', text: 'Implement this' }
      source.receive(first, value => engine.receive(value))
      const origin = localTrigger(first)
      const decision = engine.decide(origin.id, { ...accept, acknowledgement: 'Working on it' })
      const taskId = decision.ticketId!
      const assignmentId = h.store.tickets.get(taskId)!.assignments[0]!.id
      engine.assignmentStarted(taskId, assignmentId)
      effects.start(); await outbox.sent()
      engine.report(taskId, { state: 'progress', summary: 'Need a choice', question: 'Which option?' })
      engine.reply({ purpose: 'attention', ticketId: taskId, question: 'Which option?', text: 'Which option?' })
      await outbox.sent()
      const followup = { requestId: 'answer-1', threadId: 'conversation', text: 'Option A' }
      source.receive(followup, value => engine.receive(value))
      expect(h.executor.deliver).toHaveBeenCalled()
      expect(h.store.triggers.disposition(localTrigger(followup).id)?.fanout).toContain(taskId)
      engine.report(taskId, { state: 'ready', summary: 'Implemented A' })
      // Preserve the upstream ready/completed behavior: this adapter adds no acceptance state machine.
      expect(h.store.tickets.get(taskId)!.ended?.outcome).toBe('completed')
      engine.reply({ purpose: 'result', ticketId: taskId, text: 'Implemented A' })
      await outbox.sent()
      engine.reply({ purpose: 'result', ticketId: taskId, text: 'Implemented A' })
      await outbox.sent()
      expect(source.replies('conversation').map(message => message.text)).toEqual(['Working on it', 'Which option?', 'Implemented A'])
      expect(source.replies('conversation').every(message => !('status' in message))).toBe(true)
      expect(source.replies('other')).toEqual([])
      await effects.drain()
      h.store.close()
      closed = true
      const reopened = new Store(h.db)
      try { expect(createLocalSource(reopened).replies('conversation')).toHaveLength(3) } finally { reopened.close() }
    } finally {
      await effects.drain()
      if (!closed) h.store.close()
    }
  })

  it('rejects conflicting replays atomically and keeps a retry timestamp stable', () => {
    const h = setup(true, true), source = createLocalSource(h.store)
    try {
      expect(source.receive(request, value => h.engine.receive(value), '2026-01-01T00:00:00Z')).toBe('stored')
      expect(source.receive(request, value => h.engine.receive(value), '2026-02-01T00:00:00Z')).toBe('duplicate')
      expect(h.store.triggers.get(localTrigger(request).id)!.at).toBe('2026-01-01T00:00:00.000Z')
      for (const changed of [{ ...request, text: 'different' }, { ...request, threadId: 'different' }]) {
        expect(() => source.receive(changed, value => h.engine.receive(value))).toThrow('LOCAL_REQUEST_CONFLICT')
      }
      const rolledBack = { requestId: 'rolled-back', text: 'will roll back' }
      expect(() => source.receive(rolledBack, trigger => { h.engine.receive(trigger); throw new Error('failure') })).toThrow('failure')
      expect(h.store.triggers.get(localTrigger(rolledBack).id)).toBeUndefined()
    } finally { h.store.close() }
  })

  it('makes channel retries immutable by message identity and rejects foreign addresses', async () => {
    const h = setup(true, true), source = createLocalSource(h.store)
    const commands = new Commands(() => { throw new Error('unexpected deployment') }, {}, new AbortController().signal)
    const message = { id: 'reply-1', text: 'First', kind: 'reply' as const, channel: localTrigger(request).channel! }
    try {
      await expect(source.kind.channel!.send({ commands }, message)).resolves.toBe('sent')
      await expect(source.kind.channel!.send({ commands }, message)).resolves.toBe('sent')
      await expect(source.kind.channel!.send({ commands }, { ...message, text: 'Changed' })).rejects.toThrow('LOCAL_REPLY_CONFLICT')
      await expect(source.kind.channel!.send({ commands }, { ...message, channel: { ...message.channel,
        address: { ...message.channel.address, actorId: 'uid:foreign' } } })).rejects.toThrow('INVALID_LOCAL_CHANNEL')
      expect(source.replies(request.requestId).map(item => item.text)).toEqual(['First'])
    } finally { h.store.close() }
  })
})
