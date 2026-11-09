import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { Engine, type Candidate, type Policy, type Trigger } from '../src/core/index.ts'
import { PaseoExecutor, type PaseoExecutorHost } from '../src/executor/paseo.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { PaseoOperationJournal } from '../src/paseo-control/journal.ts'
import type { RuntimeSnapshot } from '../src/paseo/client.ts'
import { deferred } from './fixtures/async.ts'

let directory: string
let store: Store
let now: number
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'paseo-executor-')); store = new Store(join(directory, 'db.sqlite')); now = 0 })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

function setup() {
  const effects = new Effects(store, new HealthBoard(), () => now)
  const journal = new PaseoOperationJournal(store.db)
  const candidates: Candidate[] = []
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => false }
  const messages = new Map<string, string>()
  let createdLabels: Record<string, string> = {}
  const runtime: RuntimeSnapshot = { agentId: 'worker-1', cwd: '/work/one', status: 'idle', activeTurn: null, pendingPermissions: [], observedAt: 'now', unknownChildren: true as const }
  const paseo = {
    create: vi.fn(async (input: Parameters<PaseoExecutorHost['paseo']['create']>[0]) => { createdLabels = input.labels!; return { agentId: 'worker-1', cwd: input.cwd } }),
    send: vi.fn(async (_agent: string, text: string, messageId: string) => { messages.set(messageId, text) }),
    findByLabels: vi.fn(async () => ({ kind: 'complete' as const, matches: [{ agentId: 'worker-1', cwd: '/work/one', labels: createdLabels }] })),
    findMessage: vi.fn(async (_agent: string, messageId: string) => messages.has(messageId)
      ? { kind: 'present' as const, entry: {}, epoch: '1' } : { kind: 'absent_confirmed' as const, epoch: '1' }),
    snapshot: vi.fn(async () => runtime),
    interrupt: vi.fn(async () => ({ requestSent: true as const, runtime })),
  }
  let engine: Engine
  const createOptions = vi.fn< PaseoExecutorHost['createOptions'] >(() => ({ cwd: '/work/one', config: { provider: 'codex', modeId: 'default' } }))
  const executor = new PaseoExecutor({ store, effects, journal, paseo, get engine() { return engine },
    createOptions,
    initialText: ticket => `assignment: ${ticket.title}`, inputText: (_ticket, input) => `input: ${input.id}` })
  engine = new Engine({ repo: store, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: candidate => { candidates.push(candidate) } }, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const trigger = (id: string): Trigger => ({ id, source: 'chat', threads: [{ source: 'chat', id: 'thread' }],
    actor: { source: 'chat', id: 'alice' }, human: true, at: '2026-01-01T00:00:00.000Z', text: id, meta: {} })
  function accept() {
    engine.receive(trigger('one')); engine.evaluateDue()
    return engine.decide('one', { kind: 'accept', title: 'Work', scope: 'small', reason: 'requested', evalId: candidates[0]!.evalId }).ticketId!
  }
  const tick = async () => { now += 10000; await effects.idle() }
  return { effects, journal, executor, engine, paseo, messages, trigger, accept, tick, createOptions, getLabels: () => createdLabels }
}

