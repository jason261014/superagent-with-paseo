/** Read-only projections from the live Store into deterministic flow-canvas nodes, edges, and evidence. */
import type { DatabaseSync } from 'node:sqlite'
import type { Store } from '../app/store.ts'
import type { Receipt } from '../app/store.ts'
import type { Assignment, Decision, Ticket, Trigger, TriggerDisposition } from '../core/index.ts'
import { KV } from '../kv.ts'
import {
  SWIMLANE_X,
  type FlowCanvasEdge,
  type FlowCanvasNode,
  type FlowHostPhase,
  type FlowInputRecord,
  type FlowItemView,
  type FlowListFilter,
  type FlowOperationEvidence,
  type FlowOverviewItem,
  type FlowOverviewResponse,
  type FlowRelatedTicketSummary,
  type FlowReportRecord,
  type FlowTimelineEntry,
  type FlowUnknownNote,
  type SafeSessionIdentity,
} from './model.ts'

export { SWIMLANE_X } from './model.ts'

type StoreLike = Pick<Store, 'get' | 'keys' | 'db' | 'tickets' | 'decisions' | 'triggers' | 'receipts'>
type HostSnapshot = { phase: FlowHostPhase; detail?: string }

const REPORT_STATES = new Set(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'])
const ROW_HEIGHT = 150
const LANE_TOP = 60
const MAX_TIMELINE = 600

const row = <T>(db: DatabaseSync, sql: string, ...values: (string | number | null)[]): T[] => {
  try { return db.prepare(sql).all(...values) as T[] } catch { return [] }
}
const scalar = (db: DatabaseSync, sql: string, ...values: (string | number | null)[]): number => {
  try {
    const value = db.prepare(sql).get(...values) as { n?: number | null } | undefined
    return Number(value?.n ?? 0)
  } catch { return 0 }
}
const preview = (text: string, limit = 160): string => text.replace(/\s+/g, ' ').trim().slice(0, limit)
const timeOf = (value: string | undefined | null): number => {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}
const maxIso = (values: (string | undefined)[]): string => values.filter((v): v is string => !!v).sort((a, b) => timeOf(b) - timeOf(a))[0] ?? ''

function parseOptions(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {}
  const value = raw as Record<string, unknown>
  return value.options && typeof value.options === 'object' ? value.options as Record<string, unknown> : value
}

/** Only allowlisted identity fields leave the process; prompts, env vars, MCP tokens, and skills never do. */
function safeIdentity(sessionKey: string, role: 'orchestrator' | 'worker', options: Record<string, unknown>, agentId: string | null,
  confirmation: SafeSessionIdentity['confirmation'], revision?: number): SafeSessionIdentity {
  const nested = options.config && typeof options.config === 'object' ? options.config as Record<string, unknown> : {}
  const strings = (name: string, fallback?: string): string | undefined => {
    if (typeof options[name] === 'string' && options[name]) return options[name] as string
    if (typeof nested[name] === 'string' && nested[name]) return nested[name] as string
    return fallback && typeof nested[fallback] === 'string' && nested[fallback] ? nested[fallback] as string : undefined
  }
  const rawProvider = strings('provider')
  const slash = rawProvider?.indexOf('/') ?? -1
  const provider = slash > 0 ? rawProvider!.slice(0, slash) : rawProvider
  const model = strings('model') ?? (slash > 0 ? rawProvider!.slice(slash + 1) : undefined)
  const mode = strings('mode', 'modeId')
  return {
    sessionKey,
    role,
    agentId,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(mode ? { mode } : {}),
    ...(strings('cwd') ? { startupCwd: strings('cwd') } : {}),
    ...(strings('parent') ? { parentAgentId: strings('parent') } : {}),
    ...(revision === undefined ? {} : { revision }),
    confirmation,
  }
}

function binding(store: StoreLike, sessionKey: string): { agentId?: string; revision?: number; options?: unknown } | undefined {
  return store.get<{ agentId: string; revision: number; options: unknown }>(`paseo-session:${sessionKey}`)
}
function frozenConfig(store: StoreLike, ticketId: string, assignmentId: string): { revision?: number; options?: unknown } | undefined {
  return store.get<{ revision: number; options: unknown }>(`paseo-session-config:worker:${ticketId}:${assignmentId}`)
}

interface IntentRow {
  operation_id: string; ticket_id: string; assignment_id: string; kind: 'create' | 'send'
  message_id: string; session_id: string; result_id: string | null; cwd: string
}
function intents(store: StoreLike): IntentRow[] {
  return row<IntentRow>(store.db, 'SELECT operation_id, ticket_id, assignment_id, kind, message_id, session_id, result_id, cwd FROM paseo_operation_intent ORDER BY rowid')
}
function safeFrozenText(store: StoreLike, messageId: string): string | undefined {
  const value = store.get<{ text?: unknown }>(`paseo-message:${messageId}`)
  return typeof value?.text === 'string' ? value.text : undefined
}
function coordinatorIntentsFor(store: StoreLike, masterId: string | undefined, ticketId: string, triggerId?: string): IntentRow[] {
  if (!masterId) return []
  return intents(store).filter(intent => intent.ticket_id === masterId && intent.assignment_id === 'session'
    && intent.kind === 'send' && (() => {
      const text = safeFrozenText(store, intent.message_id)
      if (!text) return false
      return text.includes(ticketId) || (!!triggerId && text.includes(triggerId))
    })())
}

interface ReportRow { seq: number; ticket_id: string; assignment_id: string; request_id: string; payload: string; result: string | null }
function reportsFor(store: StoreLike, ticketId: string): ReportRow[] {
  return row<ReportRow>(store.db, 'SELECT seq, ticket_id, assignment_id, request_id, payload, result FROM paseo_report_receipt WHERE ticket_id = ? ORDER BY seq', ticketId)
}
function receiptRows(store: StoreLike, ticketId: string): Receipt[] {
  return row<{ value: string }>(store.db, 'SELECT value FROM outbox ORDER BY rowid')
    .map(item => JSON.parse(item.value) as Receipt)
    .filter(item => item.ticketId === ticketId)
}

function reportsOf(store: StoreLike, ticket: Ticket, assignment: Assignment): FlowReportRecord[] {
  const receipts = reportsFor(store, ticket.id).filter(item => item.assignment_id === assignment.id)
  const records: FlowReportRecord[] = receipts.map(item => {
    let payload: { state?: unknown; summary?: unknown; question?: unknown } = {}
    let result: { reported?: unknown; notification?: unknown; refused?: unknown } = {}
    try { payload = JSON.parse(item.payload) as typeof payload } catch { /* recorded payload stays opaque */ }
    try { result = item.result ? JSON.parse(item.result) as typeof result : {} } catch { /* result stays opaque */ }
    const state = typeof payload.state === 'string' ? payload.state : 'unknown'
    const summary = typeof payload.summary === 'string' ? payload.summary : ''
    const latest = assignment.report
    const matchesLatest = !!latest && latest.state === state && latest.summary === summary
    return {
      seq: item.seq,
      requestId: item.request_id,
      state,
      summary,
      ...(typeof payload.question === 'string' ? { question: payload.question } : {}),
      at: matchesLatest ? latest.at : null,
      ...(matchesLatest ? { timestampNote: 'recorded_on_latest_assignment' as const } : { timestampNote: 'timestamp_not_recorded' as const }),
      accepted: result.reported === true,
      ...(typeof result.notification === 'string' ? { notification: result.notification } : {}),
      ...(typeof result.refused === 'string' ? { refused: result.refused } : {}),
    }
  })
  const latest = assignment.report
  if (latest && !records.some(record => record.state === latest.state && record.summary === latest.summary)) {
    records.push({ seq: 0, requestId: '', state: latest.state, summary: latest.summary,
      at: latest.at, timestampNote: 'recorded_on_latest_assignment', accepted: true })
  }
  return records
}

function workerIdentity(store: StoreLike, ticket: Ticket, assignment: Assignment, _masterId: string | undefined): SafeSessionIdentity {
  const config = frozenConfig(store, ticket.id, assignment.id)
  const create = intents(store).find(intent => intent.ticket_id === ticket.id && intent.assignment_id === assignment.id && intent.kind === 'create')
  const latest = ticket.assignments.at(-1)?.id === assignment.id
  const current = latest ? (binding(store, `worker-${ticket.id}`) ?? binding(store, `worker:${ticket.id}`) ?? binding(store, `worker:${ticket.id}:${assignment.id}`)) : undefined
  const options = Object.keys(parseOptions(config?.options)).length ? parseOptions(config?.options) : parseOptions(current?.options)
  const agentId = create?.result_id ?? current?.agentId ?? null
  const sessionKey = latest ? `worker-${ticket.id}` : `worker:${ticket.id}:${assignment.id}`
  return safeIdentity(sessionKey, 'worker', options, agentId,
    create?.result_id ? 'confirmed' : current?.agentId ? 'bound_only' : 'unconfirmed',
    config?.revision ?? current?.revision)
}

function orchestrationIdentity(store: StoreLike, masterId: string | undefined): SafeSessionIdentity | undefined {
  if (!masterId) return undefined
  const current = binding(store, masterId)
  if (!current) return undefined
  return safeIdentity(masterId, 'orchestrator', parseOptions(current.options), current.agentId ?? null, 'bound_only', current.revision)
}

function latestDecisionOf(store: StoreLike, disposition: TriggerDisposition | undefined): Decision | undefined {
  return disposition?.decisionId ? store.decisions.get(disposition.decisionId) : undefined
}

function ticketStatus(ticket: Ticket): string {
  if (ticket.ended) return ticket.ended.outcome
  if (ticket.attention) return 'attention'
  const latest = ticket.assignments.at(-1)
  return latest?.state ?? 'open'
}

function relatedTicketIds(store: StoreLike, triggerId: string, disposition: TriggerDisposition | undefined, receiptTicketId: string | undefined): string[] {
  const ids = new Set<string>()
  for (const id of disposition?.fanout ?? []) ids.add(id)
  if (receiptTicketId) ids.add(receiptTicketId)
  const decision = latestDecisionOf(store, disposition)
  for (const reason of decision?.reason ?? []) {
    if (reason.values?.ticket) ids.add(reason.values.ticket)
  }
  for (const ticket of store.tickets.list()) {
    if (ticket.decisionId && disposition?.decisionId === ticket.decisionId) ids.add(ticket.id)
    if (ticket.origin.triggerId === triggerId || ticket.origin.triggerIds.includes(triggerId)) ids.add(ticket.id)
    if (ticket.inputs.some(input => ('triggerId' in input) && input.triggerId === triggerId)) ids.add(ticket.id)
  }
  return [...ids].filter(id => !!store.tickets.get(id)).sort()
}

function conversationRequests(store: StoreLike): { requestId: string; triggerId?: string; at: string; text: string }[] {
  const high = store.get<number>(KV.conversation.seq) ?? 0
  const result: { requestId: string; triggerId?: string; at: string; text: string }[] = []
  for (let seq = 1; seq <= Math.min(high, 10_000); seq++) {
    const event = store.get<{ type: string; requestId?: string; at: string }>(KV.conversation.event(seq))
    if (event?.type !== 'user' || !event.requestId) continue
    const receipt = store.get<{ triggerId?: string }>(KV.conversation.receipt(event.requestId))
    const trigger = receipt?.triggerId ? store.triggers.get(receipt.triggerId) : undefined
    result.push({ requestId: event.requestId, ...(receipt?.triggerId ? { triggerId: receipt.triggerId } : {}),
      at: event.at, text: trigger?.text ?? '' })
  }
  return result
}

function replyStatusFor(store: StoreLike, ticketId: string): 'pending' | 'sent' | 'dropped' | 'none' {
  const receipts = receiptRows(store, ticketId)
  if (!receipts.length) return 'none'
  if (receipts.some(item => item.status === 'pending')) return 'pending'
  if (receipts.some(item => item.status === 'sent')) return 'sent'
  return 'dropped'
}

export function watermarkOf(store: StoreLike): string {
  const conversation = store.get<number>(KV.conversation.seq) ?? 0
  const updated = store.tickets.list().reduce((latest, ticket) => maxIso([latest, ticket.updatedAt]), '')
  const decisions = scalar(store.db, 'SELECT MAX(rowid) AS n FROM decision')
  const reports = scalar(store.db, 'SELECT MAX(seq) AS n FROM paseo_report_receipt')
  const intents = scalar(store.db, 'SELECT COUNT(*) AS n FROM paseo_operation_intent')
  const confirmed = scalar(store.db, "SELECT COUNT(*) AS n FROM paseo_operation_intent WHERE result_id IS NOT NULL")
  const outbox = scalar(store.db, 'SELECT MAX(rowid) AS n FROM outbox')
  return [conversation, updated, decisions, reports, `${intents}/${confirmed}`, outbox].join('|')
}

export function projectFlowOverview(store: StoreLike, host: HostSnapshot,
  options: { cursor?: number; limit?: number; filter?: FlowListFilter; q?: string } = {}): FlowOverviewResponse {
  const masterId = store.get<string>(KV.runtime.masterId)
  const tickets = store.tickets.list()
  const items: FlowOverviewItem[] = []

  for (const ticket of tickets) {
    const latest = ticket.assignments.at(-1)
    items.push({
      kind: 'ticket',
      id: ticket.id,
      title: ticket.title,
      subtitle: [latest?.state ?? 'open', `${ticket.assignments.length} assignment(s)`, ticket.execution?.directory].filter(Boolean).join(' · '),
      source: ticket.mandate.actor.source,
      status: ticketStatus(ticket),
      updatedAt: ticket.updatedAt,
      ticketIds: [ticket.id],
      hasAttention: !!ticket.attention,
      assignmentCount: ticket.assignments.length,
      replyStatus: replyStatusFor(store, ticket.id),
    })
  }

  for (const request of conversationRequests(store)) {
    const receipt = store.get<{ triggerId: string }>(KV.conversation.receipt(request.requestId))
    const disposition = receipt?.triggerId ? store.triggers.disposition(receipt.triggerId) : undefined
    const decision = latestDecisionOf(store, disposition)
    const ids = relatedTicketIds(store, receipt?.triggerId ?? '', disposition, decision?.ticketId)
    const trigger = request.triggerId ? store.triggers.get(request.triggerId) : undefined
    const status = ids.length ? 'accepted' : disposition?.filtered ? 'filtered' : decision?.kind ?? 'pending'
    items.push({
      kind: 'request',
      id: request.requestId,
      title: preview(trigger?.text || 'Local request', 90) || 'Local request',
      subtitle: [trigger?.actor.source ?? 'local', decision?.kind ?? status, ids.length ? `${ids.length} ticket(s)` : 'no ticket'].join(' · '),
      source: trigger?.source ?? 'local',
      status,
      updatedAt: maxIso([request.at, ...ids.map(id => store.tickets.get(id)?.updatedAt)]),
      ticketIds: ids,
      ...(request.triggerId ? { triggerId: request.triggerId } : {}),
      hasAttention: ids.some(id => !!store.tickets.get(id)?.attention),
      replyStatus: ids.length ? replyStatusFor(store, ids[0]!) : 'none',
    })
  }

  const query = options.q?.trim().toLowerCase()
  const filtered = items.filter(item => {
    if (options.filter === 'active') return item.kind === 'ticket' ? item.status !== 'completed' && item.status !== 'dropped' && item.status !== 'stopped' : item.status === 'pending' || item.status === 'accepted'
    if (options.filter === 'attention') return item.hasAttention === true
    if (options.filter === 'completed') return item.kind === 'ticket' && ['completed', 'merged', 'closed', 'dropped', 'stopped'].includes(item.status)
    if (options.filter === 'unaccepted') return item.kind === 'request' && item.ticketIds.length === 0
    return true
  }).filter(item => !query || `${item.id}\n${item.title}\n${item.subtitle}`.toLowerCase().includes(query))
    .sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt) || a.id.localeCompare(b.id))

  const limit = Math.min(200, Math.max(1, options.limit ?? 50))
  const cursor = Math.min(filtered.length, Math.max(0, options.cursor ?? 0))
  const page = filtered.slice(cursor, cursor + limit)

  return {
    watermark: watermarkOf(store),
    host: { phase: host.phase, ...(host.detail ? { detail: host.detail } : {}), ...(masterId ? { masterId } : {}),
      ...(orchestrationIdentity(store, masterId) ? { orchestrator: orchestrationIdentity(store, masterId)! } : {}) },
    counts: {
      totalItems: filtered.length,
      activeTickets: tickets.filter(ticket => !ticket.ended).length,
      attentionTickets: tickets.filter(ticket => !!ticket.attention).length,
      completedTickets: tickets.filter(ticket => !!ticket.ended).length,
      unacceptedRequests: items.filter(item => item.kind === 'request' && item.ticketIds.length === 0).length,
    },
    items: page,
    nextCursor: cursor + page.length < filtered.length ? cursor + page.length : null,
    hasMore: cursor + page.length < filtered.length,
  }
}

