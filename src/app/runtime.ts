/** Application composition root and lifecycle manager shared by the DSH and Paseo hosts. */
import type { RuntimeHost, RuntimeBackend, ExecutorPort } from '../hosts/contracts.ts'
import type { SessionPort } from '../paseo/sessions.ts'
import { sourceTrigger } from '../executor/shared.ts'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { createLocalSource, type LocalRequest } from '../sources/local.ts'
import { listenLocal } from '../local/transport.ts'
import { LocalConversation } from '../local/conversation.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import type { HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import type { MainToolsHost } from './tools/main.ts'
import type { ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Implements `SourceHost` and coordinates startup, setup checks, optional HTTP routes, and graceful shutdown. Host adapters own service registration.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly local: ReturnType<typeof createLocalSource>
  readonly conversation: LocalConversation
  private localTransport?: Awaited<ReturnType<typeof listenLocal>>
  private localOpening?: ReturnType<typeof listenLocal>
  readonly commands: Commands
  readonly sessions: SessionPort
  readonly settings: Settings
  readonly executor: ExecutorPort
  private readonly backend: RuntimeBackend
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(private readonly host: RuntimeHost, readonly machine: Machine, restart: () => void) {
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { host.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      if (machine.localEntry) {
        const settings = store.settings()
        if (!settings.sources.local) {
          const uid = `uid:${process.getuid?.() ?? 0}`
          const workspace = machine.workspaceDir
          const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
          const prepare = workspace
            ? `if git -C ${quote(workspace)} rev-parse --git-dir >/dev/null 2>&1; then git -C ${quote(workspace)} worktree add --detach "$DSH_SUPERAGENT_DIR" HEAD; fi`
            : undefined
          store.saveSettings({ ...settings,
            sources: { ...settings.sources, local: { enabled: true, config: { acceptRequests: true } } },
            policy: { ...settings.policy, sources: { ...settings.policy.sources, local: { allowed: [{ id: uid }], admission: {} } } },
            ...prepare ? { executor: { ...settings.executor, prepare } } : {} })
        }
      }
      if (host.runId) {
        const previous = store.get(KV.host.lifecycle)
        if (previous && previous.phase !== 'stopped') host.logger.warn('Superagent is recovering after an unfinished host shutdown')
        store.set(KV.host.lifecycle, { version: 1, runId: host.runId, phase: 'running', at: now() })
      }
      const setup = this.setup = new Setup({ logger: host.logger, runWorker: host.runWorker, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu,
        () => setup.configured() && !!setup.deployment.repository)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const conversation = this.conversation = new LocalConversation(store)
      this.local = createLocalSource(store, message => conversation.recordReply(message))
      this.disposers.push(sources.register(this.local.kind))
      const links: LinkHost = { store, conversation, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const resources: ResourceHost = { store, conversation, pages: new TextCache(4_000_000), prompts, commands, masterId,
        transcript: id => this.backend.transcript(id),
        modelCatalog: () => host.modelCatalog(),
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      this.backend = host.backend({ runtime: this, links, health: board, runWorker: host.runWorker, sourceLink: link,
        tools: () => this.toolHost, closing: () => this.closing(), paused: () => this.paused() })
      const sessions = this.sessions = this.backend.sessions
      this.executor = this.backend.executor
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, lifetime: this.lifetime, sessions,
        validateModel: host.validateModel, sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { logger: host.logger, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  /** Trusted local operator path. The socket supplies access control; the Engine still applies Source/Policy admission. */
  receiveLocal(request: LocalRequest): ReceiveResult {
    if (!this.localStatus().accepting) throw new Error('LOCAL_SOURCE_DISABLED')
    return this.local.receive(request, trigger => this.passes.receive(trigger))
  }
  private localStatus() {
    if (this.closing() || this.lifetime.aborted) return { configured: this.configured(), paused: true, accepting: false, actor: `uid:${process.getuid?.()}` }
    const source = this.sources.instance('local')
    return { configured: this.configured(), paused: this.paused(),
      accepting: !this.closing() && !this.lifetime.aborted && !!source?.enabled && source.config.acceptRequests === true,
      actor: `uid:${process.getuid?.()}` }
  }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    if (this.host.mountHttp) this.disposers.push(this.host.mountHttp(this.httpHost()))
    if (this.machine.localRequests) {
      this.localTransport = await (this.localOpening = listenLocal(this.machine.stateDir, {
        receive: request => this.receiveLocal(request), replies: thread => this.local.replies(thread), status: () => this.localStatus(),
        conversation: this.conversation,
      }))
      this.lifetime.addEventListener('abort', () => { void this.localTransport?.close() }, { once: true })
      if (this.closing() || this.lifetime.aborted) { await this.localTransport.close(); return }
    }
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    if (this.closing() || this.lifetime.aborted) return
    await this.backend.start()
    if (this.closing() || this.lifetime.aborted) return
    await this.sessions.ensure(this.masterId, this.machine.workspaceDir ?? this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.host.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true
    if (this.host.runId) this.store.set(KV.host.lifecycle, { version: 1, runId: this.host.runId, phase: 'stopping', at: now(), shutdownReason: 'host_stop' })
    const passes = this.passes.stop(), effects = this.effects.drain()
    this.assessor.stop()
    this.stopped.abort()
    const backend = this.backend.quiesce()
    // A cancelled startup may still own asynchronous work. Never release its database underneath it.
    await this.ready.catch(() => {})
    await this.localOpening?.then(transport => transport.close(), () => {})
    await Promise.all([passes, effects, backend])
    await this.backend.stop()
    for (const dispose of this.disposers.reverse()) dispose()
    {
      this.setup.restore()
      if (this.host.runId) this.store.set(KV.host.lifecycle, { version: 1, runId: this.host.runId, phase: 'stopped', at: now(), shutdownReason: 'host_stop' })
      try { this.store.close() } finally {
        await this.releaseLock?.().catch((error: unknown) => {
          this.host.logger.warn('Superagent could not release its state directory lock: %s', String(error))
        })
      }
    }
  }
}