describe('Paseo Executor with real Engine and durable effects', () => {
  it('reconciles a delivered send after reopening SQLite without sending or creating again', async () => {
    const before = setup()
    before.paseo.send.mockImplementationOnce(async () => { throw new Error('reply lost after delivery') })
    const ticketId = before.accept(); before.effects.start(); await before.effects.idle(); await before.effects.drain()
    const messageId = before.paseo.send.mock.calls[0]![2]
    store.close(); store = new Store(join(directory, 'db.sqlite'))
    const after = setup(); now += 10000
    after.effects.start(); await after.effects.idle()
    expect(after.paseo.create).not.toHaveBeenCalled(); expect(after.paseo.send).not.toHaveBeenCalled()
    expect(store.tickets.get(ticketId)!.assignments.at(-1)!.state).toBe('pending')
    after.messages.set(messageId, 'assignment: Work'); await after.tick()
    expect(store.tickets.get(ticketId)!.assignments.at(-1)!.state).toBe('running')
    expect(after.paseo.send).not.toHaveBeenCalled(); await after.effects.drain()
  })
  it('dispatches, sends and records Paseo input consumption before a report, then stops by exact assignment', async () => {
    const h = setup(); const ticketId = h.accept()
    // Intent and domain write share a transaction. Before the effect loop runs, no session exists.
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM effect WHERE kind='paseoLaunch'").get()?.count).toBe(1)
    expect(h.paseo.create).not.toHaveBeenCalled()
    h.effects.start(); await h.effects.idle()
    const ticket = store.tickets.get(ticketId)!, assignment = ticket.assignments.at(-1)!
    expect(assignment.state).toBe('running')
    h.engine.receive(h.trigger('two')); await h.effects.idle()
    const input = store.tickets.get(ticketId)!.inputs[0]!
    expect(input.kind).toBe('trigger')
    if (input.kind === 'trigger') expect(input.readAt).toEqual(expect.any(String))
    expect(h.paseo.send).toHaveBeenCalledTimes(2)
    expect(() => h.executor.report(ticketId, 'wrong-assignment', { state: 'progress', summary: 'stale' })).toThrow()
    h.executor.report(ticketId, assignment.id, { state: 'progress', summary: 'working' })
    h.engine.stopTicket(ticketId); await h.effects.idle()
    expect(h.paseo.interrupt).toHaveBeenCalledWith('worker-1')
    expect(store.db.prepare('SELECT request_sent FROM paseo_stop_observation WHERE ticket_id=? AND assignment_id=?').get(ticketId, assignment.id)?.request_sent).toBe(1)
  })

  it('preserves upstream ready and dropped completion without a separate delivery gate', async () => {
    const h = setup(), ticketId = h.accept(); h.effects.start(); await h.effects.idle()
    h.engine.receive(h.trigger('followup')); await h.effects.idle()
    const assignment = store.tickets.get(ticketId)!.assignments.at(-1)!
    const result = h.executor.report(ticketId, assignment.id, { state: 'ready', summary: 'done' })
    expect(result.ended?.outcome).toBe('completed')
    expect(store.triggers.disposition('followup')?.fanout).toContain(ticketId)
    expect(store.threads.get('chat:thread')?.pending).toEqual([])
    await h.effects.idle()
  })

  it('reconciles a timed-out creation by labels without creating a second session', async () => {
    const h = setup()
    h.paseo.create.mockImplementationOnce(async input => { h.paseo.findByLabels.mockResolvedValueOnce({ kind: 'complete', matches: [{ agentId: 'worker-1', cwd: input.cwd, labels: input.labels! }] }); throw new Error('timeout') })
    const ticketId = h.accept(); h.effects.start(); await h.effects.idle()
    expect(store.tickets.get(ticketId)!.assignments.at(-1)!.state).toBe('pending')
    await h.tick()
    expect(h.paseo.create).toHaveBeenCalledTimes(1)
    expect(h.paseo.findByLabels).toHaveBeenCalledOnce()
    expect(store.tickets.get(ticketId)!.assignments.at(-1)!.state).toBe('running')
  })

  it('does not resend an uncertain missing message; reconciles if later present', async () => {
    const h = setup()
    h.paseo.send.mockImplementationOnce(async () => { throw new Error('timeout') })
    const ticketId = h.accept(); h.effects.start(); await h.effects.idle(); await h.tick()
    expect(h.paseo.send).toHaveBeenCalledTimes(1)
    expect(store.tickets.get(ticketId)!.assignments.at(-1)!.state).toBe('pending')
    const messageId = h.paseo.send.mock.calls[0]![2]
    h.messages.set(messageId, 'assignment: Work')
    await h.tick()
    expect(h.paseo.send).toHaveBeenCalledTimes(1)
    expect(store.tickets.get(ticketId)!.assignments.at(-1)!.state).toBe('running')
  })

  it('waits for an in-flight send to settle before interrupting a stopped assignment', async () => {
    const h = setup(), hold = deferred<void>()
    h.paseo.send.mockImplementationOnce(async () => { await hold.promise })
    const ticketId = h.accept(); h.effects.start()
    await vi.waitFor(() => expect(h.paseo.send).toHaveBeenCalledOnce())
    h.engine.stopTicket(ticketId)
    await Promise.resolve()
    expect(h.paseo.interrupt).not.toHaveBeenCalled()
    hold.resolve(); await h.effects.idle()
    expect(h.paseo.interrupt).toHaveBeenCalledOnce()
    expect(store.tickets.get(ticketId)!.ended).toBeDefined()
  })

  it('rolls back an effect enqueued in a rejected transaction', async () => {
    const h = setup(), ticketId = h.accept()
    const ticket = store.tickets.get(ticketId)!, assignment = ticket.assignments.at(-1)!
    expect(() => store.atomic(() => { h.executor.stop(ticket, assignment, 'rollback'); throw new Error('rollback') })).toThrow('rollback')
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM effect WHERE kind='paseoStop'").get()?.count).toBe(0)
  })
  it('restarts from the persisted create intent and reuses the labeled session', async () => {
    const before = setup()
    let savedLabels: Record<string, string> = {}
    before.paseo.create.mockImplementationOnce(async input => { savedLabels = input.labels!; throw new Error('response lost') })
    const ticketId = before.accept(); before.effects.start(); await before.effects.idle(); await before.effects.drain()
    store.close()
    store = new Store(join(directory, 'db.sqlite'))
    const after = setup()
    after.paseo.findByLabels.mockResolvedValueOnce({ kind: 'complete', matches: [{ agentId: 'worker-1', cwd: '/work/one', labels: savedLabels }] })
    now += 10000; after.effects.start(); await after.effects.idle()
    expect(after.paseo.create).not.toHaveBeenCalled()
    expect(after.paseo.findByLabels).toHaveBeenCalledOnce()
    expect(store.tickets.get(ticketId)!.assignments.at(-1)!.state).toBe('running')
  })

  it('leaves ambiguous create outcomes unresolved and never sends', async () => {
    const h = setup()
    h.paseo.create.mockImplementationOnce(async () => { throw new Error('response lost') })
    h.paseo.findByLabels.mockResolvedValueOnce({ kind: 'complete', matches: [
      { agentId: 'one', cwd: '/work/one', labels: {} }, { agentId: 'two', cwd: '/work/one', labels: {} },
    ] })
    const ticketId = h.accept(); h.effects.start(); await h.effects.idle(); await h.tick()
    expect(h.paseo.create).toHaveBeenCalledTimes(1)
    expect(h.paseo.send).not.toHaveBeenCalled()
    expect(store.tickets.get(ticketId)!.assignments.at(-1)!.state).toBe('pending')
  })

  it('records idle observations but cannot confirm a stop after a sent message without a fence', async () => {
    const h = setup(); const ticketId = h.accept(); h.effects.start(); await h.effects.idle()
    const runtime = await h.paseo.snapshot()
    h.paseo.interrupt.mockResolvedValueOnce({ requestSent: true, runtime: { ...runtime, status: 'running' } })
    h.engine.stopTicket(ticketId); await h.effects.idle()
    expect(h.paseo.interrupt).toHaveBeenCalledOnce()
    expect(store.db.prepare('SELECT request_sent, turn_stopped FROM paseo_stop_observation WHERE ticket_id=?').get(ticketId))
      .toMatchObject({ request_sent: 1, turn_stopped: 0 })
    expect(h.effects.pending('paseoStop')).toBe(false)
    h.paseo.snapshot.mockResolvedValueOnce({ ...runtime, status: 'idle', activeTurn: { id: 'still-active' } })
    const ticket = store.tickets.get(ticketId)!
    h.executor.stop(ticket, ticket.assignments.at(-1)!, 'refresh observation')
    await h.tick()
    expect(h.effects.pending('paseoStop')).toBe(false)
    h.executor.stop(ticket, ticket.assignments.at(-1)!, 'refresh observation')
    await h.tick()
    expect(h.effects.pending('paseoStop')).toBe(false)
    expect(store.db.prepare('SELECT turn_stopped, observed_idle, runtime FROM paseo_stop_observation WHERE ticket_id=?').get(ticketId))
      .toMatchObject({ turn_stopped: 0, observed_idle: 1, runtime: expect.stringContaining('"unknownChildren":true') })
    expect(h.paseo.interrupt).toHaveBeenCalledOnce()
  })

  it('does not interrupt when an uncertain create matches labels at the wrong workspace', async () => {
    const h = setup()
    h.paseo.create.mockImplementationOnce(async () => { throw new Error('response lost') })
    const ticketId = h.accept(); h.effects.start(); await h.effects.idle()
    h.paseo.findByLabels.mockResolvedValue({ kind: 'complete', matches: [{ agentId: 'worker-1', cwd: '/wrong', labels: {} }] })
    h.engine.stopTicket(ticketId); await h.effects.idle()
    expect(h.paseo.interrupt).not.toHaveBeenCalled()
    expect(h.effects.pending('paseoStop')).toBe(true)
  })

  it('retains unproven-stop observations across restart without retrying an acknowledged interrupt', async () => {
    const before = setup()
    before.paseo.send.mockImplementationOnce(async () => { throw new Error('response lost') })
    const ticketId = before.accept(); before.effects.start(); await before.effects.idle()
    const messageId = before.paseo.send.mock.calls[0]![2]
    before.engine.stopTicket(ticketId); await before.effects.idle()
    expect(before.paseo.interrupt).toHaveBeenCalledOnce()
    expect(before.effects.pending('paseoStop')).toBe(false)
    await before.effects.drain(); store.close(); store = new Store(join(directory, 'db.sqlite'))
    const after = setup()
    after.messages.set(messageId, 'assignment: Work')
    now += 10000; after.effects.start(); await after.effects.idle()
    expect(after.effects.pending('paseoStop')).toBe(false)
    expect(after.paseo.interrupt).not.toHaveBeenCalled()
    expect(store.db.prepare('SELECT turn_stopped, observed_idle FROM paseo_stop_observation WHERE ticket_id=?').get(ticketId))
      .toMatchObject({ turn_stopped: 0, observed_idle: 1 })
  })

  it('rejects invalid local configuration before journaling and can proceed once fixed', async () => {
    const h = setup()
    h.createOptions.mockReturnValueOnce({ cwd: '/work/one', config: { provider: 'codex', modeId: '' } })
    const ticketId = h.accept(); h.effects.start(); await h.effects.idle()
    expect(h.paseo.create).not.toHaveBeenCalled()
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM paseo_operation_intent WHERE kind='create'").get()?.count).toBe(0)
    await h.tick()
    expect(h.paseo.create).toHaveBeenCalledOnce()
    expect(store.tickets.get(ticketId)!.assignments.at(-1)!.state).toBe('running')
  })

})