interface Context {
  store: StoreLike
  masterId: string | undefined
  nodes: FlowCanvasNode[]
  edges: FlowCanvasEdge[]
  timeline: FlowTimelineEntry[]
  unknowns: FlowUnknownNote[]
  laneRow: Record<keyof typeof SWIMLANE_X, number>
  triggers: Map<string, Trigger>
  decisions: Map<string, Decision>
  reports: FlowReportRecord[]
  intents: Set<string>
  unconfirmed: boolean
}

function node(context: Context, lane: keyof typeof SWIMLANE_X, value: Omit<FlowCanvasNode, 'position' | 'swimlane'>): FlowCanvasNode {
  const index = context.laneRow[lane]++
  const nodeValue: FlowCanvasNode = { ...value, swimlane: lane,
    position: { x: SWIMLANE_X[lane], y: LANE_TOP + index * ROW_HEIGHT } }
  context.nodes.push(nodeValue)
  return nodeValue
}

function edge(context: Context, value: FlowCanvasEdge): FlowCanvasEdge {
  context.edges.push(value)
  return value
}

function timeline(context: Context, value: Omit<FlowTimelineEntry, 'order'>): FlowTimelineEntry {
  const existing = context.timeline.find(item => item.id === value.id)
  if (existing) return existing
  const entry: FlowTimelineEntry = { ...value, order: context.timeline.length }
  context.timeline.push(entry)
  return entry
}

