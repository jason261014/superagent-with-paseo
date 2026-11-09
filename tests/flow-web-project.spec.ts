import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { KV, family } from '../src/kv.ts'
import { PaseoOperationJournal } from '../src/paseo-control/journal.ts'
import { PaseoReports } from '../src/paseo/reports.ts'
import { projectFlowItem, projectFlowOverview, SWIMLANE_X } from '../src/flow-web/project.ts'
import type { Decision, Ticket, Trigger, TriggerDisposition } from '../src/core/index.ts'

const dirs: string[] = []
const sessionBindings = family<{ agentId: string; revision: number; options: Record<string, unknown> }>('paseo-session:')
const sessionConfigs = family<{ options: Record<string, unknown>; revision: number }>('paseo-session-config:')
const frozenMessages = family<{ text: string; revision?: number; notices?: { key: string; text: string }[] }>('paseo-message:')
const deliveryText = family<string>('paseo-delivery:')

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function openStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sa-flow-project-'))
  dirs.push(dir)
  return new Store(join(dir, 'orchestrator.sqlite'))
}

function seedFlowFixture(store: Store) {
  const masterId = 'orchestrator-master-01'
  store.set(KV.runtime.masterId, masterId)
  store.set(sessionBindings(masterId), {
    agentId: 'agent-orch-01',
    revision: 3,
    options: {
      provider: 'claude-pool',
      model: 'friday-deepseek-v4-flash',
      mode: 'auto',
      cwd: '/Users/test/.dsh/state/sa-paseo-check',
      systemPrompt: 'SECRET_ORCHESTRATOR_SYSTEM_PROMPT',
      env: { SUPERAGENT_BRIDGE_TOKEN: 'secret-orch-bridge-token', GITHUB_TOKEN: 'ghp_secret_value' },
      mcpServers: { superagent: { env: { SUPERAGENT_BRIDGE_TOKEN: 'secret-orch-bridge-token' } } },
    },
  })

  const requestId = 'paseo-' + 'a'.repeat(64)
  const trigger: Trigger = {
    id: 'trg-001',
    source: 'local',
    threads: [{ source: 'local', id: requestId }],
    actor: { source: 'local', id: 'uid:501' },
    human: true,
    addressed: 'direct',
    at: '2026-11-08T09:00:00.000Z',
    text: 'Check workspace status and run smoke tests',
    channel: { source: 'local', thread: requestId, address: { threadId: requestId } },
    meta: { requestId },
  }
  store.triggers.save(trigger)
  store.set(KV.conversation.binding, { version: 1, hostId: '1'.repeat(32), conversationId: '2'.repeat(32) })
  store.set(KV.conversation.seq, 2)
  store.set(KV.conversation.event(1), { type: 'user', requestId, at: trigger.at })
  store.set(KV.conversation.receipt(requestId), {
    requestId,
    triggerId: trigger.id,
    clientMessageId: 'msg-001',
    textHash: 'b'.repeat(64),
    seq: 1,
    at: trigger.at,
    result: 'stored',
  })
  store.set(KV.conversation.trigger(trigger.id), requestId)

  const decision: Decision = {
    id: 'dec-001',
    evalId: 'eval-001',
    threadKey: `local:${requestId}`,
    triggerIds: [trigger.id],
    policyVersion: 'pol-v1',
    at: '2026-11-08T09:00:02.000Z',
    kind: 'accept',
    reason: [{ code: 'explicitRequest' }],
    strength: 'explicit',
    ticketId: 'tkt-001',
    mandate: {
      strength: 'explicit',
      policyVersion: 'pol-v1',
      basis: { via: 'addressed', addressed: 'direct' },
      actor: trigger.actor,
      scope: 'Inspect workspace and run smoke tests',
    },
  }
  store.decisions.save(decision)

  const disposition: TriggerDisposition = {
    evalId: 'eval-001',
    decisionId: decision.id,
    fanout: ['tkt-001', 'tkt-002'],
    acked: ['tkt-001'],
    at: '2026-11-08T09:00:02.000Z',
  }
  store.triggers.saveDisposition(trigger.id, disposition)

  const ticket1: Ticket = {
    id: 'tkt-001',
    title: 'Primary workspace check',
    decisionId: decision.id,
    mandate: decision.mandate!,
    channels: [trigger.channel!],
    createdAt: '2026-11-08T09:00:02.000Z',
    updatedAt: '2026-11-08T09:03:00.000Z',
    origin: { triggerId: trigger.id, triggerIds: [trigger.id] },
    execution: {
      name: 'workspace-tkt-001',
      directory: '/Users/test/.dsh/state/sa-paseo-check/work/workspace-tkt-001',
      assignment: 'Inspect workspace and report',
    },
    ended: {
      at: '2026-11-08T09:03:00.000Z',
      by: 'executor',
      outcome: 'completed',
    },
    assignments: [
      {
        id: 'asg-1',
        state: 'ended',
        createdAt: '2026-11-08T09:00:02.000Z',
        startedAt: '2026-11-08T09:00:04.000Z',
        endedAt: '2026-11-08T09:01:00.000Z',
        endedReason: 'failed',
        report: {
          state: 'failed',
          summary: 'First worker attempt timed out',
          at: '2026-11-08T09:00:55.000Z',
        },
      },
      {
        id: 'asg-2',
        state: 'ended',
        createdAt: '2026-11-08T09:01:10.000Z',
        startedAt: '2026-11-08T09:01:12.000Z',
        endedAt: '2026-11-08T09:03:00.000Z',
        endedReason: 'completed',
        deliveredAt: '2026-11-08T09:01:30.000Z',
        report: {
          state: 'ready',
          summary: 'All checks passed on second attempt',
          at: '2026-11-08T09:02:50.000Z',
        },
      },
    ],
    inputs: [
      {
        id: 'inp-1',
        kind: 'trigger',
        triggerId: trigger.id,
        at: '2026-11-08T09:01:20.000Z',
        human: true,
        deliveredTo: 'asg-2',
        deliveredAt: '2026-11-08T09:01:30.000Z',
        readAt: '2026-11-08T09:01:31.000Z',
      },
      {
        id: 'inp-2',
        kind: 'note',
        text: 'Also check build output size',
        at: '2026-11-08T09:01:40.000Z',
      },
    ],
    undelivered: ['inp-2'],
  }

  const ticket2: Ticket = {
    id: 'tkt-002',
    title: 'Fanout companion ticket',
    decisionId: decision.id,
    mandate: decision.mandate!,
    channels: [trigger.channel!],
    createdAt: '2026-11-08T09:00:03.000Z',
    updatedAt: '2026-11-08T09:00:30.000Z',
    origin: { triggerId: trigger.id, triggerIds: [trigger.id] },
    execution: {
      name: 'fanout-tkt-002',
      directory: '/Users/test/.dsh/state/sa-paseo-check/work/fanout-tkt-002',
      assignment: 'Companion check',
    },
    assignments: [
      {
        id: 'asg-201',
        state: 'running',
        createdAt: '2026-11-08T09:00:03.000Z',
        startedAt: '2026-11-08T09:00:06.000Z',
      },
    ],
    inputs: [],
    undelivered: [],
  }

  store.tickets.save(ticket1)
  store.tickets.save(ticket2)

  // Current worker session binding only points at the second assignment's agent, while journal preserves asg-1's historical agentId.
  store.set(sessionBindings('worker:tkt-001'), {
    agentId: 'agent-worker-asg-2',
    revision: 3,
    options: {
      provider: 'claude-pool',
      model: 'friday-deepseek-v4-flash',
      mode: 'auto',
      cwd: '/Users/test/.dsh/state/sa-paseo-check',
      parent: 'agent-orch-01',
      systemPrompt: 'SECRET_WORKER_PROMPT',
      env: { SUPERAGENT_BRIDGE_TOKEN: 'secret-worker-bridge-token' },
    },
  })
  store.set(sessionConfigs('worker:tkt-001:asg-1'), {
    revision: 2,
    options: {
      provider: 'claude-pool',
      model: 'friday-deepseek-v4-flash',
      mode: 'read-only',
      cwd: '/Users/test/.dsh/state/sa-paseo-check',
      parent: 'agent-orch-01',
      systemPrompt: 'SECRET_ASG1_PROMPT',
      env: { SUPERAGENT_BRIDGE_TOKEN: 'secret-asg1-token' },
    },
  })
  store.set(sessionConfigs('worker:tkt-001:asg-2'), {
    revision: 3,
    options: {
      provider: 'claude-pool',
      model: 'friday-deepseek-v4-flash',
      mode: 'auto',
      cwd: '/Users/test/.dsh/state/sa-paseo-check',
      parent: 'agent-orch-01',
      systemPrompt: 'SECRET_ASG2_PROMPT',
      env: { SUPERAGENT_BRIDGE_TOKEN: 'secret-asg2-token' },
    },
  })

  const journal = new PaseoOperationJournal(store.db)
  journal.claim({
    kind: 'create',
    operationId: 'op-create-asg-1',
    ticketId: 'tkt-001',
    assignmentId: 'asg-1',
    cwd: '/Users/test/.dsh/state/sa-paseo-check',
    payload: JSON.stringify({ create: 'asg-1', cwd: '/Users/test/.dsh/state/sa-paseo-check' }),
  })
  journal.observe({
    kind: 'create',
    operationId: 'op-create-asg-1',
    ticketId: 'tkt-001',
    assignmentId: 'asg-1',
    sessionIds: ['agent-worker-asg-1-historical'],
  })

  journal.claim({
    kind: 'create',
    operationId: 'op-create-asg-2',
    ticketId: 'tkt-001',
    assignmentId: 'asg-2',
    cwd: '/Users/test/.dsh/state/sa-paseo-check',
    payload: JSON.stringify({ create: 'asg-2', cwd: '/Users/test/.dsh/state/sa-paseo-check' }),
  })
  journal.observe({
    kind: 'create',
    operationId: 'op-create-asg-2',
    ticketId: 'tkt-001',
    assignmentId: 'asg-2',
    sessionIds: ['agent-worker-asg-2'],
  })

  // Unconfirmed send intent on asg-2 (result_id remains null)
  const sendMsgId = 'msg-send-asg-2-input'
  store.set(deliveryText(sendMsgId), 'Follow-up input payload for asg-2')
  journal.claim({
    kind: 'send',
    operationId: 'op-send-asg-2-unconfirmed',
    ticketId: 'tkt-001',
    assignmentId: 'asg-2',
    sessionId: 'agent-worker-asg-2',
    messageId: sendMsgId,
    payload: '{"text":"Follow-up input payload for asg-2"}',
  })

  // Coordinator relay correlated with tkt-001
  const orchRelayMsgId = 'superagent-orch-relay-01'
  store.set(frozenMessages(orchRelayMsgId), {
    text: 'Background notice: {"ticket_id":"tkt-001","state":"ready"}',
    revision: 3,
    notices: [],
  })
  journal.claim({
    kind: 'send',
    operationId: orchRelayMsgId,
    ticketId: masterId,
    assignmentId: 'session',
    sessionId: 'agent-orch-01',
    messageId: orchRelayMsgId,
    payload: '{"text":"relay for tkt-001"}',
  })
  journal.observe({
    kind: 'send',
    operationId: orchRelayMsgId,
    ticketId: masterId,
    assignmentId: 'session',
    sessionId: 'agent-orch-01',
    messageId: orchRelayMsgId,
    present: true,
  })

  // Unrelated coordinator message that must NOT be attached to tkt-001
  const unrelatedMsgId = 'superagent-orch-other'
  store.set(frozenMessages(unrelatedMsgId), {
    text: 'Candidate for another unrelated thread eval-999',
    revision: 3,
    notices: [],
  })
  journal.claim({
    kind: 'send',
    operationId: unrelatedMsgId,
    ticketId: masterId,
    assignmentId: 'session',
    sessionId: 'agent-orch-01',
    messageId: unrelatedMsgId,
    payload: '{"text":"unrelated"}',
  })

  // Multiple report receipts in paseo_report_receipt table
  new PaseoReports({
    store,
    report: () => ticket1,
    relay: () => {},
  })
  store.db
    .prepare('INSERT INTO paseo_report_receipt(ticket_id,assignment_id,request_id,payload,result) VALUES (?,?,?,?,?)')
    .run(
      'tkt-001',
      'asg-2',
      'req-rep-1',
      JSON.stringify({ state: 'progress', summary: 'Running test suite step 1' }),
      JSON.stringify({ reported: true, notification: 'internal_only' }),
    )
  store.db
    .prepare('INSERT INTO paseo_report_receipt(ticket_id,assignment_id,request_id,payload,result) VALUES (?,?,?,?,?)')
    .run(
      'tkt-001',
      'asg-2',
      'req-rep-2',
      JSON.stringify({ state: 'ready', summary: 'All checks passed on second attempt' }),
      JSON.stringify({ reported: true, notification: 'orchestrator' }),
    )

  // Outbox reply
  const replyMessage = {
    id: 'rep-001',
    channel: trigger.channel!,
    text: 'Workspace check finished: all smoke tests passed.',
    kind: 'reply' as const,
    ticketId: 'tkt-001',
  }
  store.receipts.add(replyMessage)
  store.receipts.settle(replyMessage, 'sent')
  store.set(KV.local.reply(replyMessage.id), replyMessage)
  store.set(KV.conversation.event(2), {
    type: 'assistant',
    replyId: replyMessage.id,
    at: '2026-11-08T09:03:05.000Z',
  })

  return { requestId, triggerId: trigger.id }
}

