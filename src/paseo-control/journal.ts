/**
 * Durable identities for create/send side effects. This is a building block, not a Paseo executor.
 * The caller must use a locked, private database, preserve the original payload, and only act on
 * `execute` after this function returns. A crash at any point after intent means reconcile first.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type Intent = {
  operationId: string
  ticketId: string
  assignmentId: string
  /** Exact serialized payload, in the form it will be sent to the backend. */
  payload: string
} & ({ kind: 'create'; cwd?: string } | { kind: 'send'; sessionId: string; messageId: string })

export type Claim = { action: 'execute' | 'reconcile' } | { action: 'confirmed'; resultId: string }
export type Observation =
  | { kind: 'create'; operationId: string; ticketId: string; assignmentId: string; sessionIds: string[] }
  | { kind: 'send'; operationId: string; ticketId: string; assignmentId: string; sessionId: string; messageId: string; present: boolean }

type Row = {
  operation_id: string; ticket_id: string; assignment_id: string; kind: string; message_id: string
  session_id: string; input_hash: string; result_id: string | null; cwd: string
}

function required(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) throw new Error(`Invalid ${field}`)
}
function same(row: Row, intent: Intent, hash: string): boolean {
  return row.operation_id === intent.operationId && row.ticket_id === intent.ticketId && row.assignment_id === intent.assignmentId &&
    row.kind === intent.kind && row.message_id === (intent.kind === 'send' ? intent.messageId : '') &&
    row.session_id === (intent.kind === 'send' ? intent.sessionId : '') && row.cwd === (intent.kind === 'create' ? intent.cwd ?? '' : '') && row.input_hash === hash
}

/**
 * Rows are never deleted or reset. A given assignment has at most one create intent; each message
 * has at most one send intent. Durable storage is required: this class does not open or own the DB.
 */
