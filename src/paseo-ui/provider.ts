/** No-model Paseo conversation provider. Only the Host may admit and execute work. */
import type { ProviderRegistration } from '@getpaseo/plugin/server/provider'
import { isAbsolute } from 'node:path'
import { createConversationConnection } from './connection.ts'
import { conversationTransport } from './transport.ts'
import { pendingInputs } from './pending.ts'

export function createSuperagentProvider(options: { stateDir: string }): ProviderRegistration {
  if (!isAbsolute(options.stateDir)) throw new Error('Superagent stateDir must be absolute')
  return { id: 'superagent', label: 'Superagent', description: 'Converse with the configured local Superagent',
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error('Superagent requires provider protocol v1')
      const capabilities = ['prompt.message', 'session.persistence', 'session.can_stop_runtime'].filter(cap => request.capabilities.includes(cap))
      if (!capabilities.includes('prompt.message') || !capabilities.includes('session.persistence')) throw new Error('Superagent requires persistent message sessions')
      return createConversationConnection({ capabilities, transport: conversationTransport(options.stateDir), pending: pendingInputs(options.stateDir) })
    },
  }
}
