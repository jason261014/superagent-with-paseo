import type { ProviderConnection, ProviderEvent, ProviderInput } from '@getpaseo/plugin/server/provider'
import { ConversationBinding } from '../local/protocol.ts'
import { ProjectPersistenceSchema } from './project-persistence.ts'
import type { ProjectEndpoint, ProjectManager } from '../projects/manager.ts'
import { createConversationConnection } from './connection.ts'
import { conversationTransport } from './transport.ts'
import { pendingInputs } from './pending.ts'

export function createProjectConversationConnection(options: {
  capabilities: readonly string[]; manager: ProjectManager; legacyProjectId?: string
  connectProject?: (endpoint: ProjectEndpoint) => ProviderConnection
}): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>()
  const connections = new Map<string, ProviderConnection>(), sessions = new Map<string, string>()
  const opening = new Map<string, { cancelled: boolean }>()
  const openRequests = new Map<string, string>()
  let closed = false
  const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event) }
  const connection = (endpoint: ProjectEndpoint) => {
    let delegate = connections.get(endpoint.projectId)
    if (!delegate) {
      delegate = options.connectProject?.(endpoint) ?? createConversationConnection({
        capabilities: options.capabilities, transport: conversationTransport(endpoint.stateDir),
        pending: pendingInputs(endpoint.stateDir), hostStatus: endpoint.status,
      })
      delegate.onEvent(event => {
        if (event.type === 'request.failed') {
          const sessionId = openRequests.get(event.requestId)
          if (sessionId) { sessions.delete(sessionId); openRequests.delete(event.requestId) }
        }
        if (event.type === 'session.opened' && event.requestId) openRequests.delete(event.requestId)
        if ((event.type === 'session.opened' || event.type === 'session.persistence') && event.persistence) {
          const binding = ConversationBinding.parse(event.persistence.data)
          emit({ ...event, persistence: { version: 2, data: { projectId: endpoint.projectId, binding } } })
        } else emit(event)
      })
      connections.set(endpoint.projectId, delegate)
    }
    return delegate
  }
  const open = async (input: Extract<ProviderInput, { type: 'session.open' }>) => {
    if (sessions.has(input.sessionId) || opening.has(input.sessionId)) throw new Error('PROJECT_SESSION_ALREADY_OPEN')
    const attempt = { cancelled: false }; opening.set(input.sessionId, attempt)
    try {
      let projectId: string, binding: ConversationBinding | undefined
      if (input.persistence?.version === 2) {
        const saved = ProjectPersistenceSchema.parse(input.persistence).data
        projectId = saved.projectId; binding = saved.binding
      } else if (input.persistence) {
        if (input.persistence.version !== 1 || !options.legacyProjectId) throw new Error('PROJECT_LEGACY_BINDING_REQUIRED')
        projectId = options.legacyProjectId; binding = ConversationBinding.parse(input.persistence.data)
      } else projectId = (await options.manager.resolve(input.config.cwd)).id
      const endpoint = await options.manager.ensure(projectId, 5000)
      if (closed || attempt.cancelled) return
      const delegate = connection(endpoint)
      sessions.set(input.sessionId, projectId)
      openRequests.set(input.requestId, input.sessionId)
      await delegate.send({ ...input, ...(binding ? { persistence: { version: 1, data: binding } } : {}) })
    } finally { if (opening.get(input.sessionId) === attempt) opening.delete(input.sessionId) }
  }
  return {
    version: 1, capabilities: [...options.capabilities],
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async send(input) {
      if (closed) throw new Error('Provider closed')
      try {
        if (input.type === 'catalog') { emit({ type: 'catalog', requestId: input.requestId, catalog: { models: [], modes: [] } }); return }
        if (input.type === 'session.open') { await open(input); return }
        if (!('sessionId' in input)) throw new Error('PROJECT_UNSUPPORTED_OPERATION')
        if (input.type === 'session.close' && opening.has(input.sessionId)) {
          opening.get(input.sessionId)!.cancelled = true
          emit({ type: 'session.closed', sessionId: input.sessionId }); return
        }
        const projectId = sessions.get(input.sessionId), delegate = projectId && connections.get(projectId)
        if (!delegate) throw new Error('PROJECT_SESSION_NOT_OPEN')
        await delegate.send(input)
        if (input.type === 'session.close') sessions.delete(input.sessionId)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'PROJECT_REQUEST_FAILED'
        if ('requestId' in input) emit({ type: 'request.failed', requestId: input.requestId, error: { message } })
        else if (input.type === 'session.prompt') emit({ type: 'session.prompt_result', sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId, result: { type: 'failed', error: { message } } })
      }
    },
    async close() {
      closed = true
      for (const attempt of opening.values()) attempt.cancelled = true
      await Promise.allSettled([...connections.values()].map(delegate => delegate.close()))
      sessions.clear(); connections.clear(); openRequests.clear(); listeners.clear()
    },
  }
}
