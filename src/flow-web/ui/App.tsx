/** Read-only four-pane flow canvas: request list, React Flow swimlanes, evidence drawer, event timeline. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import xyflowCss from '@xyflow/react/dist/style.css?raw'
import type {
  FlowCanvasEdge,
  FlowCanvasNode,
  FlowItemView,
  FlowListFilter,
  FlowOverviewItem,
  FlowOverviewResponse,
  FlowTimelineEntry,
  FlowUnknownNote,
} from '../model.ts'
import localCss from './styles.css?raw'

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById('flow-canvas-styles')) return
  const style = document.createElement('style')
  style.id = 'flow-canvas-styles'
  style.textContent = xyflowCss + '\n' + localCss
  document.head.append(style)
}

export interface FlowCanvasAppProps {
  loadOverview: (cursor?: number, filter?: FlowListFilter, q?: string) => Promise<FlowOverviewResponse>
  loadItem: (kind: 'ticket' | 'request', id: string) => Promise<FlowItemView>
  pollMs?: number
}

type Selection =
  | { type: 'node'; node: FlowCanvasNode }
  | { type: 'edge'; edge: FlowCanvasEdge }
  | { type: 'timeline'; entry: FlowTimelineEntry }
  | { type: 'unknown'; note: FlowUnknownNote }
  | undefined

const FILTERS: { id: FlowListFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '进行中' },
  { id: 'attention', label: '待人处理' },
  { id: 'completed', label: '已结束' },
  { id: 'unaccepted', label: '未成单' },
]

const LANE_LABEL: Record<FlowCanvasNode['swimlane'], string> = {
  superagent: 'Superagent 入口 / 控制面',
  orchestrator: 'Orchestrator',
  worker: 'Ticket / Assignment / Worker',
}

interface NodeData extends Record<string, unknown> {
  source: FlowCanvasNode
  highlighted: boolean
  onSelect: (node: FlowCanvasNode) => void
}

function LaneNode({ data }: NodeProps<Node<NodeData, 'lane'>>) {
  const { source, highlighted, onSelect } = data
  return (
    <div className={`flow-node flow-node-${source.kind}${highlighted ? ' is-highlighted' : ''}`}
      data-swimlane={source.swimlane} data-node-id={source.id} data-highlighted={highlighted ? 'true' : 'false'}>
      <Handle type="target" position={Position.Left} className="flow-handle" isConnectable={false} />
      <button type="button" className="flow-node-body" onClick={() => onSelect(source)}>
        <span className="flow-node-title">{source.data.label}</span>
        {source.data.subtitle ? <span className="flow-node-subtitle">{source.data.subtitle}</span> : null}
        <span className="flow-node-meta">
          <span className={`flow-badge flow-badge-${source.data.status}`}>{source.data.status}</span>
          {source.data.at ? <span className="flow-time">{source.data.at}</span> : <span className="flow-time flow-time-unknown">timestamp not recorded</span>}
        </span>
        {source.data.reasonCodes?.length ? <span className="flow-node-reason">{source.data.reasonCodes.join(', ')}</span> : null}
        {source.data.assignmentId ? <span className="flow-node-id">{source.data.assignmentId}</span> : null}
      </button>
      <Handle type="source" position={Position.Right} className="flow-handle" isConnectable={false} />
    </div>
  )
}

const nodeTypes = { lane: LaneNode }

function toNodes(item: FlowItemView, expanded: boolean, selectedId: string | undefined, onSelect: (node: FlowCanvasNode) => void, replay = false): Node<NodeData, 'lane'>[] {
  return item.nodes
    .filter(node => !node.hiddenByHistoryFold || expanded)
    .filter(node => !(expanded && node.kind === 'assignment-history'))
    .map(node => ({
      id: node.id,
      type: 'lane' as const,
      position: node.position,
      draggable: false,
      connectable: false,
      deletable: false,
      className: replay ? 'flow-replay-node' : undefined,
      data: { source: node, highlighted: selectedId === node.id, onSelect },
    }))
}

function toEdges(item: FlowItemView, expanded: boolean, selectedEdgeId: string | undefined, replay = false): Edge[] {
  const visible = new Set(item.nodes.filter(node => !node.hiddenByHistoryFold || expanded)
    .filter(node => !(expanded && node.kind === 'assignment-history'))
    .map(node => node.id))
  return item.edges
    .filter(edge => !edge.hiddenByHistoryFold || expanded)
    .filter(edge => visible.has(edge.source) && visible.has(edge.target))
    .map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      animated: false,
      selectable: false,
      className: `${selectedEdgeId === edge.id ? 'flow-edge is-highlighted' : 'flow-edge'}${replay ? ' flow-replay-edge' : ''}`,
      label: edge.data.count !== undefined && edge.data.count > 1 ? `${edge.data.label} ×${edge.data.count}` : edge.data.label,
      labelShowBg: true,
      labelBgPadding: [4, 2] as [number, number],
      labelBgStyle: { fill: '#f8fafc', fillOpacity: 0.95 },
    }))
}

function Evidence({ selection, onClose, onTranscript, transcript }: {
  selection: NonNullable<Selection>
  onClose: () => void
  onTranscript: (sessionKey: string) => void
  transcript: { status: string; reason?: string; note?: string; entries?: { id: string; role: string; text: string }[] } | undefined
}) {
  const header = selection.type === 'node' ? selection.node.data.label
    : selection.type === 'edge' ? `连线 · ${selection.edge.data.label}`
    : selection.type === 'timeline' ? selection.entry.title : selection.note.title
  const evidence = selection.type === 'node' ? selection.node.data.evidence
    : selection.type === 'edge' ? selection.edge.data.evidence
    : selection.type === 'timeline' ? selection.entry.evidence : { code: selection.note.code, detail: selection.note.detail }
  const sessionKey = selection.type === 'node' ? selection.node.data.worker?.sessionKey : undefined
  return (
    <section className="flow-sheet" role="dialog" aria-modal="true" aria-label="证据详情">
      <div className="flow-sheet-head">
        <div><span className="flow-sheet-kicker">证据详情</span><h3>{header}</h3></div>
        <button type="button" onClick={onClose} aria-label="关闭证据详情">关闭</button>
      </div>
      <div className="flow-sheet-body">
      {selection.type === 'timeline' ? (
        <p className="flow-note">
          {selection.entry.at ?? '无时间戳'}
          {selection.entry.timestampNote && selection.entry.timestampNote !== 'exact' ? ` · ${selection.entry.timestampNote}` : ''}
        </p>
      ) : null}
      {selection.type === 'node' && selection.node.data.worker ? (
        <dl className="flow-fields">
          <dt>Worker agentId</dt><dd>{selection.node.data.worker.agentId ?? '(未确认)'}</dd>
          <dt>确认状态</dt><dd>{selection.node.data.worker.confirmation}</dd>
          <dt>模型 / 模式</dt><dd>{[selection.node.data.worker.model, selection.node.data.worker.mode].filter(Boolean).join(' · ')}</dd>
          <dt>Paseo 启动目录</dt><dd>{selection.node.data.worker.startupCwd ?? '(未记录)'}</dd>
          <dt>Ticket 执行目录</dt><dd>{selection.node.data.executionDirectory ?? '(未记录)'}</dd>
        </dl>
      ) : null}
      <pre className="flow-evidence">{JSON.stringify(evidence, null, 2)}</pre>
      {sessionKey ? (
        <div className="flow-transcript">
          <button type="button" onClick={() => onTranscript(sessionKey)}>查看当前绑定会话 Transcript</button>
          {transcript ? (
            <div>
              <p className="flow-note">{transcript.status === 'ok' ? transcript.note : `不可用：${transcript.reason}`}</p>
              {transcript.entries?.map(entry => <p key={entry.id} className="flow-transcript-line"><b>{entry.role}</b> {entry.text}</p>)}
            </div>
          ) : null}
        </div>
      ) : null}
      </div>
    </section>
  )
}


const ACTOR_OF: Record<FlowTimelineEntry['category'], string> = {
  trigger: '用户 / 入口',
  decision: 'Superagent',
  ticket: 'Orchestrator',
  assignment: 'Orchestrator',
  input: '用户 / Worker',
  report: 'Worker',
  intent: '系统凭证',
  reply: 'Superagent',
}

type SequenceLane = 0 | 1 | 2 | 3
const LANE_LABELS = ['用户', 'Superagent / 交付', 'Orchestrator', 'Worker'] as const

function laneOf(entry: FlowTimelineEntry): SequenceLane {
  switch (entry.category) {
    case 'trigger': return 0
    case 'decision':
    case 'reply': return 1
    case 'ticket':
    case 'assignment': return 2
    case 'report': return 3
    case 'input': return entry.evidence.kind === 'trigger' ? 0 : 2
    case 'intent': return 2
  }
}

const PHASE_OF: Record<FlowTimelineEntry['category'], string> = {
  trigger: '进入',
  decision: '决策',
  ticket: '立项',
  assignment: '派工',
  input: '输入',
  report: '汇报',
  intent: '凭证',
  reply: '交付',
}

function effectiveSteps(entries: FlowTimelineEntry[], showTechnical: boolean) {
  let last = Date.parse('2026-01-01T00:00:00.000Z')
  return entries
    .filter(entry => showTechnical || entry.category !== 'intent')
    .map(entry => {
      const parsed = entry.at ? Date.parse(entry.at) : Number.NaN
      const effective = Number.isFinite(parsed) ? parsed : last + 1
      last = effective
      return { entry, effective }
    })
    .sort((a, b) => a.effective - b.effective)
}

function DeliveryTimeline({ item, selection, onSelect }: {
  item: FlowItemView
  selection: Selection
  onSelect: (entry: FlowTimelineEntry) => void
}) {
  const [showTechnical, setShowTechnical] = useState(false)
  const steps = effectiveSteps(item.timeline, showTechnical)
  const hasAssignment = item.timeline.some(entry => entry.category === 'assignment')
  const hasReport = item.timeline.some(entry => entry.category === 'report')
  const hasReply = item.summary.replyDelivery === 'sent' || item.timeline.some(entry => entry.category === 'reply')
  const milestones = [
    { label: '请求已收到', done: item.timeline.some(entry => entry.category === 'trigger') },
    { label: '已做出路由决策', done: item.summary.routingDecision !== 'pending' },
    { label: '已派给 Worker', done: hasAssignment },
    { label: 'Worker 已汇报', done: hasReport },
    { label: '回复已交付', done: hasReply },
  ]
  return (
    <div className="flow-sequence">
      <div className="flow-stepper" aria-label="交付进度">
        {milestones.map((milestone, index) => (
          <div key={milestone.label} className={`flow-stepper-item${milestone.done ? ' is-done' : ''}`}>
            <span className="flow-stepper-dot">{index + 1}</span>
            <span>{milestone.label}</span>
          </div>
        ))}
      </div>
      <div className="flow-sequence-head">
        <div>
          <h2>{item.relatedTickets.length === 1 ? item.relatedTickets[0]!.title : item.focus.id.startsWith('paseo-') ? '一次会话的完整交付顺序' : '多个关联 Ticket 的交付顺序'}</h2>
          <p className="flow-note">
            从上到下就是实际发生的顺序。{item.summary.ticketOutcome !== 'open' && item.summary.ticketOutcome !== 'none' ? `最终结果：${item.summary.ticketOutcome}。` : ''}
            回复状态：{item.summary.replyDelivery}（不代表已读）。
          </p>
        </div>
        <label className="flow-toggle">
          <input type="checkbox" checked={showTechnical} onChange={event => setShowTechnical(event.target.checked)} />
          显示技术凭证
        </label>
      </div>
      <div className="flow-seq" role="list" aria-label="按角色和时间的交付顺序">
        <div className="flow-seq-header" aria-hidden>
          <span className="flow-seq-corner">时间</span>
          <span className="flow-seq-stepcol">#</span>
          {LANE_LABELS.map(label => <span key={label} className="flow-seq-lanehead">{label}</span>)}
        </div>
        {steps.map(({ entry }, index) => {
          const lane = laneOf(entry)
          const previousLane = index > 0 ? laneOf(steps[index - 1]!.entry) : lane
          const from = Math.min(previousLane, lane) + 3
          const to = Math.max(previousLane, lane) + 4
          const direction = lane >= previousLane ? 'right' : 'left'
          return (
            <div key={entry.id} className={`flow-seq-row flow-seq-row-${entry.category}`} role="listitem" data-lane={lane}>
              <span className="flow-seq-time" title={entry.at ?? '无记录时间'}>
                {entry.at ? new Date(entry.at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--'}
              </span>
              <span className="flow-seq-number">{index + 1}</span>
              {index > 0 && lane !== previousLane ? (
                <span className={`flow-seq-link flow-seq-link-${direction}`} style={{ gridColumn: `${from} / ${to}` }} aria-hidden />
              ) : null}
              <button type="button"
                className={`flow-step-card flow-lane-${lane}${selection?.type === 'timeline' && selection.entry.id === entry.id ? ' is-active' : ''}`}
                style={{ gridColumn: lane + 3 }}
                onClick={() => onSelect(entry)}>
                <div className="flow-step-top">
                  <span className="flow-phase">{PHASE_OF[entry.category]}</span>
                  <span className="flow-step-time">{entry.at ? new Date(entry.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '无记录时间'}</span>
                  <span className={`flow-badge flow-badge-${entry.status}`}>{entry.status}</span>
                  {entry.confirmation === 'unconfirmed' ? <span className="flow-warn">未确认</span> : null}
                </div>
                <div className="flow-step-title">{entry.title}</div>
                <div className="flow-step-summary">{entry.summary}</div>
                {entry.timestampNote && entry.timestampNote !== 'exact' ? <div className="flow-step-note">{entry.timestampNote === 'timestamp_not_recorded' ? '该记录没有接收时间，按序号排序' : '时间来自本地会话索引'}</div> : null}
              </button>
            </div>
          )
        })}
      </div>
      {item.unknowns.length ? (
        <div className="flow-sequence-unknowns">
          <h3>口径说明</h3>
          {item.unknowns.map(note => (
            <button type="button" key={note.code} onClick={() => onSelect({ id: `unknown:${note.code}`, order: 0, category: 'intent', title: note.title, summary: note.detail, status: 'note', at: null, nodeIds: [], edgeIds: [], evidence: { code: note.code, detail: note.detail } })}>
              <b>{note.title}</b> {note.detail}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function FlowCanvasApp({ loadOverview, loadItem, pollMs = 2_000 }: FlowCanvasAppProps) {
  injectStyles()
  const [overview, setOverview] = useState<FlowOverviewResponse>()
  const [filter, setFilter] = useState<FlowListFilter>('all')
  const [view, setView] = useState<'sequence' | 'graph'>('sequence')
  const [listMode, setListMode] = useState<'conversations' | 'all'>('conversations')
  const [query, setQuery] = useState('')
  const [selectedItem, setSelectedItem] = useState<{ kind: 'ticket' | 'request'; id: string }>()
  const [item, setItem] = useState<FlowItemView>()
  const [selection, setSelection] = useState<Selection>()
  const [expanded, setExpanded] = useState(false)
  const [replayStep, setReplayStep] = useState<number | null>(null)
  const [error, setError] = useState<string>()
  const [transcript, setTranscript] = useState<{ status: string; reason?: string; note?: string; entries?: { id: string; role: string; text: string }[] }>()
  const [loading, setLoading] = useState(false)
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    try {
      const next = await loadOverview(0, filter, query || undefined)
      setOverview(next)
      setError(undefined)
      setSelectedItem(current => {
        if (current) return current
        const first = next.items.find(entry => entry.kind === 'request') ?? next.items[0]
        return first ? { kind: first.kind, id: first.id } : undefined
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [filter, loadOverview, query])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!selection) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelection(undefined) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [selection])

  useEffect(() => {
    if (!selectedItem) { setItem(undefined); return }
    let cancelled = false
    const load = async () => {
      const generation = ++requestId.current
      setLoading(true)
      try {
        const next = await loadItem(selectedItem.kind, selectedItem.id)
        if (!cancelled && generation === requestId.current) { setItem(next); setError(undefined) }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      } finally { if (!cancelled) setLoading(false) }
    }
    void load()
    if (!pollMs) return () => { cancelled = true }
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => {
      timer ??= setInterval(() => {
        if (document.visibilityState === 'hidden') return
        void load().then(() => { /* kept: stable polling */ })
      }, pollMs)
    }
    const visibility = () => { if (document.visibilityState === 'hidden') { clearInterval(timer); timer = undefined } else start() }
    document.addEventListener('visibilitychange', visibility)
    start()
    return () => { cancelled = true; document.removeEventListener('visibilitychange', visibility); if (timer) clearInterval(timer) }
  }, [loadItem, pollMs, selectedItem])

  const highlighted = selection?.type === 'timeline' ? selection.entry : undefined
  const selectedNodeId = selection?.type === 'node' ? selection.node.id
    : highlighted?.nodeIds[0] ?? undefined
  const selectedEdgeId = selection?.type === 'edge' ? selection.edge.id
    : highlighted?.edgeIds[0] ?? undefined

  const onSelectNode = useCallback((node: FlowCanvasNode) => setSelection({ type: 'node', node }), [])
  const nodes = useMemo(() => item ? toNodes(item, expanded, selectedNodeId, onSelectNode, replayStep !== null) : [], [item, expanded, selectedNodeId, onSelectNode, replayStep])
  const edges = useMemo(() => item ? toEdges(item, expanded, selectedEdgeId, replayStep !== null) : [], [item, expanded, selectedEdgeId, replayStep])
  const hiddenHistory = item?.nodes.find(node => node.kind === 'assignment-history')

  const replayFrames = useMemo(() => {
    if (!item) return []
    const entries = item.timeline.filter(entry => entry.category !== 'intent')
    const firstNode = new Map<string, number>()
    const firstEdge = new Map<string, number>()
    entries.forEach((entry, index) => {
      for (const id of entry.nodeIds) if (!firstNode.has(id)) firstNode.set(id, index)
      for (const id of entry.edgeIds) if (!firstEdge.has(id)) firstEdge.set(id, index)
    })
    for (const node of item.nodes) if (!firstNode.has(node.id)) firstNode.set(node.id, 0)
    for (const edge of item.edges) {
      if (firstEdge.has(edge.id)) continue
      firstEdge.set(edge.id, Math.max(firstNode.get(edge.source) ?? 0, firstNode.get(edge.target) ?? 0))
    }
    return entries.map((entry, index) => ({
      entry,
      nodes: new Set([...firstNode].filter(([, at]) => at <= index).map(([id]) => id)),
      edges: new Set([...firstEdge].filter(([, at]) => at <= index).map(([id]) => id)),
    }))
  }, [item])
  const replayFrame = replayStep === null ? undefined : replayFrames[replayStep]
  const graphNodes = useMemo(() => replayFrame ? nodes.filter(node => replayFrame.nodes.has(node.id)) : nodes, [nodes, replayFrame])
  const graphEdges = useMemo(() => replayFrame
    ? edges.filter(edge => replayFrame.edges.has(edge.id) && replayFrame.nodes.has(edge.source) && replayFrame.nodes.has(edge.target))
    : edges, [edges, replayFrame])

  const choose = async (entry: FlowOverviewItem) => {
    setSelectedItem({ kind: entry.kind, id: entry.id })
    setSelection(undefined)
    setExpanded(false)
    setReplayStep(null)
    setTranscript(undefined)
  }

  const askTranscript = async (sessionKey: string) => {
    setTranscript({ status: 'unavailable', reason: 'loading' })
    try {
      const response = await fetch(`/api/flow/transcript/${encodeURIComponent(sessionKey)}`, { headers: authHeaders() })
      setTranscript(await response.json())
    } catch (cause) {
      setTranscript({ status: 'unavailable', reason: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  const requestTicketIds = new Set((overview?.items ?? []).filter(entry => entry.kind === 'request').flatMap(entry => entry.ticketIds))
  const visibleItems = (overview?.items ?? []).filter(entry => listMode === 'all' || entry.kind === 'request' || !requestTicketIds.has(entry.id))

  return (
    <div className="flow-shell">
      <header className="flow-topbar">
        <strong>Superagent 交付视图</strong>
        <span className={`flow-host flow-host-${overview?.host.phase ?? 'unknown'}`}>
          {overview?.host.phase ?? '…'}{overview?.host.detail ? ` · ${overview.host.detail}` : ''}
        </span>
        <div className="flow-view-switch" role="tablist" aria-label="视图">
          <button type="button" role="tab" aria-selected={view === 'sequence'} className={view === 'sequence' ? 'is-active' : ''} onClick={() => setView('sequence')}>交付时序</button>
          <button type="button" role="tab" aria-selected={view === 'graph'} className={view === 'graph' ? 'is-active' : ''} onClick={() => setView('graph')}>关系画布</button>
        </div>
        <input aria-label="搜索" placeholder="搜索会话" value={query} onChange={event => setQuery(event.target.value)} />
        <button type="button" onClick={() => void refresh()}>刷新</button>
        {loading ? <span className="flow-note">读取中…</span> : null}
      </header>
      {error ? <p className="flow-error" role="alert">{error}</p> : null}
      <div className="flow-body">
        <nav className="flow-list" aria-label="会话列表">
          <div className="flow-list-mode">
            <button type="button" className={listMode === 'conversations' ? 'is-active' : ''} onClick={() => setListMode('conversations')}>按会话</button>
            <button type="button" className={listMode === 'all' ? 'is-active' : ''} onClick={() => setListMode('all')}>全部记录</button>
          </div>
          <div className="flow-filters">
            {FILTERS.map(entry => <button type="button" key={entry.id} className={entry.id === filter ? 'is-active' : ''}
              onClick={() => setFilter(entry.id)}>{entry.label}</button>)}
          </div>
          {visibleItems.map(entry => (
            <button type="button" key={`${entry.kind}:${entry.id}`}
              className={`flow-item${selectedItem?.kind === entry.kind && selectedItem.id === entry.id ? ' is-selected' : ''}`}
              aria-selected={selectedItem?.kind === entry.kind && selectedItem.id === entry.id}
              onClick={() => void choose(entry)}>
              <span className="flow-item-kind">{entry.kind === 'ticket' ? '历史任务' : '会话'}</span>
              <span className="flow-item-title">{entry.title}</span>
              <span className="flow-item-sub">{entry.subtitle}</span>
              <span className="flow-item-meta">{entry.status}{entry.ticketIds.length > 1 ? ` · 扇出 ${entry.ticketIds.length}` : ''}</span>
            </button>
          ))}
          {overview && visibleItems.length === 0 ? <p className="flow-note">暂无记录。</p> : null}
        </nav>
        <main className="flow-main">
          {!item ? <p className="flow-note">选择左侧会话。</p> : view === 'sequence' ? (
            <DeliveryTimeline item={item} selection={selection} onSelect={entry => setSelection({ type: 'timeline', entry })} />
          ) : (
            <div className={`flow-canvas${replayFrame ? ' is-replay' : ''}`}>
              <div className="flow-replay-bar">
                {replayStep === null ? (
                  <button type="button" onClick={() => setReplayStep(0)}>▶ 重放</button>
                ) : (
                  <>
                    <button type="button" onClick={() => setReplayStep(value => Math.min((value ?? 0) + 1, replayFrames.length - 1))}
                      disabled={(replayStep ?? 0) >= replayFrames.length - 1}>下一步</button>
                    <span className="flow-replay-status">第 {(replayStep ?? 0) + 1} / {replayFrames.length} 步 · {replayFrames[replayStep]?.entry.title}</span>
                    <button type="button" onClick={() => setReplayStep(null)}>退出重放</button>
                  </>
                )}
              </div>
              <div className="flow-lanes">
                {(['superagent', 'orchestrator', 'worker'] as const).map(lane => <span key={lane} className={`flow-lane flow-lane-${lane}`}>{LANE_LABEL[lane]}</span>)}
              </div>
              {hiddenHistory ? (
                <button type="button" className="flow-unfold" onClick={() => setExpanded(value => !value)}>
                  {expanded ? '收起历史 Assignment' : `展开 ${hiddenHistory.data.hiddenAssignmentIds?.length ?? 0} earlier assignment(s)`}
                </button>
              ) : null}
              <ReactFlow nodes={graphNodes} edges={graphEdges} nodeTypes={nodeTypes} fitView proOptions={{ hideAttribution: true }}
                nodesDraggable={false} nodesConnectable={false} edgesFocusable={false} elementsSelectable={false}
                defaultEdgeOptions={{ type: 'smoothstep', style: { stroke: '#94a3b8', strokeWidth: 1.4 } }}
                onNodeClick={(_event, node) => onSelectNode((node.data as NodeData).source)}
                onPaneClick={() => setSelection(undefined)}>
                <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#d7dee8" />
                <Controls showInteractive={false} />
              </ReactFlow>
              {item.relatedTickets.length > 1 ? (
                <div className="flow-fanout">
                  <span>关联 Ticket：</span>
                  {item.relatedTickets.map(ticket => <button type="button" key={ticket.id} onClick={() => setSelectedItem({ kind: 'ticket', id: ticket.id })}>{ticket.title}</button>)}
                </div>
              ) : null}
            </div>
          )}
        </main>
      </div>
      {selection ? (
        <div className="flow-sheet-backdrop" onClick={() => setSelection(undefined)}>
          <div className="flow-sheet-wrap" onClick={event => event.stopPropagation()}>
            <Evidence selection={selection} onClose={() => setSelection(undefined)} onTranscript={key => void askTranscript(key)} transcript={transcript} />
          </div>
        </div>
      ) : null}
    </div>
  )
}

function authHeaders(): Record<string, string> {
  const token = typeof location !== 'undefined' ? new URLSearchParams(location.hash.slice(1)).get('token') ?? sessionStorage.getItem('flow-token') : null
  return token ? { authorization: `Bearer ${token}` } : {}
}

export async function fetchOverview(cursor = 0, filter: FlowListFilter = 'all', q?: string): Promise<FlowOverviewResponse> {
  const params = new URLSearchParams({ cursor: String(cursor), limit: '50', filter, ...(q ? { q } : {}) })
  const response = await fetch(`/api/flow/overview?${params}`, { headers: authHeaders() })
  if (!response.ok) throw new Error(`读取总览失败 (${response.status})`)
  return await response.json() as FlowOverviewResponse
}

export async function fetchItem(kind: 'ticket' | 'request', id: string): Promise<FlowItemView> {
  const response = await fetch(`/api/flow/items/${kind}/${encodeURIComponent(id)}`, { headers: authHeaders() })
  if (!response.ok) throw new Error(`读取流转失败 (${response.status})`)
  return await response.json() as FlowItemView
}
