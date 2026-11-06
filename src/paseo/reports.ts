/** Assignment-bound receipts for reports that may arrive before Paseo acknowledges the launch message. */
import type { Store } from '../app/store.ts'
import { UserError, liveTicket, type WorkerReport, type Ticket } from '../core/index.ts'
import { reportRelay } from '../app/notices.ts'

interface ReportHost {
  store: Pick<Store, 'db' | 'atomic' | 'tickets'>
  report(ticketId: string, assignmentId: string, report: WorkerReport): Ticket
  relay(requestId: string, text: string): void
}
type Row = { request_id: string; payload: string; result: string | null }
/** Persists assignment-bound Paseo report receipts and replays them after launch confirmation. */
export class PaseoReports {
  constructor(private readonly host: ReportHost) {
    host.store.db.exec(`CREATE TABLE IF NOT EXISTS paseo_report_receipt (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, assignment_id TEXT NOT NULL,
      request_id TEXT NOT NULL, payload TEXT NOT NULL, result TEXT, UNIQUE(ticket_id, assignment_id, request_id))`)
  }
  receive(ticketId: string, assignmentId: string, requestId: string, report: WorkerReport, claim?: () => void): unknown {
    return this.host.store.atomic(() => {
      const db = this.host.store.db, payload = JSON.stringify(report)
      const previous = db.prepare('SELECT payload, result FROM paseo_report_receipt WHERE ticket_id=? AND assignment_id=? AND request_id=?')
        .get(ticketId, assignmentId, requestId) as Row | undefined
      if (previous && previous.payload !== payload) throw new Error('Report request identity conflict')
      if (previous?.result) return JSON.parse(previous.result)
      const ticket = this.current(ticketId, assignmentId)
      // A PR claim is an upstream mutation: it must commit together with the running assignment's report.
      if (claim && ticket.assignments.at(-1)!.state !== 'running') throw new Error('Assignment launch pending; retry PR report after launch')
      claim?.()
      db.prepare('INSERT OR IGNORE INTO paseo_report_receipt(ticket_id,assignment_id,request_id,payload) VALUES (?,?,?,?)')
        .run(ticketId, assignmentId, requestId, payload)
      if (ticket.assignments.at(-1)!.state === 'running') this.replay(ticketId, assignmentId)
      const result = db.prepare('SELECT result FROM paseo_report_receipt WHERE ticket_id=? AND assignment_id=? AND request_id=?')
        .get(ticketId, assignmentId, requestId)?.result
      const response = result ? JSON.parse(String(result)) : { reported: false, queued: true, receipt: requestId }
      if (claim && response.reported === false) throw new Error(response.refused ?? 'Report rejected; PR claim rolled back')
      return response
    })
  }
  private current(ticketId: string, assignmentId: string): Ticket {
    const ticket = this.host.store.tickets.get(ticketId), assignment = ticket?.assignments.at(-1)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || !['pending', 'running'].includes(assignment.state)) {
      throw new Error('Report assignment is no longer current')
    }
    return ticket
  }
  /** Called in the same transaction that records assignmentStarted; receipt results and relays commit together. */
  replay(ticketId: string, assignmentId: string): void {
    this.host.store.atomic(() => {
      const rows = this.host.store.db.prepare('SELECT request_id, payload, result FROM paseo_report_receipt WHERE ticket_id=? AND assignment_id=? AND result IS NULL ORDER BY seq')
        .all(ticketId, assignmentId) as unknown as Row[]
      for (const row of rows) {
        const ticket = this.host.store.tickets.get(ticketId), assignment = ticket?.assignments.at(-1)
        if (ticket && liveTicket(ticket) && assignment?.id === assignmentId && assignment.state === 'pending') return
        let result: unknown
        if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'running') {
          result = { reported: false, refused: 'Report assignment is no longer current' }
        } else {
          const report = JSON.parse(row.payload) as WorkerReport
          try {
            result = this.host.store.atomic(() => {
              const updated = this.host.report(ticketId, assignmentId, report)
              const relay = reportRelay(updated, report)
              if (relay) this.host.relay(relay.id, relay.text)
              return { reported: true, notification: relay ? 'orchestrator' : 'internal_only',
                ...(updated.attention ? { attention: updated.attention } : {}) }
            })
          } catch (error) {
            if (!(error instanceof UserError)) throw error
            result = { reported: false, refused: error.message }
          }
        }
        this.host.store.db.prepare('UPDATE paseo_report_receipt SET result=? WHERE ticket_id=? AND assignment_id=? AND request_id=?')
          .run(JSON.stringify(result), ticketId, assignmentId, row.request_id)
      }
    })
  }
}
