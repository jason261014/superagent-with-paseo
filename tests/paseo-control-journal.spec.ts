import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PaseoOperationJournal, type Intent } from '../src/paseo-control/journal.ts'

let directory: string
let db: DatabaseSync
let journal: PaseoOperationJournal
const create: Intent = { operationId: 'op-create', ticketId: 'ticket-1', assignmentId: 'assignment-1', kind: 'create', payload: '{"prompt":"hello"}' }
const send: Intent = { operationId: 'op-send', ticketId: 'ticket-1', assignmentId: 'assignment-1', kind: 'send', sessionId: 'session-1', messageId: 'message-1', payload: 'hello' }
const lookup = { kind: 'create' as const, operationId: create.operationId, ticketId: create.ticketId, assignmentId: create.assignmentId }
const message = { kind: 'send' as const, operationId: send.operationId, ticketId: send.ticketId, assignmentId: send.assignmentId, sessionId: 'session-1', messageId: 'message-1' }

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'paseo-journal-'))
  db = new DatabaseSync(join(directory, 'state.sqlite'))
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
  journal = new PaseoOperationJournal(db)
})
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })

it('persists create intent before side effects and requires reconciliation after restart even if absent', () => {
  expect(journal.claim(create)).toEqual({ action: 'execute' })
  db.close(); db = new DatabaseSync(join(directory, 'state.sqlite')); journal = new PaseoOperationJournal(db)
  expect(journal.claim(create)).toEqual({ action: 'reconcile' })
  expect(journal.observe({ ...lookup, sessionIds: [] })).toEqual({ action: 'reconcile' })
  expect(journal.claim(create)).toEqual({ action: 'reconcile' })
  expect(journal.observe({ ...lookup, sessionIds: ['session-1'] })).toEqual({ action: 'confirmed', resultId: 'session-1' })
  expect(journal.claim(create)).toEqual({ action: 'confirmed', resultId: 'session-1' })
})

it('does not authorize work inside an enclosing transaction', () => {
  db.exec('BEGIN')
  expect(() => journal.claim(create)).toThrow('outside a transaction')
  db.exec('ROLLBACK')
  expect(journal.claim(create)).toEqual({ action: 'execute' })
})

it('rejects reuse of an operation identity or logical create for different inputs', () => {
  journal.claim(create)
  expect(() => journal.claim({ ...create, payload: 'different' })).toThrow('identity conflict')
  expect(() => journal.claim({ ...create, assignmentId: 'other' })).toThrow('identity conflict')
  expect(() => journal.claim({ ...create, operationId: 'different' })).toThrow('identity conflict')
})

it('holds a send after uncertain delivery until exact message identity is observed', () => {
  expect(journal.claim(send)).toEqual({ action: 'execute' })
  expect(journal.claim(send)).toEqual({ action: 'reconcile' })
  expect(journal.observe({ ...message, present: false })).toEqual({ action: 'reconcile' })
  expect(() => journal.observe({ ...message, sessionId: 'another', present: true })).toThrow('identity conflict')
  expect(() => journal.observe({ ...message, messageId: 'another', present: true })).toThrow('identity conflict')
  expect(journal.observe({ ...message, present: true })).toEqual({ action: 'confirmed', resultId: 'message-1' })
  expect(journal.claim(send)).toEqual({ action: 'confirmed', resultId: 'message-1' })
})

it('rejects a second operation ID for the same message, even if its payload changes', () => {
  journal.claim(send)
  expect(() => journal.claim({ ...send, operationId: 'second' })).toThrow('identity conflict')
  expect(() => journal.claim({ ...send, operationId: 'second', payload: 'different' })).toThrow('identity conflict')
})

it('rejects ambiguous, stale or conflicting create observations', () => {
  journal.claim(create)
  expect(() => journal.observe({ ...lookup, assignmentId: 'old', sessionIds: ['session-1'] })).toThrow('identity conflict')
  expect(() => journal.observe({ ...lookup, sessionIds: ['session-1', 'session-2'] })).toThrow('Ambiguous')
  expect(journal.claim(create)).toEqual({ action: 'reconcile' })
  journal.observe({ ...lookup, sessionIds: ['session-1'] })
  expect(() => journal.observe({ ...lookup, sessionIds: ['session-2'] })).toThrow('Conflicting confirmation')
})
