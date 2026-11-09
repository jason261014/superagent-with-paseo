// @vitest-environment jsdom
import { act } from 'react'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
if (!('ResizeObserver' in globalThis)) {
  class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(globalThis, 'ResizeObserver', { value: TestResizeObserver, configurable: true })
}
if (!('DOMMatrixReadOnly' in globalThis)) {
  Object.defineProperty(globalThis, 'DOMMatrixReadOnly', { value: class { m22 = 1 }, configurable: true })
}
import { createRoot } from 'react-dom/client'
import { onTestFinished, expect, it, vi } from 'vitest'
import { FlowCanvasApp } from '../src/flow-web/ui/App.tsx'
import type { FlowItemView, FlowOverviewResponse } from '../src/flow-web/model.ts'

function overview(): FlowOverviewResponse {
  return {
    watermark: 'w1',
    host: { phase: 'ready', masterId: 'orchestrator-master-01', orchestrator: { sessionKey: 'orchestrator-master-01', role: 'orchestrator', agentId: 'agent-orch-01', provider: 'claude-pool', model: 'friday-deepseek-v4-flash', mode: 'auto', startupCwd: '/state', confirmation: 'bound_only' } },
    counts: { totalItems: 2, activeTickets: 1, attentionTickets: 0, completedTickets: 1, unacceptedRequests: 0 },
    items: [
      { kind: 'request', id: 'req-1', title: 'Check workspace status', subtitle: 'local · accept · 2 ticket(s)', source: 'local', status: 'accepted', updatedAt: '2026-11-08T09:05:00.000Z', ticketIds: ['tkt-001', 'tkt-002'] },
      { kind: 'ticket', id: 'tkt-001', title: 'Primary workspace check', subtitle: 'ended · 2 assignment(s)', source: 'local', status: 'completed', updatedAt: '2026-11-08T09:03:00.000Z', ticketIds: ['tkt-001'], assignmentCount: 2, replyStatus: 'sent' },
    ],
    nextCursor: null,
    hasMore: false,
  }
}

