import { expect, it, vi } from 'vitest'
import type { ProviderEvent, ProviderInput } from '@getpaseo/plugin/server/provider'
import { createProjectConversationConnection } from '../src/paseo-ui/project-router.ts'
import { createConversationConnection } from '../src/paseo-ui/connection.ts'
import type { ProjectManager } from '../src/projects/manager.ts'
import type { ConversationInput, ConversationReceiptView } from '../src/local/protocol.ts'
import { conversationRequestId, conversationTextHash } from '../src/local/protocol.ts'
import type { ConversationTransport } from '../src/paseo-ui/transport.ts'

function setup() {
  const projectIds = ['alpha', 'beta']
  const bindings = Object.fromEntries(projectIds.map((id, index) => [id, { version: 1 as const,
    hostId: String(index + 1).repeat(32), conversationId: String(index + 3).repeat(32) }]))
  const transports = new Map<string, ConversationTransport>(), pending = new Map<string, Map<string, ConversationInput>>()
  for (const id of projectIds) {
    const binding = bindings[id]!, receipts = new Map<string, ConversationReceiptView>()
    pending.set(id, new Map())
    transports.set(id, {
      binding: async () => binding,
      async submit(input) {
        const requestId = conversationRequestId(binding, input.clientMessageId)
        const receipt: ConversationReceiptView = { requestId, clientMessageId: input.clientMessageId, triggerId: id,
          textHash: conversationTextHash(input.text), seq: 1, at: '', result: 'stored', routing: 'routed' }
        receipts.set(requestId, receipt); return receipt
      },
      receipt: async requestId => ({ binding, receipt: receipts.get(requestId) ?? null }),
      events: async () => ({ binding, items: [], highWater: 0, nextCursor: 0, hasMore: false }),
    })
    vi.spyOn(transports.get(id)!, 'submit')
  }
  const manager = {
    registry: { match: (cwd: string) => ({ id: cwd.slice(1) }) },
    ensure: vi.fn(async (id: string) => ({ projectId: id, stateDir: '/' + id, status: () => ({ phase: 'ready' as const }) })),
    shutdown: vi.fn(), act: vi.fn(),
  } as unknown as ProjectManager
  const connection = createProjectConversationConnection({
    manager, capabilities: ['prompt.message', 'session.persistence'], legacyProjectId: 'alpha',
    connectProject: endpoint => createConversationConnection({ capabilities: ['prompt.message', 'session.persistence'],
      transport: transports.get(endpoint.projectId)!, pollMs: 50,
      pending: {
        put: input => { pending.get(endpoint.projectId)!.set(input.clientMessageId, input) },
        list: () => [...pending.get(endpoint.projectId)!.values()],
        remove: input => { pending.get(endpoint.projectId)!.delete(input.clientMessageId) },
      } }),
  })
  const events: ProviderEvent[] = []; connection.onEvent(event => events.push(event))
  const open = (id: string, cwd = '/' + id, persistence?: object) => connection.send({ type: 'session.open', requestId: 'open-' + id,
    sessionId: id, config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: true }, history: persistence ? 'replay' : 'skip',
    ...(persistence ? { persistence } : {}) } as ProviderInput)
  const send = (id: string) => connection.send({ type: 'session.prompt', sessionId: id,
    prompt: { clientMessageId: 'same-id', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: id }] } } } as ProviderInput)
  return { connection, manager, transports, pending, events, bindings, open, send }
}
it('isolates identical message IDs and persists the project instead of the changing cwd', async () => {
  const fixture = setup()
  try {
    await fixture.open('alpha'); await fixture.open('beta')
    await fixture.send('alpha'); await fixture.send('beta')
    expect(fixture.transports.get('alpha')!.submit).toHaveBeenCalledWith(expect.objectContaining({ binding: fixture.bindings.alpha, text: 'alpha' }))
    expect(fixture.transports.get('beta')!.submit).toHaveBeenCalledWith(expect.objectContaining({ binding: fixture.bindings.beta, text: 'beta' }))
    const event = fixture.events.find(event => event.type === 'session.opened' && event.sessionId === 'alpha')
    expect(event).toMatchObject({ persistence: { version: 2, data: { projectId: 'alpha', binding: fixture.bindings.alpha } } })
    await fixture.open('restored', '/beta', { version: 2, data: { projectId: 'alpha', binding: fixture.bindings.alpha } })
    expect(fixture.manager.ensure).toHaveBeenLastCalledWith('alpha', 5000)
  } finally { await fixture.connection.close() }
  expect(fixture.manager.shutdown).not.toHaveBeenCalled(); expect(fixture.manager.act).not.toHaveBeenCalled()
})
it('upgrades the exact legacy binding and rejects forged cross-project restoration', async () => {
  const fixture = setup()
  try {
    await fixture.open('legacy', '/unregistered', { version: 1, data: fixture.bindings.alpha })
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'session.opened', sessionId: 'legacy',
      persistence: { version: 2, data: { projectId: 'alpha', binding: fixture.bindings.alpha } } }))
    await fixture.open('forged', '/beta', { version: 2, data: { projectId: 'beta', binding: fixture.bindings.alpha } })
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'request.failed', requestId: 'open-forged',
      error: { message: 'LOCAL_CONVERSATION_MISMATCH' } }))
    await fixture.open('forged', '/beta', { version: 2, data: { projectId: 'beta', binding: fixture.bindings.beta } })
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'session.opened', sessionId: 'forged' }))
  } finally { await fixture.connection.close() }
})
it('does not open or persist a late connection after close or failed startup', async () => {
  const fixture = setup()
  let finish!: () => void
  vi.mocked(fixture.manager.ensure).mockImplementation(() => new Promise(resolve => { finish = () => resolve({ projectId: 'alpha', stateDir: '/alpha', status: () => ({ phase: 'ready' }) }) }))
  const opening = fixture.open('alpha')
  await fixture.connection.close(); finish(); await opening
  expect(fixture.events.filter(event => event.type === 'session.opened')).toEqual([])
  expect(fixture.pending.get('alpha')!.size).toBe(0)
})
it('reports unconfigured and starting projects without receiving an input', async () => {
  const fixture = setup()
  try {
    vi.mocked(fixture.manager.ensure).mockRejectedValueOnce(new Error('PROJECT_NEEDS_SETUP: repository missing'))
    await fixture.open('alpha')
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: 'request.failed',
      error: { message: 'PROJECT_NEEDS_SETUP: repository missing' } }))
    vi.mocked(fixture.manager.ensure).mockRejectedValueOnce(new Error('PROJECT_STARTING'))
    await fixture.open('beta')
    expect(fixture.pending.get('alpha')!.size).toBe(0)
    expect(fixture.transports.get('alpha')!.submit).not.toHaveBeenCalled()
    expect(fixture.events.filter(event => event.type === 'session.opened')).toEqual([])
  } finally { await fixture.connection.close() }
})
