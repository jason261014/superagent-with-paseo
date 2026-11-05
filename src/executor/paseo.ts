/** Optional Paseo Executor building block. Not installed in Runtime; callers supply frozen inputs and a worker report bridge. */
import { createHash } from 'node:crypto'
import type { PaseoAgentCreateOptions } from '@getpaseo/client'
import type { Effects } from '../app/effects.ts'
import type { Store } from '../app/store.ts'
import { liveTicket, type Assignment, type EngineForExecutor, type Executor, type Ticket, type TicketInput, type WorkerReport } from '../core/index.ts'
import type { PaseoAdapter } from '../paseo/client.ts'
import { PaseoOperationJournal, type Intent } from '../paseo-control/journal.ts'

export interface PaseoExecutorHost {
  store: Pick<Store, 'db' | 'atomic' | 'tickets'>
  effects: Pick<Effects, 'enqueue' | 'handle'>
  journal: PaseoOperationJournal
  paseo: Pick<PaseoAdapter, 'create' | 'send' | 'findByLabels' | 'findMessage' | 'snapshot' | 'interrupt'>
  engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'deliveryFailed' | 'reportForAssignment'>
  /** Must return the same frozen configuration on replay. This slice accepts only cwd, config (provider/modeId), and labels. */
  createOptions(ticket: Ticket, assignment: Assignment): PaseoAgentCreateOptions
  /** Deterministic, durable text; source content and permissions are supplied by the caller. */
  initialText(ticket: Ticket, assignment: Assignment): string
  inputText(ticket: Ticket, input: TicketInput): string
}
function id(kind: string, ...parts: string[]): string {
  return `paseo-${kind}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`
}
function labels(ticketId: string, assignmentId: string): Record<string, string> {
  return { superagentTicket: ticketId, superagentAssignment: assignmentId }
}
function unsettled(reason: string): never { throw new Error(`Paseo operation unresolved: ${reason}`) }

/**
 * Engine calls synchronously enqueue durable effects in its own Store transaction. Network writes occur only after
 * commit. A journal claim that has ever been attempted is reconciled, never blindly retried on absence.
 */
