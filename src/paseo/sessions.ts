/** Upstream session operations backed by Paseo; domain state stays in the official host. */
import type { PaseoAgentCreateOptions } from '@getpaseo/client'
import type { Sessions } from '../app/sessions.ts'
import type { Store } from '../app/store.ts'
import type { Prompts, PromptVersion } from '../app/prompts.ts'
import type { Effects } from '../app/effects.ts'
import type { Variable } from '../app/execution-environment.ts'
import type { Ticket, Assignment } from '../core/index.ts'
import { key } from '../core/index.ts'
import { mandateInstructions, workerSessionId } from '../executor/dsh.ts'
import { family, KV } from '../kv.ts'
import type { PaseoAdapter } from './client.ts'
import { PaseoOperationJournal } from '../paseo-control/journal.ts'
import type { PaseoToolBridge, ToolBinding } from './bridge.ts'
import { bridgeSocketPath } from './bridge.ts'
import { agentVariables } from '../infra/environment.ts'

export interface PaseoConfig { url: string; orchestrator: string; worker: string; orchestratorMode: string; workerMode: string; bridgeCommand: string }
type Binding = { agentId: string; revision: number; options: PaseoAgentCreateOptions }
const bindings = family<Binding>('paseo-session:')
const configs = family<{ options: PaseoAgentCreateOptions; revision: number }>('paseo-session-config:')
const notices = family<{ text: string; summary: string } | null>('paseo-notice:')
const messages = family<{ text: string; revision: number; notices: { key: string; text: string }[] }>('paseo-message:')
export type SessionPort = Pick<Sessions, 'prompt' | 'relay' | 'notify' | 'delivery' | 'status' | 'promptVersion' | 'mayRead' | 'modelRetry' | 'install' | 'dispose'> & {
  ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<unknown>
}
export interface PaseoSessionsHost {
  store: Store; prompts: Prompts; effects: Effects; masterId: string; stateDir: string; config: PaseoConfig
  paseo: PaseoAdapter; journal: PaseoOperationJournal; bridge: PaseoToolBridge; lifetime: AbortSignal
  environment(ticket: Ticket): Variable[]
}
/** Implements the narrow Session lifecycle and delivery port over Paseo agents. */
export class PaseoSessions implements SessionPort {
  constructor(private readonly host: PaseoSessionsHost) {
    host.effects.handle('relay', ({ text }, id) => this.prompt(host.masterId, id, text, 'steer'), { ordered: true })
    host.effects.handle('notice', async ({ value, summary }, name) => {
      host.store.set(notices(name), { text: JSON.stringify(value), summary })
    }, { ordered: true })
  }
  install(): void {}
  dispose(): void {}
  agentId(id: string): string | undefined { return this.host.store.get(bindings(id))?.agentId }
  private instructions(version: PromptVersion, ticket?: Ticket): string {
    return '[dsh-superagent prompt revision ' + version.revision + ']\n'
      + this.host.prompts.compose(version.config, ticket ? 'worker' : 'orchestrator', ticket ? this.host.environment(ticket) : undefined)
      + '\n' + (ticket ? mandateInstructions(ticket.mandate) : '')
      + '\nRuntime: Paseo. Use the superagent MCP tools with their original orchestrator_* names. Reports, questions and replies must use those tools; ordinary chat text is not a report. End the turn when waiting; never sleep or poll for input. Do not call the operator socket. Do not start subagents or detached/background jobs in this prototype: their lifecycle is not tracked here. Skills below are the registered Superagent skill text.\n'
      + this.host.prompts.skills(version.config).map(([name, text]) => '\n<skill name=' + JSON.stringify(name) + '>\n' + text + '\n</skill>').join('\n')
  }
  private options(id: string, binding: ToolBinding, cwd: string, title: string, ticket?: Ticket) {
    const saved = this.host.store.get(configs(id))
    if (saved) return saved
    const version = this.host.prompts.current(), config = this.host.config
    const token = this.host.bridge.grant(binding)
    const options: PaseoAgentCreateOptions = { cwd, title, config: {
      provider: ticket ? config.worker : config.orchestrator, modeId: ticket ? config.workerMode : config.orchestratorMode,
      systemPrompt: this.instructions(version, ticket), mcpServers: { superagent: { type: 'stdio',
        command: process.execPath, args: [config.bridgeCommand], env: { SUPERAGENT_TOOL_SOCKET: bridgeSocketPath(this.host.stateDir),
          SUPERAGENT_TOOL_TOKEN: token }, alwaysLoad: true } },
    }, env: { ...Object.fromEntries(Object.entries(agentVariables(this.host.stateDir)).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      GH_TOKEN: '', GITHUB_TOKEN: '', GIT_CONFIG_COUNT: '0', PATH: process.env.PATH ?? '',
      ...(ticket ? Object.fromEntries(this.host.environment(ticket).map(item => [item.key, item.value])) : {}) },
      labels: { superagentHost: key(this.host.stateDir), superagentSession: binding.sessionId } }
    const value = { options, revision: version.revision }
    this.host.store.set(configs(id), value)
    return value
  }
  workerOptions(ticket: Ticket, assignment: Assignment): PaseoAgentCreateOptions {
    return this.options('worker:' + ticket.id + ':' + assignment.id, { role: 'worker', sessionId: workerSessionId(ticket.id),
      ticketId: ticket.id, assignmentId: assignment.id }, ticket.execution!.directory, ticket.title, ticket).options
  }
  workerCreated(ticket: Ticket, assignment: Assignment, agentId: string): void {
    const saved = this.host.store.get(configs('worker:' + ticket.id + ':' + assignment.id))!
    this.bind(workerSessionId(ticket.id), { agentId, ...saved })
  }
  private bind(id: string, binding: Binding): void {
    this.host.store.set(bindings(id), binding)
    const revisions = this.host.store.get(KV.sessions.prompts(id)) ?? []
    this.host.store.set(KV.sessions.prompts(id), [...revisions.filter(value => value !== binding.revision), binding.revision])
  }
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<Binding> {
    const old = this.host.store.get(bindings(id))
    if (old) return old
    if (role !== 'orchestrator') throw new Error('Paseo workers require an assignment binding')
    const saved = this.options(id, { role, sessionId: id }, cwd, title)
    const operationId = 'paseo-session-' + key(id), assignmentId = 'session'
    const claim = this.host.journal.claim({ kind: 'create', operationId, ticketId: id, assignmentId, cwd, payload: JSON.stringify(saved.options) })
    let agentId: string
    if (claim.action === 'confirmed') agentId = claim.resultId
    else if (claim.action === 'execute') agentId = (await this.host.paseo.create(saved.options)).agentId
    else {
      const found = await this.host.paseo.findByLabels(saved.options.labels!)
      if (found.kind !== 'complete' || found.matches.length !== 1 || found.matches[0]!.cwd !== cwd) throw new Error('Paseo coordinator creation unresolved')
      agentId = found.matches[0]!.agentId
    }
    this.host.journal.observe({ kind: 'create', operationId, ticketId: id, assignmentId, sessionIds: [agentId] })
    const binding = { agentId, ...saved }; this.bind(id, binding); return binding
  }
  async prompt(id: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void, accepted?: () => void): Promise<void> {
    if (typeof mode === 'object') throw new Error('Paseo does not support silent history injection')
    this.host.lifetime.throwIfAborted()
    const binding = this.host.store.get(bindings(id))
    if (!binding) throw new Error('Paseo session is not bound')
    const messageId = 'superagent-' + key(id + ':' + requestId)
    let frozen = this.host.store.get(messages(messageId))
    if (!frozen) {
      const version = this.host.prompts.current()
      const pending = id === this.host.masterId ? this.host.store.keys(notices).flatMap(name => {
        const value = this.host.store.get(name); return value ? [{ key: name, text: value.text }] : []
      }) : []
      const prefix = version.revision !== this.promptVersion(id).revision ? this.instructions(version) : ''
      frozen = { text: [prefix, ...pending.map(item => 'Background notice: ' + item.text), text].filter(Boolean).join('\n\n'),
        revision: version.revision, notices: pending }
      this.host.store.set(messages(messageId), frozen)
    }
    authorize?.()
    const operationId = messageId, assignmentId = 'session'
    const claim = this.host.journal.claim({ kind: 'send', operationId, ticketId: id, assignmentId,
      sessionId: binding.agentId, messageId, payload: JSON.stringify({ text: frozen.text }) })
    if (claim.action === 'execute') { authorize?.(); await this.host.paseo.send(binding.agentId, frozen.text, messageId) }
    else if (claim.action !== 'confirmed' && (await this.host.paseo.findMessage(binding.agentId, messageId)).kind !== 'present') {
      throw new Error('Paseo session delivery unresolved; not resent')
    }
    this.host.journal.observe({ kind: 'send', operationId, ticketId: id, assignmentId, sessionId: binding.agentId, messageId, present: true })
    this.bind(id, { ...binding, revision: frozen.revision })
    for (const notice of frozen.notices) if (this.host.store.get<{ text: string }>(notice.key)?.text === notice.text) this.host.store.set(notice.key, null)
    accepted?.()
  }
  relay(id: string, text: string): void { this.host.effects.enqueue('relay', id, { text }) }
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) || this.host.store.get(notices(name)) ? 'pending' : 'injected'
  }
  status() {
    return { revision: this.host.prompts.current().revision, sessions: this.host.store.keys(bindings).flatMap(name => {
      const binding = this.host.store.get(name)
      return binding ? [{ sessionId: name.slice(bindings.prefix.length), revision: binding.revision }] : []
    }), notificationPending: this.host.effects.pending('notice', 'prompts') || !!this.host.store.get(notices('prompts')) }
  }
  promptVersion(id: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(id))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  mayRead(id: string, revision: number): boolean {
    return this.promptVersion(id).revision === revision || (this.host.store.get(KV.sessions.prompts(id)) ?? []).includes(revision)
  }
  modelRetry(_id: string | undefined) { return {} }
  async shutdown(): Promise<void> {
    await Promise.allSettled(this.host.store.keys(bindings).map(async name => {
      const binding = this.host.store.get(name)
      if (!binding) return
      const observed = await this.host.paseo.snapshot(binding.agentId)
      if (observed.agentId === binding.agentId && observed.cwd === binding.options.cwd && observed.status !== 'idle') {
        await this.host.paseo.interrupt(binding.agentId)
      }
    }))
  }
}
