import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { PaseoSessions, type PaseoSessionsHost } from '../src/paseo/sessions.ts'
import type { Ticket, Assignment } from '../src/core/index.ts'

let directory: string
let store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'paseo-sessions-')); store = new Store(join(directory, 'db.sqlite')) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

function setup(overrides: Partial<Omit<PaseoSessionsHost, 'config'>> & { config?: Partial<PaseoSessionsHost['config']> } = {}) {
  const config = { url: 'ws://127.0.0.1:6767/ws', orchestrator: 'claude/one', worker: 'claude/two',
    orchestratorMode: 'auto', workerMode: 'auto', bridgeCommand: '/bin/bridge', bridgeNode: '/custom/node' }
  const host = {
    store,
    prompts: { current: () => ({ revision: 1, config: {} }), compose: () => 'orchestrator prompt', skills: () => [] },
    effects: { handle: vi.fn() },
    masterId: 'master',
    stateDir: directory,
    paseo: {}, journal: {}, bridge: { grant: () => 'token' },
    lifetime: new AbortController().signal, environment: () => [],
    ...overrides,
    config: { ...config, ...overrides.config },
  } as unknown as PaseoSessionsHost
  return new PaseoSessions(host)
}

const ticket = { id: 'ticket-1', title: 'Work', mandate: { strength: 'explicit' },
  execution: { directory: '/work/ticket-1', name: 'work', assignment: '' } } as unknown as Ticket
const assignment = { id: 'assignment-1' } as unknown as Assignment

describe('Paseo worker parent labels', () => {
  it('labels the orchestrator as a child without requiring the entry agent to be a live caller', async () => {
    const create = vi.fn(async (options: Parameters<PaseoSessionsHost['paseo']['create']>[0]) => ({ agentId: 'orchestrator-1', cwd: options.cwd }))
    const sessions = setup({ config: { entryAgentId: 'entry-agent-1' },
      paseo: { create } as unknown as PaseoSessionsHost['paseo'],
      journal: { claim: () => ({ action: 'execute' }), observe: vi.fn() } as unknown as PaseoSessionsHost['journal'] })
    await sessions.ensure('master', '/shared/workspace', 'dsh-superagent orchestrator', 'orchestrator')
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/shared/workspace',
      labels: expect.objectContaining({ 'paseo.parent-agent-id': 'entry-agent-1' }) }))
    expect(create.mock.calls[0]![0].parent).toBeUndefined()
  })
  it('runs a worker in the orchestrator workspace and marks it as a delegated child', () => {
    const sessions = setup()
    store.set('paseo-session:master' as never, { agentId: 'orchestrator-1', revision: 1, options: { cwd: '/shared/workspace' } } as never)
    const options = sessions.workerOptions(ticket, assignment)
    expect(options.cwd).toBe('/shared/workspace')
    expect(options.parent).toBe('orchestrator-1')
    expect(options.config.mcpServers?.superagent).toMatchObject({ command: '/custom/node', args: ['/bin/bridge'] })
    expect(options.labels).toEqual(expect.objectContaining({
      superagentHost: expect.any(String), superagentSession: expect.any(String), 'paseo.parent-agent-id': 'orchestrator-1' }))
  })
  it('keeps the ticket directory and leaves a worker top-level without an orchestrator binding', () => {
    const sessions = setup()
    const options = sessions.workerOptions(ticket, assignment)
    expect(options.cwd).toBe('/work/ticket-1')
    expect(options.labels?.['paseo.parent-agent-id']).toBeUndefined()
  })
})