export class PaseoOperationJournal {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS paseo_operation_intent (
      operation_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, assignment_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('create', 'send')), message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      input_hash TEXT NOT NULL, result_id TEXT, cwd TEXT NOT NULL DEFAULT '',
      UNIQUE(ticket_id, assignment_id, kind, message_id)
    )`)
    const columns = db.prepare("PRAGMA table_info('paseo_operation_intent')").all()
    if (!columns.some(column => column.name === 'cwd')) db.exec("ALTER TABLE paseo_operation_intent ADD COLUMN cwd TEXT NOT NULL DEFAULT ''")
  }

  /**
   * An `execute` response occurs only for the first persisted intent. A repeated call is `reconcile`
   * even when the first process died before the request was sent: absence does not permit a retry.
   */
  claim(intent: Intent): Claim {
    // Never expose permission to execute before the insert is committed. SQLite reports nested
    // SAVEPOINTs as transactions too, so this also rejects claims inside Store.atomic().
    if (this.db.isTransaction) throw new Error('Claim must run outside a transaction')
    required(intent.operationId, 'operationId'); required(intent.ticketId, 'ticketId'); required(intent.assignmentId, 'assignmentId')
    if (typeof intent.payload !== 'string') throw new Error('Invalid payload')
    if (intent.kind === 'send') { required(intent.sessionId, 'sessionId'); required(intent.messageId, 'messageId') }
    else if (intent.kind !== 'create') throw new Error('Invalid kind')
    else if (intent.cwd !== undefined) {
      if (!intent.cwd.startsWith('/')) throw new Error('Invalid cwd')
      let payload: unknown
      try { payload = JSON.parse(intent.payload) } catch { throw new Error('Invalid create payload') }
      if (!payload || typeof payload !== 'object' || (payload as { cwd?: unknown }).cwd !== intent.cwd) throw new Error('Create cwd conflict')
    }
    const hash = createHash('sha256').update(intent.payload).digest('hex')
    const messageId = intent.kind === 'send' ? intent.messageId : ''
    const sessionId = intent.kind === 'send' ? intent.sessionId : ''
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO paseo_operation_intent
      (operation_id,ticket_id,assignment_id,kind,message_id,session_id,input_hash,cwd) VALUES (?,?,?,?,?,?,?,?)`)
      .run(intent.operationId, intent.ticketId, intent.assignmentId, intent.kind, messageId, sessionId, hash, intent.kind === 'create' ? intent.cwd ?? '' : '')
    const row = this.db.prepare('SELECT * FROM paseo_operation_intent WHERE operation_id = ?').get(intent.operationId) as Row | undefined
    if (!row || !same(row, intent, hash)) throw new Error('Operation identity conflict')
    if (Number(inserted.changes) === 1) return { action: 'execute' }
    return row.result_id === null ? { action: 'reconcile' } : { action: 'confirmed', resultId: row.result_id }
  }

  /** Read an already persisted create intent without creating one or granting permission to execute. */
  findCreate(ticketId: string, assignmentId: string): { resultId: string | null; cwd: string | null } | undefined {
    const row = this.db.prepare("SELECT result_id, cwd FROM paseo_operation_intent WHERE ticket_id = ? AND assignment_id = ? AND kind = 'create'").get(ticketId, assignmentId)
    return row ? { resultId: row.result_id === null ? null : String(row.result_id), cwd: row.cwd ? String(row.cwd) : null } : undefined
  }

  /** Any send may remain queued after transport confirmation; stopping needs a backend fence. */
  hasSends(ticketId: string, assignmentId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM paseo_operation_intent WHERE ticket_id = ? AND assignment_id = ? AND kind = 'send' LIMIT 1").get(ticketId, assignmentId)
  }

  /** Unconfirmed sends can still reach a session after a crash. */
  unresolvedSends(ticketId: string, assignmentId: string): { operationId: string; sessionId: string; messageId: string }[] {
    return this.db.prepare("SELECT operation_id, session_id, message_id FROM paseo_operation_intent WHERE ticket_id = ? AND assignment_id = ? AND kind = 'send' AND result_id IS NULL")
      .all(ticketId, assignmentId).map(row => ({ operationId: String(row.operation_id), sessionId: String(row.session_id), messageId: String(row.message_id) }))
  }

  /**
   * Apply only exact-identity observations. Create lookup must enumerate all matching labeled
   * sessions; send lookup must verify the exact session and message identity. Missing or ambiguous
   * evidence stays unresolved. The caller is responsible for using authoritative backend reads.
   */
  observe(observation: Observation): Claim {
    const row = this.db.prepare('SELECT * FROM paseo_operation_intent WHERE operation_id = ?').get(observation.operationId) as Row | undefined
    if (!row || row.ticket_id !== observation.ticketId || row.assignment_id !== observation.assignmentId || row.kind !== observation.kind) {
      throw new Error('Observation identity conflict')
    }
    let resultId: string | undefined
    if (observation.kind === 'create') {
      for (const sessionId of observation.sessionIds) required(sessionId, 'sessionId')
      const matches = [...new Set(observation.sessionIds)]
      if (matches.length > 1) throw new Error('Ambiguous create observation')
      resultId = matches[0]
    } else {
      if (row.session_id !== observation.sessionId || row.message_id !== observation.messageId) throw new Error('Observation identity conflict')
      if (observation.present) resultId = observation.messageId
    }
    if (!resultId) return row.result_id === null ? { action: 'reconcile' } : { action: 'confirmed', resultId: row.result_id }
    // First confirmation wins. A contradictory later observation cannot rewrite history.
    this.db.prepare('UPDATE paseo_operation_intent SET result_id = ? WHERE operation_id = ? AND result_id IS NULL').run(resultId, observation.operationId)
    const latest = this.db.prepare('SELECT result_id FROM paseo_operation_intent WHERE operation_id = ?').get(observation.operationId)
    if (latest?.result_id !== resultId) throw new Error('Conflicting confirmation')
    return { action: 'confirmed', resultId }
  }
}