function item(): FlowItemView {
  return {
    watermark: 'w1',
    focus: { kind: 'ticket', id: 'tkt-001', primaryTicketId: 'tkt-001' },
    summary: { requestStatus: 'received', routingDecision: 'accept', workerReportState: 'ready', ticketOutcome: 'completed', replyDelivery: 'sent' },
    relatedTickets: [{ id: 'tkt-001', title: 'Primary workspace check', status: 'completed', updatedAt: '2026-11-08T09:03:00.000Z', assignmentCount: 2 }],
    nodes: [
      { id: 'trigger:trg-001', kind: 'trigger', swimlane: 'superagent', position: { x: 80, y: 60 }, data: { label: 'local · uid:501', subtitle: 'Check workspace status', status: 'human', at: '2026-11-08T09:00:00.000Z', evidence: {} } },
      { id: 'control:dec-001', kind: 'control', swimlane: 'superagent', position: { x: 80, y: 210 }, data: { label: 'Decision: accept', status: 'accept', at: '2026-11-08T09:00:02.000Z', reasonCodes: ['explicitRequest'], policyVersion: 'pol-v1', evidence: {} } },
      { id: 'orchestrator:orchestrator-master-01', kind: 'orchestrator', swimlane: 'orchestrator', position: { x: 460, y: 60 }, data: { label: 'Orchestrator', status: 'bound', worker: { sessionKey: 'orchestrator-master-01', role: 'orchestrator', agentId: 'agent-orch-01', mode: 'auto', confirmation: 'bound_only' }, evidence: {} } },
      { id: 'ticket:tkt-001', kind: 'ticket', swimlane: 'worker', position: { x: 860, y: 60 }, data: { label: 'Primary workspace check', subtitle: 'Inspect workspace and run smoke tests', status: 'completed', ticketId: 'tkt-001', evidence: {} } },
      { id: 'assignment-history:tkt-001', kind: 'assignment-history', swimlane: 'worker', position: { x: 860, y: 210 }, data: { label: '1 earlier assignment(s)', status: 'folded', hiddenAssignmentIds: ['asg-1'], evidence: {} } },
      { id: 'assignment:tkt-001:asg-1', kind: 'assignment', swimlane: 'worker', position: { x: 860, y: 210 }, hiddenByHistoryFold: true, data: { label: 'Assignment asg-1', status: 'ended', assignmentId: 'asg-1', ticketId: 'tkt-001', worker: { sessionKey: 'worker:tkt-001:asg-1', role: 'worker', agentId: 'agent-worker-asg-1-historical', mode: 'read-only', confirmation: 'confirmed' }, evidence: {} } },
      { id: 'assignment:tkt-001:asg-2', kind: 'assignment', swimlane: 'worker', position: { x: 860, y: 360 }, data: { label: 'Assignment asg-2', status: 'ended', assignmentId: 'asg-2', ticketId: 'tkt-001', executionDirectory: '/state/work/workspace-tkt-001', worker: { sessionKey: 'worker:tkt-001:asg-2', role: 'worker', agentId: 'agent-worker-asg-2', mode: 'auto', confirmation: 'confirmed' }, evidence: {} } },
      { id: 'outbox:rep-001', kind: 'outbox', swimlane: 'superagent', position: { x: 80, y: 360 }, data: { label: 'reply → local', subtitle: 'Workspace check finished', status: 'sent', replyKind: 'reply', replyStatus: 'sent', evidence: {} } },
    ],
    edges: [
      { id: 'intake:trg-001', kind: 'intake', source: 'trigger:trg-001', target: 'control:dec-001', data: { label: 'intake', status: 'recorded', evidence: {} } },
      { id: 'ticket_open:tkt-001', kind: 'ticket_open', source: 'control:dec-001', target: 'ticket:tkt-001', data: { label: 'accept', status: 'accept', evidence: {} } },
      { id: 'worker_report:tkt-001:asg-2', kind: 'worker_report', source: 'assignment:tkt-001:asg-2', target: 'orchestrator:orchestrator-master-01', data: { label: 'reports', status: 'ready', count: 2, latestState: 'ready', evidence: {} } },
      { id: 'followup_input:tkt-001:asg-2', kind: 'followup_input', source: 'trigger:trg-001', target: 'assignment:tkt-001:asg-2', data: { label: 'inputs', status: 'partially undelivered', count: 2, undeliveredCount: 1, evidence: {} } },
    ],
    timeline: [
      { id: 'trigger:trg-001', order: 0, category: 'trigger', title: 'Request received', summary: 'Check workspace status', status: 'human', at: '2026-11-08T09:00:00.000Z', timestampNote: 'exact', nodeIds: ['trigger:trg-001'], edgeIds: ['intake:trg-001'], evidence: {} },
      { id: 'report:tkt-001:asg-2:1', order: 1, category: 'report', title: 'Worker report #1', summary: 'Running test suite step 1', status: 'progress', at: null, timestampNote: 'timestamp_not_recorded', nodeIds: ['assignment:tkt-001:asg-2'], edgeIds: ['worker_report:tkt-001:asg-2'], evidence: {} },
      { id: 'intent:op-send-unconfirmed', order: 2, category: 'intent', title: 'send intent', summary: 'Unconfirmed side effect', status: 'unconfirmed', at: null, timestampNote: 'timestamp_not_recorded', confirmation: 'unconfirmed', nodeIds: ['assignment:tkt-001:asg-2'], edgeIds: [], evidence: {} },
      { id: 'reply:rep-001', order: 3, category: 'reply', title: 'reply reply', summary: 'Workspace check finished', status: 'sent', at: '2026-11-08T09:03:05.000Z', timestampNote: 'exact', nodeIds: ['outbox:rep-001'], edgeIds: ['outbound_reply:rep-001:out'], evidence: {} },
    ],
    unknowns: [
      { code: 'human_read_not_tracked', title: 'Human read not tracked', detail: 'Sent does not mean read.', relatedIds: ['tkt-001'] },
      { code: 'unconfirmed_operation_intent', title: 'Unconfirmed side effect exists', detail: 'Never safe to resend.', relatedIds: ['op-send-unconfirmed'] },
    ],
    truncated: false,
  }
}

const settle = () => act(async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 0)) })

function mount(element: React.ReactElement) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  onTestFinished(() => { act(() => root.unmount()); container.remove() })
  return { container, root, render: async (node: React.ReactElement) => { await act(async () => { root.render(node) }); await settle() } }
}

it('renders the four panes, three swimlanes, folded history, and sent-vs-completed-vs-human-read distinctions', async () => {
  const mounted = mount(<FlowCanvasApp loadOverview={async () => overview()} loadItem={async () => item()} pollMs={0} />)
  await mounted.render(<FlowCanvasApp loadOverview={async () => overview()} loadItem={async () => item()} pollMs={0} />)
  let text = mounted.container.textContent ?? ''
  expect(text).toContain('交付时序')
  expect(text).toContain('Primary workspace check')
  expect(text).toContain('Request received')
  expect(text).toContain('Worker report')
  expect(text).toContain('Human read not tracked')
  const laneHeaders = [...mounted.container.querySelectorAll('.flow-seq-lanehead')].map(node => node.textContent)
  expect(laneHeaders).toEqual(['用户', 'Superagent / 交付', 'Orchestrator', 'Worker'])
  const rows = [...mounted.container.querySelectorAll('.flow-seq-row')]
  expect(rows.find(row => row.textContent?.includes('Request received'))?.getAttribute('data-lane')).toBe('0')
  expect(rows.find(row => row.textContent?.includes('Worker report #1'))?.getAttribute('data-lane')).toBe('3')
  expect(rows.find(row => row.textContent?.includes('reply reply'))?.getAttribute('data-lane')).toBe('1')
  expect(text).toContain('completed')
  expect(text).toContain('sent')
  const graphTab = [...mounted.container.querySelectorAll('button')].find(button => (button.textContent ?? '') === '关系画布')
  expect(graphTab).toBeDefined()
  await act(async () => { graphTab!.click() })
  await settle()
  text = mounted.container.textContent ?? ''
  expect(text).toContain('Superagent')
  expect(text).toContain('Orchestrator')
  expect(text).toContain('1 earlier assignment')
  expect(mounted.container.querySelectorAll('[data-swimlane]').length).toBeGreaterThanOrEqual(3)
})

