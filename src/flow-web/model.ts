/** Shared read-only DTOs for the Superagent -> Orchestrator -> Worker flow canvas. */

export const SWIMLANE_X = {
  superagent: 80,
  orchestrator: 460,
  worker: 860,
} as const

export type SwimlaneId = keyof typeof SWIMLANE_X

export type FlowHostPhase = 'starting' | 'needs_setup' | 'ready' | 'stopping' | 'stopped' | 'error'

export interface SafeSessionIdentity {
  sessionKey: string
  role: 'orchestrator' | 'worker'
  agentId: string | null
  provider?: string
  model?: string
  mode?: string
  startupCwd?: string
  parentAgentId?: string
  revision?: number
  confirmation: 'confirmed' | 'unconfirmed' | 'bound_only'
}

export type FlowListFilter = 'all' | 'active' | 'attention' | 'completed' | 'unaccepted'

export interface FlowOverviewItem {
  kind: 'ticket' | 'request'
  id: string
  title: string
  subtitle: string
  source: string
  status: string
  updatedAt: string
  ticketIds: string[]
  triggerId?: string
  hasAttention?: boolean
  assignmentCount?: number
  replyStatus?: 'pending' | 'sent' | 'dropped' | 'none'
}

export interface FlowOverviewResponse {
  watermark: string
  host: {
    phase: FlowHostPhase
    detail?: string
    masterId?: string
    orchestrator?: SafeSessionIdentity
  }
  counts: {
    totalItems: number
    activeTickets: number
    attentionTickets: number
    completedTickets: number
    unacceptedRequests: number
  }
  items: FlowOverviewItem[]
  nextCursor: number | null
  hasMore: boolean
}

export type FlowNodeKind =
  | 'trigger'
  | 'control'
  | 'orchestrator'
  | 'ticket'
  | 'assignment'
  | 'assignment-history'
  | 'outbox'

export interface FlowReportRecord {
  seq: number
  requestId: string
  state: string
  summary: string
  question?: string
  at: string | null
  timestampNote?: 'recorded_on_latest_assignment' | 'timestamp_not_recorded'
  accepted: boolean
  notification?: string
  refused?: string
}

export interface FlowOperationEvidence {
  operationId: string
  ticketId: string
  assignmentId: string
  kind: 'create' | 'send'
  sessionId: string | null
  messageId: string | null
  resultId: string | null
  cwd: string | null
  confirmation: 'confirmed' | 'unconfirmed'
  preview?: string
}

export interface FlowInputRecord {
  id: string
  kind: string
  at: string
  summary: string
  deliveredTo?: string
  deliveredAt?: string
  readAt?: string | null
  undelivered: boolean
}

export interface FlowCanvasNode {
  id: string
  kind: FlowNodeKind
  swimlane: SwimlaneId
  position: { x: number; y: number }
  hiddenByHistoryFold?: boolean
  data: {
    label: string
    subtitle?: string
    status: string
    badge?: string
    at?: string | null
    source?: string
    actor?: string
    text?: string
    reasonCodes?: string[]
    policyVersion?: string
    worker?: SafeSessionIdentity
    executionDirectory?: string
    assignmentId?: string
    ticketId?: string
    hiddenAssignmentIds?: string[]
    reportCount?: number
    inputCount?: number
    undeliveredCount?: number
    attentionQuestion?: string
    replyKind?: string
    replyStatus?: string
    attempts?: number
    error?: string
    evidence: Record<string, unknown>
  }
}

export type FlowEdgeKind =
  | 'intake'
  | 'assessment'
  | 'ticket_open'
  | 'dispatch'
  | 'followup_input'
  | 'worker_report'
  | 'outbound_reply'

export interface FlowCanvasEdge {
  id: string
  kind: FlowEdgeKind
  source: string
  target: string
  hiddenByHistoryFold?: boolean
  data: {
    label: string
    status: string
    count?: number
    undeliveredCount?: number
    latestState?: string
    confirmation?: 'confirmed' | 'unconfirmed'
    evidence: Record<string, unknown>
  }
}

export interface FlowTimelineEntry {
  id: string
  order: number
  category: 'trigger' | 'decision' | 'ticket' | 'assignment' | 'input' | 'report' | 'intent' | 'reply'
  title: string
  summary: string
  status: string
  at: string | null
  timestampNote?: 'exact' | 'timestamp_not_recorded' | 'recorded_on_local_conversation'
  confirmation?: 'confirmed' | 'unconfirmed'
  nodeIds: string[]
  edgeIds: string[]
  evidence: Record<string, unknown>
}

export interface FlowUnknownNote {
  code:
    | 'human_read_not_tracked'
    | 'report_receipt_timestamp_absent'
    | 'operation_intent_timestamp_absent'
    | 'unconfirmed_operation_intent'
    | 'historical_worker_transcript_unavailable'
  title: string
  detail: string
  relatedIds: string[]
}

export interface FlowRelatedTicketSummary {
  id: string
  title: string
  status: string
  updatedAt: string
  assignmentCount: number
}

export interface FlowItemView {
  watermark: string
  focus: {
    kind: 'ticket' | 'request'
    id: string
    primaryTicketId?: string
  }
  summary: {
    requestStatus: string
    routingDecision: string
    workerReportState: string
    ticketOutcome: string
    replyDelivery: string
  }
  relatedTickets: FlowRelatedTicketSummary[]
  nodes: FlowCanvasNode[]
  edges: FlowCanvasEdge[]
  timeline: FlowTimelineEntry[]
  unknowns: FlowUnknownNote[]
  truncated: boolean
}

export interface FlowTranscriptPreview {
  sessionKey: string
  agentId: string | null
  status: 'ok' | 'unavailable'
  reason?: string
  note: string
  entries: {
    id: string
    type: string
    role: string
    text: string
  }[]
  truncated: boolean
}
