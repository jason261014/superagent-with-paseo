/** No-model Paseo conversation provider. Only the Host may admit and execute work. */
import type { ProviderRegistration } from '@getpaseo/plugin/server/provider'
import { isAbsolute } from 'node:path'
import { createConversationConnection } from './connection.ts'
import { conversationTransport } from './transport.ts'
import { pendingInputs } from './pending.ts'
import type { HostStatus } from '../hosts/lifecycle.ts'
import type { ProjectManager } from '../projects/manager.ts'
import { createProjectConversationConnection } from './project-router.ts'

export function createProjectProvider(options: { manager: ProjectManager; legacyProjectId?: string }): ProviderRegistration {
  return { id: 'superagent', label: 'Superagent', description: 'Converse with the Superagent for this project',
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error('Superagent requires provider protocol v1')
      const capabilities = ['prompt.message', 'session.persistence', 'session.can_stop_runtime'].filter(cap => request.capabilities.includes(cap))
      if (!capabilities.includes('prompt.message') || !capabilities.includes('session.persistence')) throw new Error('Superagent requires persistent message sessions')
      return createProjectConversationConnection({ ...options, capabilities })
    },
  }
}

export function createSuperagentProvider(options: { stateDir: string; hostStatus?: () => HostStatus }): ProviderRegistration {
  if (!isAbsolute(options.stateDir)) throw new Error('Superagent stateDir must be absolute')
  return { id: 'superagent', label: 'Superagent', description: 'Converse with the configured local Superagent',
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error('Superagent requires provider protocol v1')
      const capabilities = ['prompt.message', 'session.persistence', 'session.can_stop_runtime'].filter(cap => request.capabilities.includes(cap))
      if (!capabilities.includes('prompt.message') || !capabilities.includes('session.persistence')) throw new Error('Superagent requires persistent message sessions')
      return createConversationConnection({ capabilities, transport: conversationTransport(options.stateDir), pending: pendingInputs(options.stateDir), hostStatus: options.hostStatus })
    },
  }
}