export class PaseoExecutor implements Executor {
  private readonly inflight = new Map<string, Set<Promise<void>>>()
  constructor(private readonly host: PaseoExecutorHost) {
    host.store.db.exec(`CREATE TABLE IF NOT EXISTS paseo_stop_observation (
      ticket_id TEXT NOT NULL, assignment_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      request_sent INTEGER, runtime TEXT, turn_stopped INTEGER NOT NULL DEFAULT 0, observed_idle INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(ticket_id, assignment_id)
    )`)
    const columns = host.store.db.prepare("PRAGMA table_info('paseo_stop_observation')").all()
    if (!columns.some(column => column.name === 'turn_stopped')) host.store.db.exec('ALTER TABLE paseo_stop_observation ADD COLUMN turn_stopped INTEGER NOT NULL DEFAULT 0')
    if (!columns.some(column => column.name === 'observed_idle')) host.store.db.exec('ALTER TABLE paseo_stop_observation ADD COLUMN observed_idle INTEGER NOT NULL DEFAULT 0')
    host.effects.handle('paseoLaunch', payload => this.track(id('key', payload.ticketId, payload.assignmentId), () => this.launch(payload.ticketId, payload.assignmentId)))
    host.effects.handle('paseoDelivery', payload => this.track(id('key', payload.ticketId, payload.assignmentId), () => this.deliverPending(payload.ticketId, payload.assignmentId)))
    host.effects.handle('paseoStop', payload => this.stopQueued(payload.ticketId, payload.assignmentId))
  }
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('paseoLaunch', id('key', ticket.id, assignment.id), { ticketId: ticket.id, assignmentId: assignment.id })
  }
  deliver(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('paseoDelivery', id('key', ticket.id, assignment.id), { ticketId: ticket.id, assignmentId: assignment.id })
  }
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.host.effects.enqueue('paseoStop', id('key', ticket.id, assignment.id), { ticketId: ticket.id, assignmentId: assignment.id, reason })
  }
  /** Only exact-current, running assignments can report. Not ready for a live bridge: a report can arrive before launch marks running and needs durable buffering/replay. Final reports require versioned delivery acceptance. */
  report(ticketId: string, assignmentId: string, report: WorkerReport): Ticket {
    if (report.state === 'ready' || report.state === 'dropped') throw new Error('Final reports require a verified delivery flow')
    return this.host.engine.reportForAssignment(ticketId, assignmentId, report)
  }
  private async track(assignmentId: string, run: () => Promise<void>): Promise<void> {
    const pending = this.inflight.get(assignmentId) ?? new Set<Promise<void>>()
    this.inflight.set(assignmentId, pending)
    const task = run()
    pending.add(task)
    try { await task } finally { pending.delete(task); if (!pending.size) this.inflight.delete(assignmentId) }
  }
  private current(ticketId: string, assignmentId: string, state: 'pending' | 'running'): { ticket: Ticket; assignment: Assignment } | undefined {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket?.assignments.at(-1)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== state ||
      ticket.assignments.filter(item => item.state === 'running').length > (state === 'running' ? 1 : 0)) return undefined
    return { ticket, assignment }
  }
  private async findCreated(ticketId: string, assignmentId: string, cwd?: string): Promise<string> {
    const result = await this.host.paseo.findByLabels(labels(ticketId, assignmentId))
    if (result.kind !== 'complete') return unsettled('creation lookup incomplete')
    if (result.matches.length !== 1) return unsettled(`creation matches: ${result.matches.length}`)
    const match = result.matches[0]!
    if (cwd !== undefined && match.cwd !== cwd) return unsettled('creation workspace mismatch')
    return match.agentId
  }
  private async created(ticket: Ticket, assignment: Assignment): Promise<string> {
    const base = this.host.createOptions(ticket, assignment)
    // Fail locally before recording an intent. This slice deliberately limits the SDK surface so that it can validate every accepted field.
    if (!base || typeof base !== 'object' || Object.keys(base).some(key => !['cwd', 'config', 'labels'].includes(key)) ||
      typeof base.cwd !== 'string' || !base.cwd.startsWith('/') || base.cwd.includes('\0') ||
      !base.config || typeof base.config !== 'object' || Object.keys(base.config).some(key => !['provider', 'modeId'].includes(key)) ||
      typeof base.config.provider !== 'string' || !base.config.provider.trim() ||
      typeof base.config.modeId !== 'string' || !base.config.modeId.trim() ||
      (base.labels !== undefined && (!base.labels || typeof base.labels !== 'object' || Array.isArray(base.labels) ||
        Object.entries(base.labels).some(([key, value]) => !key || typeof value !== 'string' || !value)))) {
      throw new Error('Invalid or unsupported Paseo create options')
    }
    const input: PaseoAgentCreateOptions = { ...base, labels: { ...base.labels, ...labels(ticket.id, assignment.id) } }
    const intent: Intent = { kind: 'create', operationId: id('create', ticket.id, assignment.id), ticketId: ticket.id,
      assignmentId: assignment.id, cwd: input.cwd, payload: JSON.stringify(input) }
    const claim = this.host.journal.claim(intent)
    if (claim.action === 'confirmed') return claim.resultId
    let agentId: string
    if (claim.action === 'execute') agentId = (await this.host.paseo.create(input)).agentId
    else agentId = await this.findCreated(ticket.id, assignment.id, input.cwd)
    const confirmed = this.host.journal.observe({ kind: 'create', operationId: intent.operationId, ticketId: ticket.id,
      assignmentId: assignment.id, sessionIds: [agentId] })
    if (confirmed.action !== 'confirmed') return unsettled('creation confirmation')
    return confirmed.resultId
  }
  private async send(ticketId: string, assignmentId: string, agentId: string, messageId: string, text: string): Promise<void> {
    if (typeof text !== 'string' || !text || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(messageId) ||
      typeof agentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(agentId)) throw new Error('Invalid Paseo message')
    const intent: Intent = { kind: 'send', operationId: id('send', ticketId, assignmentId, messageId), ticketId, assignmentId,
      sessionId: agentId, messageId, payload: JSON.stringify({ text }) }
    const claim = this.host.journal.claim(intent)
    if (claim.action === 'confirmed') return
    if (claim.action === 'execute') await this.host.paseo.send(agentId, text, messageId)
    else {
      const found = await this.host.paseo.findMessage(agentId, messageId)
      if (found.kind !== 'present') return unsettled('message delivery cannot be confirmed')
    }
    this.host.journal.observe({ kind: 'send', operationId: intent.operationId, ticketId, assignmentId, sessionId: agentId, messageId, present: true })
  }
  private async launch(ticketId: string, assignmentId: string): Promise<void> {
    const initial = this.current(ticketId, assignmentId, 'pending')
    if (!initial) return
    const agentId = await this.created(initial.ticket, initial.assignment)
    if (!this.current(ticketId, assignmentId, 'pending')) return
    const text = this.host.initialText(initial.ticket, initial.assignment)
    await this.send(ticketId, assignmentId, agentId, id('initial', ticketId, assignmentId), text)
    this.host.store.atomic(() => {
      if (this.current(ticketId, assignmentId, 'pending')) this.host.engine.assignmentStarted(ticketId, assignmentId)
    })
  }
  private async deliverPending(ticketId: string, assignmentId: string): Promise<void> {
    const created = this.host.journal.findCreate(ticketId, assignmentId)
    if (!created?.resultId) return unsettled('no confirmed assignment session')
    for (;;) {
      const current = this.current(ticketId, assignmentId, 'running')
      const inputId = current?.ticket.undelivered[0]
      if (!current || !inputId) return
      const input = current.ticket.inputs.find(item => item.id === inputId)
      if (!input) throw new Error('Pending input missing')
      try { await this.send(ticketId, assignmentId, created.resultId, id('input', ticketId, assignmentId, inputId), this.host.inputText(current.ticket, input)) }
      catch (error) {
        this.host.store.atomic(() => { if (this.current(ticketId, assignmentId, 'running')) this.host.engine.deliveryFailed(ticketId, assignmentId, String(error)) })
        throw error
      }
      this.host.store.atomic(() => {
        const fresh = this.current(ticketId, assignmentId, 'running')
        if (fresh?.ticket.undelivered.includes(inputId)) this.host.engine.inputsDelivered(ticketId, assignmentId, [inputId])
      })
    }
  }
  private async stopQueued(ticketId: string, assignmentId: string): Promise<void> {
    // An in-process send/create must settle before interrupt, so it cannot wake the worker after the interrupt.
    await Promise.allSettled([...this.inflight.get(id('key', ticketId, assignmentId)) ?? []])
    if (this.current(ticketId, assignmentId, 'running') || this.current(ticketId, assignmentId, 'pending')) throw new Error('Cannot stop a current assignment')
    const create = this.host.journal.findCreate(ticketId, assignmentId)
    if (!create) return // no create intent existed, so this executor never issued one
    if (!create.cwd) return unsettled('creation workspace was not recorded')
    const agentId = create.resultId ?? await this.findCreated(ticketId, assignmentId, create.cwd)
    // A message visible in the timeline may still be queued for a later turn. There is no verified
    // backend fence, so even a previously confirmed send prevents final stop confirmation.
    for (const send of this.host.journal.unresolvedSends(ticketId, assignmentId)) {
      if (send.sessionId !== agentId) return unsettled('send bound to another session')
    }
    const hasSends = this.host.journal.hasSends(ticketId, assignmentId)
    const previous = this.host.store.db.prepare('SELECT request_sent FROM paseo_stop_observation WHERE ticket_id=? AND assignment_id=?').get(ticketId, assignmentId)
    // Refresh gives the adapter exact-ID evidence before allowing interruption, and is a fresh observation on replay.
    let observed = await this.host.paseo.snapshot(agentId)
    if (observed.agentId !== agentId || (observed.status === 'unknown' && !previous)) return unsettled('stop target not observed')
    if (observed.cwd !== create.cwd) return unsettled('stop target workspace mismatch')
    let requestSent: true | null = previous?.request_sent === 1 ? true : null
    if (!previous) {
      const result = await this.host.paseo.interrupt(agentId)
      requestSent = result.requestSent
      if (result.runtime) observed = result.runtime
      else observed = { ...observed, status: 'unknown', activeTurn: null }
    }
    const idle = observed.agentId === agentId && observed.status === 'idle' && observed.activeTurn === null
    const stopped = idle && !hasSends
    this.host.store.db.prepare(`INSERT INTO paseo_stop_observation(ticket_id, assignment_id, agent_id, request_sent, runtime, turn_stopped, observed_idle)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ticket_id, assignment_id) DO UPDATE SET agent_id=excluded.agent_id,
      request_sent=excluded.request_sent, runtime=excluded.runtime, turn_stopped=excluded.turn_stopped, observed_idle=excluded.observed_idle`).run(ticketId, assignmentId, agentId,
        requestSent === true ? 1 : null, JSON.stringify(observed), stopped ? 1 : 0, idle ? 1 : 0)
    if (!stopped) return unsettled(hasSends ? 'no backend fence for prior sends' : 'stop is not yet observed')
  }
}