function reportEdgeData(records: FlowReportRecord[]): { count: number; latestState: string } {
  const latest = records.at(-1)
  return { count: records.length, latestState: latest?.state ?? 'unknown' }
}

function addTriggerNodes(context: Context, triggers: Trigger[], masterId: string | undefined): void {
  const sorted = [...triggers].sort((a, b) => timeOf(a.at) - timeOf(b.at) || a.id.localeCompare(b.id))
  for (const trigger of sorted) {
    if (!context.triggers.has(trigger.id)) context.triggers.set(trigger.id, trigger)
    node(context, 'superagent', {
      id: `trigger:${trigger.id}`,
      kind: 'trigger',
      data: { label: `${trigger.source} · ${trigger.actor.id}`, subtitle: preview(trigger.text, 120), status: trigger.human ? 'human' : 'automated',
        at: trigger.at, source: trigger.source, actor: trigger.actor.id, text: trigger.text,
        evidence: { triggerId: trigger.id, source: trigger.source, actor: trigger.actor.id, at: trigger.at, threads: trigger.threads.map(thread => `${thread.source}:${thread.id}`) } },
    })
  }
}

function decisionOfTrigger(context: Context, triggerId: string): { disposition?: TriggerDisposition; decision?: Decision } {
  const disposition = context.store.triggers.disposition(triggerId)
  const decision = latestDecisionOf(context.store, disposition)
  return { ...(disposition ? { disposition } : {}), ...(decision ? { decision } : {}) }
}