it('expands historical assignments and highlights nodes and edges when a timeline event is clicked', async () => {
  const mounted = mount(<FlowCanvasApp loadOverview={async () => overview()} loadItem={async () => item()} pollMs={0} />)
  await mounted.render(<FlowCanvasApp loadOverview={async () => overview()} loadItem={async () => item()} pollMs={0} />)
  const graphTab = [...mounted.container.querySelectorAll('button')].find(button => (button.textContent ?? '') === '关系画布')
  await act(async () => { graphTab!.click() })
  await settle()
  const fold = [...mounted.container.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('earlier assignment'))
  expect(fold).toBeDefined()
  await act(async () => { fold!.click() })
  await settle()
  expect(mounted.container.textContent).toContain('Assignment asg-1')

  const sequenceTab = [...mounted.container.querySelectorAll('button')].find(button => (button.textContent ?? '') === '交付时序')
  await act(async () => { sequenceTab!.click() })
  await settle()
  const event = [...mounted.container.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('Worker report #1'))
  expect(event).toBeDefined()
  await act(async () => { event!.click() })
  await settle()
  expect(mounted.container.querySelector('.flow-step-card.is-active')).toBeTruthy()
  expect(mounted.container.textContent).toContain('该记录没有接收时间')
  await act(async () => { graphTab!.click() })
  await settle()
  expect(mounted.container.querySelector('[data-highlighted="true"]')).toBeTruthy()
})

it('keeps the current selection when a poll watermark is unchanged', async () => {
  const loadItem = vi.fn(async () => item())
  const mounted = mount(<FlowCanvasApp loadOverview={async () => overview()} loadItem={loadItem} pollMs={0} />)
  await mounted.render(<FlowCanvasApp loadOverview={async () => overview()} loadItem={loadItem} pollMs={0} />)
  const request = [...mounted.container.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('Check workspace status'))
  await act(async () => { request!.click() })
  await settle()
  const refresh = [...mounted.container.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('刷新'))
  expect(refresh).toBeDefined()
  await act(async () => { refresh!.click() })
  await settle()
  expect(mounted.container.querySelector('.flow-item[aria-selected="true"]')?.textContent).toContain('Check workspace status')
})

it('opens evidence as a closable bottom sheet instead of a permanent column', async () => {
  const mounted = mount(<FlowCanvasApp loadOverview={async () => overview()} loadItem={async () => item()} pollMs={0} />)
  await mounted.render(<FlowCanvasApp loadOverview={async () => overview()} loadItem={async () => item()} pollMs={0} />)
  expect(mounted.container.querySelector('.flow-sheet')).toBeNull()
  const step = [...mounted.container.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('Request received'))
  await act(async () => { step!.click() })
  await settle()
  expect(mounted.container.querySelector('.flow-sheet')).toBeTruthy()
  expect(mounted.container.textContent).toContain('证据详情')
  const close = mounted.container.querySelector('.flow-sheet button[aria-label="关闭证据详情"]')
  expect(close).toBeTruthy()
  await act(async () => { (close as HTMLButtonElement).click() })
  await settle()
  expect(mounted.container.querySelector('.flow-sheet')).toBeNull()
})

it('replays the relationship graph one step at a time with animation classes', async () => {
  const mounted = mount(<FlowCanvasApp loadOverview={async () => overview()} loadItem={async () => item()} pollMs={0} />)
  await mounted.render(<FlowCanvasApp loadOverview={async () => overview()} loadItem={async () => item()} pollMs={0} />)
  const graphTab = [...mounted.container.querySelectorAll('button')].find(button => (button.textContent ?? '') === '关系画布')
  await act(async () => { graphTab!.click() })
  await settle()
  const fullCount = mounted.container.querySelectorAll('.react-flow__node').length
  const replay = [...mounted.container.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('重放'))
  expect(replay).toBeDefined()
  await act(async () => { replay!.click() })
  await settle()
  const firstCount = mounted.container.querySelectorAll('.react-flow__node').length
  expect(firstCount).toBeLessThan(fullCount)
  expect(mounted.container.querySelector('.flow-replay-status')?.textContent).toContain('第 1 /')
  expect(mounted.container.querySelector('.flow-replay-node')).toBeTruthy()
  const next = [...mounted.container.querySelectorAll('button')].find(button => (button.textContent ?? '') === '下一步')
  await act(async () => { next!.click() })
  await settle()
  expect(mounted.container.querySelectorAll('.react-flow__node').length).toBeGreaterThanOrEqual(firstCount)
  expect(mounted.container.querySelector('.flow-replay-status')?.textContent).toContain('第 2 /')
})
