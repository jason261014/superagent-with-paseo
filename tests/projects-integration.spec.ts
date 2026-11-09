import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'tsdown'
import type { ProviderEvent, ProviderInput } from '@getpaseo/plugin/server/provider'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { credentialHelper } from '../src/infra/environment.ts'
import { createProjectManager } from '../src/projects/manager.ts'
import { createProjectConversationConnection } from '../src/paseo-ui/project-router.ts'
import { privateCall, localCall } from '../src/local/transport.ts'
import { conversationRequestId } from '../src/local/protocol.ts'
import { createProjectFixture } from './fixtures/projects.ts'

let output: string
beforeAll(async () => {
  output = mkdtempSync(resolve('.artifacts/multi-build-'))
  await build({ config: resolve('tsdown.config.ts'), outDir: output, dts: false, logLevel: 'silent' })
}, 20_000)
afterAll(() => { if (output) rmSync(output, { recursive: true, force: true }) })

it('runs real isolated applications and original tools through one project provider', async () => {
  const fixture = createProjectFixture(['alpha', 'beta'])
  const wrapper = join(output, 'fixture-host.mjs')
  writeFileSync(wrapper, `import {createPaseoHost as createHost} from ${JSON.stringify(pathToFileURL(join(output, 'paseo-host.js')).href)};
    import {createIntegrationHost} from ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/project-runtime-integration.mjs')).href)};
    export const createPaseoHost=config=>createIntegrationHost(createHost,config,${JSON.stringify(credentialHelper(process.execPath))});`)
  fixture.config.childEntry = join(output, 'paseo-project-child.js'); fixture.config.runtimeEntry = wrapper
  fixture.config.legacyProjectId = 'alpha'
  for (const project of fixture.config.projects) {
    project.hostConfig.flowWeb = { enabled: true, port: 0 }
    const store = new Store(join(project.hostConfig.stateDir, 'orchestrator.sqlite'))
    const settings = store.settings()
    store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: '' },
      sources: { ...settings.sources, github: { enabled: false, config: { repository: 'acme/widgets', cli: process.execPath } },
        local: { enabled: true, config: { acceptRequests: true } } },
      policy: { ...settings.policy, sources: { ...settings.policy.sources, local: { allowed: [{ id: 'uid:' + process.getuid!() }] } } } })
    store.close()
  }
  const manager = createProjectManager(fixture.config)
  const connection = createProjectConversationConnection({ manager, capabilities: ['prompt.message', 'session.persistence'], legacyProjectId: 'alpha' })
  const events: ProviderEvent[] = []; connection.onEvent(event => events.push(event))
  const rows = (id: string) => {
    const database = new DatabaseSync(join(fixture.stateDir(id), 'orchestrator.sqlite'), { readOnly: true })
    try { return database.prepare('SELECT value FROM ticket').all().map(row => JSON.parse(row.value as string)) } finally { database.close() }
  }
  const call = (id: string, role: 'orchestrator' | 'worker', name: string, args: object) => {
    const agents = JSON.parse(readFileSync(join(fixture.stateDir(id), 'fixture-agents.json'), 'utf8')) as [string, { labels: Record<string, string>; config: { mcpServers: { superagent: { env: Record<string, string> } } } }][]
    const agent = agents.find(([, options]) => role === 'worker' ? !!options.labels.superagentAssignment : !options.labels.superagentAssignment)!
    return privateCall(join(fixture.stateDir(id), 'agent-ipc', 's'), 'POST', '/call',
      { requestId: name + ':' + id, name, arguments: args }, agent[1].config.mcpServers.superagent.env.SUPERAGENT_TOOL_TOKEN)
  }
  try {
    await manager.ready
    for (const id of ['alpha', 'beta']) {
      await connection.send({ type: 'session.open', requestId: 'open-' + id, sessionId: id, history: 'skip',
        config: { cwd: fixture.root(id), env: {}, mcpServers: {}, settings: {}, persist: true } } as ProviderInput)
      expect(events).toContainEqual(expect.objectContaining({ type: 'session.ready', sessionId: id }))
      await connection.send({ type: 'session.prompt', sessionId: id,
        prompt: { clientMessageId: 'shared-id', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'Make result for ' + id }] } } } as ProviderInput)
      const opened = events.find(event => event.type === 'session.opened' && event.sessionId === id) as Extract<ProviderEvent, { type: 'session.opened' }>
      const saved = opened.persistence!.data as { binding: Parameters<typeof conversationRequestId>[0] }
      const requestId = conversationRequestId(saved.binding, 'shared-id')
      const receipt = await localCall(fixture.stateDir(id), 'GET', '/paseo/requests/' + requestId) as { receipt: { triggerId: string } }
      await call(id, 'orchestrator', 'orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: receipt.receipt.triggerId,
        title: 'Result ' + id, worktree_name: 'result-' + id, acknowledgement: 'Working ' + id }] })
      await vi.waitFor(() => expect(rows(id)[0]?.assignments.at(-1)?.state).toBe('running'), { timeout: 5000 })
      const ticket = rows(id)[0]
      writeFileSync(join(ticket.execution.directory, 'result.txt'), id)
      await call(id, 'worker', 'orchestrator_report', { state: 'ready', summary: 'result ' + id, human_action: null })
      await call(id, 'orchestrator', 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: 'result ' + id })
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'timeline.item', sessionId: id,
        item: expect.objectContaining({ type: 'assistant_message', text: 'result ' + id }) })), { timeout: 4000 })
      expect(rows(id)[0].ended.outcome).toBe('completed')
      expect(readFileSync(join(ticket.execution.directory, 'result.txt'), 'utf8')).toBe(id)
      const agents = JSON.parse(readFileSync(join(fixture.stateDir(id), 'fixture-agents.json'), 'utf8'))
      expect(agents[1][1].cwd).toBe(realpathSync(fixture.root(id)))
      expect(agents[1][1].parent).toBe(agents[0][0])
    }
    expect(manager.status('alpha').pid).not.toBe(manager.status('beta').pid)
    expect(manager.status('alpha').flowWebUrl).not.toBe(manager.status('beta').flowWebUrl)
    await connection.close()
    expect(manager.status('alpha').host.phase).toBe('ready')
    const workerToken = JSON.parse(readFileSync(join(fixture.stateDir('alpha'), 'fixture-agents.json'), 'utf8'))[1][1].config.mcpServers.superagent.env.SUPERAGENT_TOOL_TOKEN
    await expect(privateCall(join(fixture.stateDir('beta'), 'agent-ipc', 's'), 'POST', '/call',
      { requestId: 'wrong-project', name: 'orchestrator_read', arguments: { resource: 'tickets' } }, workerToken)).rejects.toThrow()
  } finally {
    await connection.close(); await manager.shutdown(4000); fixture.dispose()
  }
}, 20_000)