function controlIdFor(triggerId: string, disposition: TriggerDisposition | undefined, decision: Decision | undefined): string {
  if (decision) return `control:${decision.id}`
  if (disposition?.evalId) return `control:${disposition.evalId}`
  if (disposition?.filtered) return `control:filtered:${triggerId}`
  return `control:pending:${triggerId}`
}

function addControlNode(context: Context, triggerId: string | undefined, disposition: TriggerDisposition | undefined, decision: Decision | undefined): string | undefined {
  if (!triggerId) return undefined
  const id = controlIdFor(triggerId, disposition, decision)
  if (context.nodes.some(nodeValue => nodeValue.id === id)) return id
  const filtered = disposition?.filtered ? [disposition.filtered.code] : []
  const reasons = decision?.reason.map(reason => reason.code) ?? filtered
  node(context, 'superagent', {
    id,
    kind: 'control',
    data: { label: decision ? `Decision: ${decision.kind}` : disposition?.filtered ? 'Source filter' : 'Pending assessment',
      subtitle: decision ? `Policy ${decision.policyVersion}` : disposition?.evalId ? `Eval ${disposition.evalId}` : 'No decision recorded',
      status: decision?.kind ?? (disposition?.filtered ? 'filtered' : 'pending'),
      at: decision?.at ?? disposition?.at ?? null, reasonCodes: reasons,
      ...(decision ? { policyVersion: decision.policyVersion } : {}),
      evidence: { triggerId, ...(disposition?.evalId ? { evalId: disposition.evalId } : {}), ...(disposition?.decisionId ? { decisionId: disposition.decisionId } : {}),
        ...(disposition?.filtered ? { filtered: disposition.filtered.code } : {}), ...(decision ? { kind: decision.kind, reasons: decision.reason.map(reason => reason.code), policyVersion: decision.policyVersion } : {}) } },
  })
  if (!context.decisions.has(id) && decision) context.decisions.set(decision.id, decision)
  edge(context, { id: `intake:${triggerId}`, kind: 'intake', source: `trigger:${triggerId}`, target: id, data: { label: 'intake', status: 'recorded', evidence: { triggerId } } })
  if (context.masterId) {
    edge(context, { id: `assessment:${id.replace('control:', '')}`, kind: 'assessment', source: id, target: `orchestrator:${context.masterId}`,
      data: { label: decision ? decision.kind : 'assessment', status: decision?.kind ?? 'pending', evidence: { triggerId, decisionId: decision?.id ?? null } } })
  }
  return id
}

function addOrchestratorNode(context: Context): void {
  const identity = orchestrationIdentity(context.store, context.masterId)
  const id = `orchestrator:${context.masterId ?? 'unbound'}`
  node(context, 'orchestrator', {
    id,
    kind: 'orchestrator',
    data: { label: 'Orchestrator', subtitle: context.masterId ?? 'Master session not bound',
      status: identity ? 'bound' : context.masterId ? 'binding missing' : 'unbound',
      ...(identity ? { worker: identity } : {}),
      evidence: { masterId: context.masterId ?? null, ...(identity ? { agentId: identity.agentId, provider: identity.provider, model: identity.model, mode: identity.mode } : {}) } },
  })
}

