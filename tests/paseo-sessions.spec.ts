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

function setup() {
  const host = {
    store,
    prompts: { current: () => ({ revision: 1, config: {} }), compose: () => 'orchestrator prompt', skills: () => [] },
    effects: { handle: vi.fn() },
    masterId: 'master',
    stateDir: directory,
    config: { url: 'ws://127.0.0.1:6767/ws', orchestrator: 'claude/one', worker: 'claude/two',
      orchestratorMode: 'auto', workerMode: 'auto', bridgeCommand: '/bin/bridge', bridgeNode: '/custom/node' },
    paseo: {}, journal: {}, bridge: { grant: () => 'token' },
    lifetime: new AbortController().signal, environment: () => [],
  } as unknown as PaseoSessionsHost
  return new PaseoSessions(host)
}

const ticket = { id: 'ticket-1', title: 'Work', mandate: { strength: 'explicit' },
  execution: { directory: '/work/ticket-1', name: 'work', assignment: '' } } as unknown as Ticket
const assignment = { id: 'assignment-1' } as unknown as Assignment

describe('Paseo worker parent labels', () => {
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
