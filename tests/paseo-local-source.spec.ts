import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Engine, type Assessor, type Executor } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { localKind, localTrigger } from '../src/sources/local.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

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
})