function addAssignmentNodes(context: Context, ticket: Ticket, latestId: string | undefined, folded: boolean): void {
  const assignments = ticket.assignments
  if (assignments.length === 0) return
  if (folded) {
    const hidden = assignments.filter(assignment => assignment.id !== latestId).map(assignment => assignment.id)
    node(context, 'worker', { id: `assignment-history:${ticket.id}`, kind: 'assignment-history',
      data: { label: `${hidden.length} earlier assignment(s)`, subtitle: 'Folded history; expand to inspect each Worker session', status: 'folded', ticketId: ticket.id,
        hiddenAssignmentIds: hidden, evidence: { ticketId: ticket.id, hiddenAssignmentIds: hidden } } })
  }
  for (const assignment of assignments) {
    const hiddenByHistoryFold = folded && assignment.id !== latestId
    const reports = reportsOf(context.store, ticket, assignment)
    const worker = workerIdentity(context.store, ticket, assignment, context.masterId)
    const id = `assignment:${ticket.id}:${assignment.id}`
    node(context, 'worker', {
      id,
      kind: 'assignment',
      ...(hiddenByHistoryFold ? { hiddenByHistoryFold: true } : {}),
      data: { label: `Assignment ${assignment.id}`, subtitle: worker.agentId ?? 'No confirmed Worker agent', status: assignment.state,
        at: assignment.startedAt ?? assignment.createdAt, assignmentId: assignment.id, ticketId: ticket.id,
        ...(worker ? { worker } : {}),
        ...(ticket.execution?.directory ? { executionDirectory: ticket.execution.directory } : {}),
        reportCount: reports.length, inputCount: ticket.inputs.length, undeliveredCount: ticket.undelivered.length,
        evidence: { ticketId: ticket.id, assignmentId: assignment.id, state: assignment.state, createdAt: assignment.createdAt,
          ...(assignment.startedAt ? { startedAt: assignment.startedAt } : {}), ...(assignment.endedAt ? { endedAt: assignment.endedAt } : {}),
          ...(assignment.endedReason ? { endedReason: assignment.endedReason } : {}), ...(assignment.report ? { report: assignment.report } : {}),
          ...(assignment.deliveredAt ? { deliveredAt: assignment.deliveredAt } : {}), ...(assignment.idleAt ? { idleAt: assignment.idleAt } : {}),
          worker: { agentId: worker.agentId, confirmation: worker.confirmation, ...(worker.mode ? { mode: worker.mode } : {}), ...(worker.startupCwd ? { startupCwd: worker.startupCwd } : {}) } } },
    })
    const dispatch = edge(context, { id: `dispatch:${ticket.id}:${assignment.id}`, kind: 'dispatch', source: `ticket:${ticket.id}`, target: id,
      ...(hiddenByHistoryFold ? { hiddenByHistoryFold: true } : {}),
      data: { label: 'dispatch', status: worker.confirmation, ...(worker.confirmation === 'bound_only' ? {} : { confirmation: worker.confirmation }),
        evidence: { assignmentId: assignment.id, agentId: worker.agentId } } })
    void dispatch
    if (reports.length) {
      const aggregate = reportEdgeData(reports)
      edge(context, { id: `worker_report:${ticket.id}:${assignment.id}`, kind: 'worker_report', source: id,
        target: `orchestrator:${context.masterId ?? 'unbound'}`, ...(hiddenByHistoryFold ? { hiddenByHistoryFold: true } : {}),
        data: { label: 'reports', status: aggregate.latestState, count: aggregate.count, latestState: aggregate.latestState,
          evidence: { reports: reports.map(record => ({ seq: record.seq, state: record.state, summary: preview(record.summary), at: record.at, accepted: record.accepted })) } } })
    }
    timeline(context, { id: `assignment:${ticket.id}:${assignment.id}`, category: 'assignment', title: `Assignment ${assignment.id}`,
      summary: `${assignment.state}${assignment.endedReason ? ` (${assignment.endedReason})` : ''}`, status: assignment.state,
      at: assignment.createdAt, timestampNote: 'exact', nodeIds: [id], edgeIds: [`dispatch:${ticket.id}:${assignment.id}`],
      evidence: { assignmentId: assignment.id, state: assignment.state, createdAt: assignment.createdAt, workerAgentId: worker.agentId, confirmation: worker.confirmation } })
    for (const report of reports) {
      timeline(context, { id: `report:${ticket.id}:${assignment.id}:${report.seq}`, category: 'report', title: `Worker report${report.seq ? ` #${report.seq}` : ''}`,
        summary: report.summary || report.state, status: report.state, at: report.at, timestampNote: report.at ? 'exact' : 'timestamp_not_recorded',
        nodeIds: [id], edgeIds: [`worker_report:${ticket.id}:${assignment.id}`],
        evidence: { state: report.state, summary: report.summary, question: report.question ?? null, accepted: report.accepted,
          ...(report.notification ? { notification: report.notification } : {}), ...(report.refused ? { refused: report.refused } : {}), timestampNote: report.at ? 'exact' : 'timestamp_not_recorded' } })
      context.reports.push(report)
    }
  }
}

function addInputEvidence(context: Context, ticket: Ticket, latestId: string | undefined): void {
  if (!ticket.inputs.length) return
  const targetId = latestId ? `assignment:${ticket.id}:${latestId}` : `ticket:${ticket.id}`
  const inputs: FlowInputRecord[] = ticket.inputs.map(input => ({
    id: input.id, kind: input.kind, at: input.at,
    summary: 'text' in input && typeof input.text === 'string' ? preview(input.text) : input.kind === 'trigger' ? `Trigger ${input.triggerId}` : input.kind,
    ...('deliveredTo' in input && input.deliveredTo ? { deliveredTo: input.deliveredTo } : {}),
    ...('deliveredAt' in input && input.deliveredAt ? { deliveredAt: input.deliveredAt } : {}),
    ...('readAt' in input ? { readAt: input.readAt ?? null } : {}),
    undelivered: ticket.undelivered.includes(input.id),
  }))
  const source = ticket.inputs.some(input => input.kind === 'trigger') ? `trigger:${ticket.origin.triggerId}` : `orchestrator:${context.masterId ?? 'unbound'}`
  const edgeValue = edge(context, { id: `followup_input:${ticket.id}:${latestId ?? 'ticket'}`, kind: 'followup_input', source,
    target: targetId, data: { label: 'inputs', status: ticket.undelivered.length ? 'partially undelivered' : 'delivered',
      count: inputs.length, undeliveredCount: ticket.undelivered.length, evidence: { inputs: inputs.map(input => ({ id: input.id, kind: input.kind, at: input.at, deliveredTo: input.deliveredTo ?? null, undelivered: input.undelivered })) } } })
  for (const input of inputs) {
    timeline(context, { id: `input:${ticket.id}:${input.id}`, category: 'input', title: `Input ${input.kind}`, summary: input.summary,
      status: input.undelivered ? 'undelivered' : input.readAt === null ? 'delivered' : input.readAt ? 'read' : 'delivered',
      at: input.at, timestampNote: 'exact', nodeIds: [targetId], edgeIds: [edgeValue.id], evidence: { ...input } })
  }
}

function addIntentEvidence(context: Context, ticket: Ticket, masterId: string | undefined, triggerId: string | undefined): void {
  const hasTicketId = Boolean(ticket.id)
  const linked = intents(context.store).filter(intent =>
    (hasTicketId && intent.ticket_id === ticket.id) || (intent.ticket_id === masterId && intent.assignment_id === 'session' &&
      (() => {
        const text = safeFrozenText(context.store, intent.message_id)
        return !!text && ((hasTicketId && text.includes(ticket.id)) || (!!triggerId && text.includes(triggerId)))
      })()))
  for (const intent of linked) {
    const evidence: FlowOperationEvidence = {
      operationId: intent.operation_id, ticketId: intent.ticket_id, assignmentId: intent.assignment_id, kind: intent.kind,
      sessionId: intent.session_id || null, messageId: intent.message_id || null, resultId: intent.result_id, cwd: intent.cwd || null,
      confirmation: intent.result_id === null ? 'unconfirmed' : 'confirmed',
      ...(intent.kind === 'send' ? { preview: preview(safeFrozenText(context.store, intent.message_id)?.slice(0, 160) ?? '') } : {}),
    }
    const nodeId = intent.ticket_id === ticket.id ? `assignment:${ticket.id}:${intent.assignment_id}` : `orchestrator:${masterId ?? 'unbound'}`
    timeline(context, { id: `intent:${intent.operation_id}`, category: 'intent', title: `${intent.kind} intent ${intent.operation_id}`,
      summary: evidence.confirmation === 'unconfirmed' ? 'Unconfirmed side effect intent; reconcile before any retry' : 'Confirmed side effect',
      status: evidence.confirmation, at: null, confirmation: evidence.confirmation, timestampNote: 'timestamp_not_recorded',
      nodeIds: [nodeId], edgeIds: [], evidence: { ...evidence } })
    if (evidence.confirmation === 'unconfirmed') context.unconfirmed = true
    context.intents.add(intent.operation_id)
  }
}

