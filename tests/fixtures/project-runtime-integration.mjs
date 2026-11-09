import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function createIntegrationHost(createHost, config, helper) {
  const file = join(config.stateDir, 'fixture-agents.json')
  let saved = []
  try { saved = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  const agents = new Map(saved), sent = new Set()
  const adapter = {
    async create(options) {
      const agentId = 'fixture-agent-' + agents.size
      agents.set(agentId, options); writeFileSync(file, JSON.stringify([...agents]), { mode: 0o600 })
      return { agentId, cwd: options.cwd }
    },
    async send(agentId, text, messageId) { sent.add(messageId) },
    async findByLabels(labels) {
      return { kind: 'complete', matches: [...agents].filter(([, options]) => Object.entries(labels).every(([key, value]) => options.labels[key] === value))
        .map(([agentId, options]) => ({ agentId, cwd: options.cwd, labels: options.labels })) }
    },
    async findMessage(agentId, messageId) { return sent.has(messageId) ? { kind: 'present', entry: {}, epoch: '1' } : { kind: 'unknown', reason: 'not_seen' } },
    async timeline() { return { kind: 'complete', epoch: '1', entries: [] } },
    async snapshot(agentId) { return { agentId, cwd: agents.get(agentId)?.cwd ?? '', status: 'idle', activeTurn: null, pendingPermissions: [], observedAt: '', unknownChildren: true } },
    async interrupt() { return { requestSent: true, runtime: null } },
    async archive() { return { archivedAt: new Date().toISOString() } },
    async close() {},
  }
  const runWorker = async ({ argv }) => {
    if (argv.includes('user')) return JSON.stringify({ login: 'fixture-bot', id: 7 })
    if (argv.includes('repos/acme/widgets')) return JSON.stringify({ name: 'acme/widgets', push: true })
    if (argv.includes('credential.https://github.com.helper')) return `file:${config.stateDir}/worker-gitconfig\0${helper}\0`
    return ''
  }
  return createHost(config, { runWorker, createAdapter: () => adapter })
}