it('projects overview with full fanout tickets, watermark, and sanitized orchestrator metadata', () => {
  const store = openStore()
  const { requestId } = seedFlowFixture(store)

  const overview = projectFlowOverview(store, { phase: 'ready' })
  expect(overview.host.phase).toBe('ready')
  expect(overview.host.masterId).toBe('orchestrator-master-01')
  expect(overview.host.orchestrator?.agentId).toBe('agent-orch-01')
  expect(overview.watermark).toBeTruthy()

  const requestItem = overview.items.find(item => item.kind === 'request' && item.id === requestId)
  expect(requestItem).toBeDefined()
  // Must preserve full fanout (both tkt-001 and tkt-002), not just single receipt.ticketId
  expect(requestItem?.ticketIds).toEqual(['tkt-001', 'tkt-002'])

  const rawJson = JSON.stringify(overview)
  expect(rawJson).not.toContain('SUPERAGENT_BRIDGE_TOKEN')
  expect(rawJson).not.toContain('secret-orch-bridge-token')
  expect(rawJson).not.toContain('SECRET_ORCHESTRATOR_SYSTEM_PROMPT')
  expect(rawJson).not.toContain('ghp_secret_value')
  store.close()
})

it('projects deterministic 3-swimlane nodes, historical worker agentIds, aggregated report/input edges, and explicit unknowns', () => {
  const store = openStore()
  seedFlowFixture(store)

  const projected = projectFlowItem(store, 'ticket', 'tkt-001')
  expect(projected).toBeDefined()
  const view = projected!

  // Deterministic swimlanes
  const triggerNode = view.nodes.find(node => node.id === 'trigger:trg-001')
  const controlNode = view.nodes.find(node => node.id === 'control:dec-001')
  const orchNode = view.nodes.find(node => node.id === 'orchestrator:orchestrator-master-01')
  const ticketNode = view.nodes.find(node => node.id === 'ticket:tkt-001')
  const historyNode = view.nodes.find(node => node.id === 'assignment-history:tkt-001')
  const latestAsgNode = view.nodes.find(node => node.id === 'assignment:tkt-001:asg-2')
  const historicalAsgNode = view.nodes.find(node => node.id === 'assignment:tkt-001:asg-1')
  const outboxNode = view.nodes.find(node => node.id === 'outbox:rep-001')

  expect(triggerNode?.position.x).toBe(SWIMLANE_X.superagent)
  expect(controlNode?.position.x).toBe(SWIMLANE_X.superagent)
  expect(outboxNode?.position.x).toBe(SWIMLANE_X.superagent)
  expect(orchNode?.position.x).toBe(SWIMLANE_X.orchestrator)
  expect(ticketNode?.position.x).toBe(SWIMLANE_X.worker)
  expect(historyNode?.position.x).toBe(SWIMLANE_X.worker)
  expect(latestAsgNode?.position.x).toBe(SWIMLANE_X.worker)
  expect(historicalAsgNode?.position.x).toBe(SWIMLANE_X.worker)

  // Historical worker agentId comes from paseo_operation_intent(kind='create').result_id, NOT overwritten by current session binding
  expect(historicalAsgNode?.data.worker?.agentId).toBe('agent-worker-asg-1-historical')
  expect(historicalAsgNode?.data.worker?.mode).toBe('read-only')
  expect(latestAsgNode?.data.worker?.agentId).toBe('agent-worker-asg-2')
  expect(latestAsgNode?.data.worker?.mode).toBe('auto')
  // Distinct Paseo startup cwd vs ticket execution directory
  expect(latestAsgNode?.data.worker?.startupCwd).toBe('/Users/test/.dsh/state/sa-paseo-check')
  expect(latestAsgNode?.data.executionDirectory).toBe('/Users/test/.dsh/state/sa-paseo-check/work/workspace-tkt-001')

  // Multiple reports on asg-2 aggregate into one worker_report edge with count=2
  const reportEdges = view.edges.filter(edge => edge.kind === 'worker_report' && edge.source === 'assignment:tkt-001:asg-2')
  expect(reportEdges).toHaveLength(1)
  expect(reportEdges[0]?.data.count).toBe(2)
  expect(reportEdges[0]?.data.latestState).toBe('ready')

  // Follow-up inputs aggregate on followup_input edge with delivered + undelivered counts
  const inputEdge = view.edges.find(edge => edge.kind === 'followup_input' && edge.target === 'assignment:tkt-001:asg-2')
  expect(inputEdge?.data.count).toBe(2)
  expect(inputEdge?.data.undeliveredCount).toBe(1)

  // Timeline & evidence rules:
  // 1) Progress report #1 in paseo_report_receipt has no dedicated receipt timestamp -> must NOT fabricate a timestamp
  const rep1Event = view.timeline.find(item => item.id === 'report:tkt-001:asg-2:1')
  expect(rep1Event).toBeDefined()
  expect(rep1Event?.at).toBeNull()
  expect(rep1Event?.timestampNote).toBe('timestamp_not_recorded')

  // 2) Ready report #2 matches assignment.report -> carries assignment.report.at
  const rep2Event = view.timeline.find(item => item.id === 'report:tkt-001:asg-2:2')
  expect(rep2Event?.at).toBe('2026-11-08T09:02:50.000Z')

  // 3) Unconfirmed journal operation is explicitly marked unconfirmed and has null timestamp
  const unconfirmedOp = view.timeline.find(item => item.id === 'intent:op-send-asg-2-unconfirmed')
  expect(unconfirmedOp).toBeDefined()
  expect(unconfirmedOp?.at).toBeNull()
  expect(unconfirmedOp?.confirmation).toBe('unconfirmed')

  // 4) Unrelated orchestrator message is excluded from tkt-001 view
  expect(view.timeline.some(item => item.id.includes('superagent-orch-other'))).toBe(false)
  expect(view.timeline.some(item => item.id.includes('superagent-orch-relay-01'))).toBe(true)

  // 5) Separate task completion vs reply delivery vs human read
  expect(view.summary.workerReportState).toBe('ready')
  expect(view.summary.ticketOutcome).toBe('completed')
  expect(view.summary.replyDelivery).toBe('sent')
  expect(view.unknowns.some(u => u.code === 'human_read_not_tracked')).toBe(true)
  expect(view.unknowns.some(u => u.code === 'unconfirmed_operation_intent')).toBe(true)

  // 6) Strict redaction check across the entire item payload
  const serialized = JSON.stringify(view)
  expect(serialized).not.toContain('SUPERAGENT_BRIDGE_TOKEN')
  expect(serialized).not.toContain('secret-worker-bridge-token')
  expect(serialized).not.toContain('secret-asg1-token')
  expect(serialized).not.toContain('SECRET_WORKER_PROMPT')
  expect(serialized).not.toContain('SECRET_ASG1_PROMPT')
  store.close()
})

it('projects a request view with all fanout tickets so the user can switch focus across fanout targets', () => {
  const store = openStore()
  const { requestId } = seedFlowFixture(store)

  const requestView = projectFlowItem(store, 'request', requestId)
  expect(requestView).toBeDefined()
  expect(requestView?.relatedTickets.map(t => t.id)).toEqual(['tkt-001', 'tkt-002'])
  expect(requestView?.nodes.some(node => node.id === 'ticket:tkt-001')).toBe(true)
  expect(requestView?.nodes.some(node => node.id === 'ticket:tkt-002')).toBe(true)
  // Coordinator intent evidence must never attach to every message merely because a request has no ticket id.
  expect(requestView?.timeline.some(item => item.id === 'intent:superagent-orch-other')).toBe(false)
  expect(requestView?.timeline.every(item => item.category !== 'intent' || JSON.stringify(item.evidence).includes('tkt-001'))).toBe(true)
  store.close()
})