function addReplyEvidence(context: Context, ticket: Ticket, triggerId: string | undefined): void {
  const receipts = receiptRows(context.store, ticket.id)
  for (const receipt of receipts) {
    const id = `outbox:${receipt.id}`
    node(context, 'superagent', { id, kind: 'outbox', data: { label: `${receipt.kind} → ${receipt.channel.source}`,
      subtitle: preview(receipt.text, 120), status: receipt.status, at: null, replyKind: receipt.kind, replyStatus: receipt.status,
      evidence: { messageId: receipt.id, kind: receipt.kind, status: receipt.status, channel: receipt.channel.source,
        ...(receipt.dropped ? { dropped: receipt.dropped } : {}) } } })
    const attempts = row<{ attempts: number; error: string }>(context.store.db,
      "SELECT attempts, error FROM effect WHERE kind = 'reply' AND key = ?", receipt.id)[0]
    edge(context, { id: `outbound_reply:${receipt.id}:out`, kind: 'outbound_reply', source: `orchestrator:${context.masterId ?? 'unbound'}`, target: id,
      data: { label: 'reply', status: receipt.status, ...(attempts ? { count: attempts.attempts } : {}),
        evidence: { messageId: receipt.id, status: receipt.status, ...(attempts ? { attempts: attempts.attempts, error: attempts.error } : {}) } } })
    if (triggerId) {
      edge(context, { id: `outbound_reply:${receipt.id}:back`, kind: 'outbound_reply', source: id, target: `trigger:${triggerId}`,
        data: { label: 'delivered reply', status: receipt.status, evidence: { messageId: receipt.id, thread: receipt.channel.thread } } })
    }
    timeline(context, { id: `reply:${receipt.id}`, category: 'reply', title: `${receipt.kind} reply`, summary: preview(receipt.text),
      status: receipt.status, at: null, timestampNote: 'recorded_on_local_conversation',
      nodeIds: [id], edgeIds: [`outbound_reply:${receipt.id}:out`], evidence: { messageId: receipt.id, kind: receipt.kind, status: receipt.status } })
  }
}

function timelineReplyTimes(context: Context): void {
  const high = context.store.get<number>(KV.conversation.seq) ?? 0
  for (let seq = 1; seq <= Math.min(high, 10_000); seq++) {
    const event = context.store.get<{ type: string; replyId?: string; at: string }>(KV.conversation.event(seq))
    if (event?.type !== 'assistant' || !event.replyId) continue
    const entry = context.timeline.find(item => item.id === `reply:${event.replyId}`)
    if (entry) { entry.at = event.at; entry.timestampNote = 'exact' }
  }
}

function unknownsOf(context: Context, ticket: Ticket | undefined): FlowUnknownNote[] {
  const notes: FlowUnknownNote[] = []
  if (ticket) {
    const sent = receiptRows(context.store, ticket.id).some(receipt => receipt.status === 'sent')
    if (sent) notes.push({ code: 'human_read_not_tracked', title: 'Human read not tracked',
      detail: 'The system records that a reply entered the outbox and was sent; it does not know whether a person read it in the chat UI.',
      relatedIds: [ticket.id] })
    if (context.reports.some(report => report.at === null)) notes.push({ code: 'report_receipt_timestamp_absent', title: 'Some report receipts have no timestamp',
      detail: 'Paseo report receipts keep a sequence and payload but no dedicated receipt time; those entries are ordered by seq and show no fabricated time.',
      relatedIds: [ticket.id] })
    if (ticket.assignments.length > 1) notes.push({ code: 'historical_worker_transcript_unavailable', title: 'Historical Worker transcript is live-only',
      detail: 'Only the currently bound session can be queried through Paseo. Earlier Assignment Workers may be gone; their identity is reconstructed from confirmed create intents, not from a historical transcript.',
      relatedIds: ticket.assignments.slice(0, -1).map(assignment => `assignment:${ticket.id}:${assignment.id}`) })
  }
  if (context.intents.size) notes.push({ code: 'operation_intent_timestamp_absent', title: 'Side-effect intents have no timestamp',
    detail: 'Create/send journal rows prove intent and confirmation state but do not store when the operation was attempted; they appear in grouped evidence rather than on a precise time axis.',
    relatedIds: [...context.intents] })
  if (context.unconfirmed) notes.push({ code: 'unconfirmed_operation_intent', title: 'Unconfirmed side effect exists',
    detail: 'An intent has no confirmed result yet. It is not proof of delivery and is never safe to resend without reconciliation.',
    relatedIds: [...context.intents] })
  return notes
}

function buildTicketView(store: StoreLike, ticket: Ticket): FlowItemView {
  const masterId = store.get<string>(KV.runtime.masterId)
  const context: Context = { store, masterId, nodes: [], edges: [], timeline: [], unknowns: [], laneRow: { superagent: 0, orchestrator: 0, worker: 0 },
    triggers: new Map(), decisions: new Map(), reports: [], intents: new Set(), unconfirmed: false }
  const inputTriggerIds = ticket.inputs.flatMap(input => ('triggerId' in input && typeof input.triggerId === 'string') ? [input.triggerId] : [])
  const stopTriggerIds = row<{ value: string }>(store.db, 'SELECT value FROM decision ORDER BY rowid')
    .map(item => JSON.parse(item.value) as Decision)
    .filter(item => item.ticketId === ticket.id)
    .flatMap(item => item.triggerIds)
  const allTriggerIds = [...new Set([...ticket.origin.triggerIds, ...inputTriggerIds, ...stopTriggerIds])]
  const originTriggers = allTriggerIds.flatMap(id => store.triggers.get(id) ?? [])
  const primary = originTriggers.find(trigger => trigger.id === ticket.origin.triggerId)
  addTriggerNodes(context, originTriggers, masterId)
  addOrchestratorNode(context)
  const { disposition, decision } = decisionOfTrigger(context, ticket.origin.triggerId)
  const controlId = addControlNode(context, ticket.origin.triggerId, disposition, decision)
  node(context, 'worker', { id: `ticket:${ticket.id}`, kind: 'ticket',
    data: { label: ticket.title, subtitle: ticket.mandate.scope, status: ticketStatus(ticket), at: ticket.createdAt, ticketId: ticket.id,
      ...(ticket.attention ? { attentionQuestion: ticket.attention.question } : {}), undeliveredCount: ticket.undelivered.length,
      evidence: { ticketId: ticket.id, decisionId: ticket.decisionId, strength: ticket.mandate.strength, policyVersion: ticket.mandate.policyVersion,
        createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, ...(ticket.ended ? { ended: ticket.ended } : {}),
        ...(ticket.attention ? { attention: ticket.attention } : {}), inputs: ticket.inputs.length, undelivered: ticket.undelivered } } })
  if (controlId) edge(context, { id: `ticket_open:${ticket.id}`, kind: 'ticket_open', source: controlId, target: `ticket:${ticket.id}`,
    data: { label: decision?.kind ?? 'open', status: decision?.kind ?? 'open', evidence: { ticketId: ticket.id, decisionId: ticket.decisionId } } })
  const latestId = ticket.assignments.at(-1)?.id
  const folded = ticket.assignments.length > 1
  if (primary) timeline(context, { id: `trigger:${primary.id}`, category: 'trigger', title: 'Request received', summary: preview(primary.text),
    status: primary.human ? 'human' : 'automated', at: primary.at, timestampNote: 'exact', nodeIds: [`trigger:${primary.id}`], edgeIds: [`intake:${primary.id}`],
    evidence: { triggerId: primary.id, source: primary.source, actor: primary.actor.id } })
  if (decision) timeline(context, { id: `decision:${decision.id}`, category: 'decision', title: `Decision: ${decision.kind}`,
    summary: decision.reason.map(reason => reason.code).join(', '), status: decision.kind, at: decision.at, timestampNote: 'exact',
    nodeIds: controlId ? [controlId] : [], edgeIds: controlId ? [`ticket_open:${ticket.id}`] : [],
    evidence: { decisionId: decision.id, kind: decision.kind, reasons: decision.reason.map(reason => reason.code), policyVersion: decision.policyVersion, at: decision.at } })
  timeline(context, { id: `ticket:${ticket.id}`, category: 'ticket', title: ticket.title, summary: `Ticket ${ticket.id} 已立项`,
    status: 'created', at: ticket.createdAt, timestampNote: 'exact', nodeIds: [`ticket:${ticket.id}`],
    edgeIds: controlId ? [`ticket_open:${ticket.id}`] : [], evidence: { ticketId: ticket.id, createdAt: ticket.createdAt, ended: ticket.ended ?? null } })
  addAssignmentNodes(context, ticket, latestId, folded)
  addInputEvidence(context, ticket, latestId)
  addIntentEvidence(context, ticket, masterId, primary?.id)
  addReplyEvidence(context, ticket, primary?.id)
  timelineReplyTimes(context)
  if (ticket.ended) timeline(context, { id: `ticket_ended:${ticket.id}`, category: 'ticket', title: `Ticket ${ticket.ended.outcome}`,
    summary: ticket.ended.reason ?? `Ended by ${ticket.ended.by}`, status: ticket.ended.outcome, at: ticket.ended.at, timestampNote: 'exact',
    nodeIds: [`ticket:${ticket.id}`], edgeIds: [], evidence: { ...ticket.ended } })

  const latestReport = ticket.assignments.at(-1)?.report
  const replyStatus = replyStatusFor(store, ticket.id)
  return {
    watermark: watermarkOf(store),
    focus: { kind: 'ticket', id: ticket.id, primaryTicketId: ticket.id },
    summary: { requestStatus: primary ? 'received' : 'unknown', routingDecision: decision?.kind ?? 'pending',
      workerReportState: latestReport?.state ?? 'none', ticketOutcome: ticket.ended?.outcome ?? 'open', replyDelivery: replyStatus },
    relatedTickets: [{ id: ticket.id, title: ticket.title, status: ticketStatus(ticket), updatedAt: ticket.updatedAt, assignmentCount: ticket.assignments.length }],
    nodes: context.nodes,
    edges: context.edges,
    timeline: context.timeline.slice(0, MAX_TIMELINE),
    unknowns: unknownsOf(context, ticket),
    truncated: context.timeline.length > MAX_TIMELINE,
  }
}

function threadReplies(context: Context, trigger: Trigger): Receipt[] {
  const threadId = trigger.channel?.thread
  return row<{ value: string }>(context.store.db, 'SELECT value FROM outbox ORDER BY rowid')
    .map(item => JSON.parse(item.value) as Receipt)
    .filter(item => !item.ticketId && threadId && item.channel.thread === threadId)
}

function addThreadReply(context: Context, receipt: Receipt, triggerId: string): void {
  const outboxId = `outbox:${receipt.id}`
  if (context.nodes.some(existing => existing.id === outboxId)) return
  node(context, 'superagent', { id: outboxId, kind: 'outbox', data: { label: `${receipt.kind} → ${receipt.channel.source}`,
    subtitle: preview(receipt.text, 120), status: receipt.status, at: null, replyKind: receipt.kind, replyStatus: receipt.status,
    evidence: { messageId: receipt.id, kind: receipt.kind, status: receipt.status, channel: receipt.channel.source, text: receipt.text } } })
  edge(context, { id: `outbound_reply:${receipt.id}:out`, kind: 'outbound_reply', source: `orchestrator:${context.masterId ?? 'unbound'}`, target: outboxId,
    data: { label: 'reply', status: receipt.status, evidence: { messageId: receipt.id, status: receipt.status } } })
  edge(context, { id: `outbound_reply:${receipt.id}:back`, kind: 'outbound_reply', source: outboxId, target: `trigger:${triggerId}`,
    data: { label: 'delivered reply', status: receipt.status, evidence: { messageId: receipt.id, thread: receipt.channel.thread } } })
  timeline(context, { id: `reply:${receipt.id}`, category: 'reply', title: `${receipt.kind} reply`, summary: preview(receipt.text),
    status: receipt.status, at: null, timestampNote: 'recorded_on_local_conversation',
    nodeIds: [outboxId], edgeIds: [`outbound_reply:${receipt.id}:out`], evidence: { messageId: receipt.id, kind: receipt.kind, status: receipt.status, text: receipt.text } })
}

function buildRequestView(store: StoreLike, requestId: string): FlowItemView | undefined {
  const receipt = store.get<{ triggerId: string; at: string }>(KV.conversation.receipt(requestId))
  if (!receipt) return undefined
  const trigger = store.triggers.get(receipt.triggerId)
  if (!trigger) return undefined
  const masterId = store.get<string>(KV.runtime.masterId)
  const disposition = store.triggers.disposition(receipt.triggerId)
  const decision = latestDecisionOf(store, disposition)
  const ids = relatedTicketIds(store, trigger.id, disposition, decision?.ticketId)
  const tickets = ids.flatMap(id => store.tickets.get(id) ?? [])
  const context: Context = { store, masterId, nodes: [], edges: [], timeline: [], unknowns: [], laneRow: { superagent: 0, orchestrator: 0, worker: 0 },
    triggers: new Map(), decisions: new Map(), reports: [], intents: new Set(), unconfirmed: false }
  addTriggerNodes(context, [trigger], masterId)
  addOrchestratorNode(context)
  const controlId = addControlNode(context, trigger.id, disposition, decision)
  timeline(context, { id: `trigger:${trigger.id}`, category: 'trigger', title: 'Request received', summary: preview(trigger.text),
    status: trigger.human ? 'human' : 'automated', at: trigger.at, timestampNote: 'exact', nodeIds: [`trigger:${trigger.id}`], edgeIds: [`intake:${trigger.id}`],
    evidence: { triggerId: trigger.id, source: trigger.source, actor: trigger.actor.id } })
  if (decision) timeline(context, { id: `decision:${decision.id}`, category: 'decision', title: `Decision: ${decision.kind}`,
    summary: decision.reason.map(reason => reason.code).join(', '), status: decision.kind, at: decision.at, timestampNote: 'exact',
    nodeIds: controlId ? [controlId] : [], edgeIds: [], evidence: { decisionId: decision.id, kind: decision.kind } })
  const inputTriggerIds = new Set(tickets.flatMap(ticket => ticket.origin.triggerIds.concat(ticket.inputs.flatMap(input => ('triggerId' in input && typeof input.triggerId === 'string') ? [input.triggerId] : []))))
  const extraTriggers = [...inputTriggerIds].flatMap(id => (id === trigger.id ? [] : store.triggers.get(id) ?? []))
  if (extraTriggers.length) addTriggerNodes(context, extraTriggers, masterId)
  for (const ticket of tickets) {
    const latest = ticket.assignments.at(-1)
    node(context, 'worker', { id: `ticket:${ticket.id}`, kind: 'ticket',
      data: { label: ticket.title, subtitle: ticket.mandate.scope, status: ticketStatus(ticket), at: ticket.createdAt, ticketId: ticket.id,
        reportCount: ticket.assignments.length, undeliveredCount: ticket.undelivered.length,
        ...(ticket.attention ? { attentionQuestion: ticket.attention.question } : {}),
        evidence: { ticketId: ticket.id, status: ticketStatus(ticket), assignmentCount: ticket.assignments.length, ...(latest ? { latestAssignment: latest.id } : {}) } } })
    if (controlId) edge(context, { id: `ticket_open:${ticket.id}`, kind: 'ticket_open', source: controlId, target: `ticket:${ticket.id}`,
      data: { label: decision?.kind ?? 'open', status: decision?.kind ?? 'open', evidence: { ticketId: ticket.id } } })
    timeline(context, { id: `ticket:${ticket.id}`, category: 'ticket', title: ticket.title, summary: `Ticket ${ticket.id} 已立项`,
      status: 'created', at: ticket.createdAt, timestampNote: 'exact', nodeIds: [`ticket:${ticket.id}`],
      edgeIds: controlId ? [`ticket_open:${ticket.id}`] : [], evidence: { ticketId: ticket.id, createdAt: ticket.createdAt } })
    addAssignmentNodes(context, ticket, latest?.id, ticket.assignments.length > 1)
    addInputEvidence(context, ticket, latest?.id)
    addIntentEvidence(context, ticket, masterId, ticket.origin.triggerId)
    addReplyEvidence(context, ticket, ticket.origin.triggerId)
    if (ticket.ended) timeline(context, { id: `ticket_ended:${ticket.id}`, category: 'ticket', title: `Ticket ${ticket.ended.outcome}`,
      summary: ticket.ended.reason ?? `Ended by ${ticket.ended.by}`, status: ticket.ended.outcome, at: ticket.ended.at, timestampNote: 'exact',
      nodeIds: [`ticket:${ticket.id}`], edgeIds: [], evidence: { ...ticket.ended } })
  }
  for (const reply of threadReplies(context, trigger)) addThreadReply(context, reply, trigger.id)
  timelineReplyTimes(context)
  const related: FlowRelatedTicketSummary[] = tickets.map(ticket => ({ id: ticket.id, title: ticket.title, status: ticketStatus(ticket), updatedAt: ticket.updatedAt, assignmentCount: ticket.assignments.length }))
  const latestReport = tickets.flatMap(ticket => ticket.assignments.at(-1)?.report ? [ticket.assignments.at(-1)!.report!] : [])
    .sort((a, b) => timeOf(a.at) - timeOf(b.at)).at(-1)
  const replyDelivery = tickets.length ? (['pending', 'sent', 'dropped'] as const).find(status => tickets.some(ticket => replyStatusFor(store, ticket.id) === status)) ?? 'none' : (threadReplies(context, trigger).some(item => item.status === 'sent') ? 'sent' : 'none')
  return {
    watermark: watermarkOf(store),
    focus: { kind: 'request', id: requestId, ...(tickets[0] ? { primaryTicketId: tickets[0].id } : {}) },
    summary: { requestStatus: ids.length ? 'accepted' : disposition?.filtered ? 'filtered' : decision?.kind ?? 'pending',
      routingDecision: decision?.kind ?? 'pending', workerReportState: latestReport?.state ?? 'none',
      ticketOutcome: tickets.length === 1 ? tickets[0]!.ended?.outcome ?? 'open' : tickets.length > 1 ? 'multiple' : 'none',
      replyDelivery },
    relatedTickets: related,
    nodes: context.nodes,
    edges: context.edges,
    timeline: context.timeline.slice(0, MAX_TIMELINE),
    unknowns: unknownsOf(context, tickets[0]),
    truncated: context.timeline.length > MAX_TIMELINE,
  }
}

export function projectFlowItem(store: StoreLike, kind: 'ticket' | 'request', id: string): FlowItemView | undefined {
  if (kind === 'ticket') { const ticket = store.tickets.get(id); return ticket ? buildTicketView(store, ticket) : undefined }
  return buildRequestView(store, id)
}
