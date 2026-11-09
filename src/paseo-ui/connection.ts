/** Provider lifecycle, short input turns, and asynchronous reply replay. */
import type { ProviderConnection, ProviderEvent, ProviderInput, ProviderTimelineItem } from '@getpaseo/plugin/server/provider'
import { ConversationBinding, ConversationInput, conversationRequestId, conversationTextHash,
  type ConversationEvent, type ConversationReceiptView } from '../local/protocol.ts'
import type { ConversationTransport } from './transport.ts'
import type { PendingInputs } from './pending.ts'
import type { HostStatus } from '../hosts/lifecycle.ts'
import { ProjectPersistenceSchema } from './project-persistence.ts'

interface Session {
  id: string; binding: ConversationBinding; cursor: number; closed: boolean; timer?: ReturnType<typeof setTimeout>
  tail: Promise<void>; emitted: Set<string>; receipts: Set<string>; pendingPrompts: Set<string>; interrupted: Set<string>; delay: number
  turns: { turnId: string; clientMessageId: string; startSeq: number }[]
}
export interface ConnectionOptions {
  capabilities: readonly string[]; transport: ConversationTransport; pending: PendingInputs; pollMs?: number
  hostStatus?: () => HostStatus
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const sameBinding = (left: ConversationBinding, right: ConversationBinding) => {
  if (left.hostId !== right.hostId || left.conversationId !== right.conversationId || left.version !== right.version)
    throw new Error('LOCAL_CONVERSATION_MISMATCH')
}
const fatal = (error: unknown) => /LOCAL_(CONVERSATION_(MISMATCH|GAP|CURSOR|EVENT_TOO_LARGE)|REQUEST_CONFLICT|UNSAFE)/.test(message(error))
const rejected = (error: unknown) => /^(LOCAL_(SOURCE_DISABLED|INVALID_REQUEST|REQUEST_TOO_LARGE|REQUEST_CONFLICT|CONVERSATION_(UNBOUND|MISMATCH)))$/.test(message(error))

export function createConversationConnection(options: ConnectionOptions): ProviderConnection {
  const { transport, pending, capabilities } = options, pollMs = options.pollMs ?? 1000
  const listeners = new Set<(event: ProviderEvent) => void>(), sessions = new Map<string, Session>()
  let closed = false
  const available = () => {
    const status = options.hostStatus?.()
    if (!status || status.phase === 'ready') return
    const text = { starting: 'Superagent 正在启动，请稍后重试', needs_setup: 'Superagent 需要完成配置',
      stopping: 'Superagent 正在停止', stopped: 'Superagent 已停止，请重载插件', error: 'Superagent 启动失败' }
    throw new Error(text[status.phase] + (status.detail ? '：' + status.detail : ''))
  }
  const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event) }
  const item = (session: Session, row: ProviderTimelineItem, at?: string) => {
    if (session.closed || session.emitted.has(row.id)) return false
    emit({ type: 'timeline.item', sessionId: session.id, item: row, ...(at ? { timestamp: at } : {}) })
    session.emitted.add(row.id)
    return true
  }
  const show = (session: Session, event: ConversationEvent) => {
    const shown = item(session, event.type === 'user'
      ? { type: 'user_message', id: event.id, text: event.text, clientMessageId: event.clientMessageId }
      : event.type === 'status'
        ? { type: 'notification', id: event.id, level: event.level ?? 'info', message: event.text }
        : { type: 'assistant_message', id: event.id, text: event.text }, event.at)
    if (shown && event.type === 'assistant') {
      const turn = session.turns.find(candidate => candidate.startSeq < event.seq)
      if (turn) finishTurn(session, turn.turnId, 'completed')
    }
  }
  const notice = (session: Session, id: string, text: string, severity: 'info' | 'warning' | 'error' = 'warning') => {
    emit({ type: 'session.notice', sessionId: session.id, notice: { id, severity, title: text } })
  }
  const requestFailed = (requestId: string, error: unknown) => emit({ type: 'request.failed', requestId, error: { message: message(error) } })
  const result = (session: Session, clientMessageId: string, error?: unknown) => {
    if (!session.pendingPrompts.delete(clientMessageId) || session.closed) return
    emit({ type: 'session.prompt_result', sessionId: session.id, clientMessageId,
      result: error ? { type: 'failed', error: { message: message(error) } } : { type: 'completed' } })
  }
  const startTurn = (session: Session, clientMessageId: string, startSeq: number) => {
    if (!session.pendingPrompts.delete(clientMessageId) || session.closed) return
    const turnId = 'turn-' + clientMessageId
    session.turns.push({ turnId, clientMessageId, startSeq })
    emit({ type: 'session.prompt_result', sessionId: session.id, clientMessageId, result: { type: 'turn', turnId } })
    emit({ type: 'session.turn', sessionId: session.id, turnId, state: 'started' })
  }
  const finishTurn = (session: Session, turnId: string, state: 'completed' | 'failed' | 'canceled', error?: unknown) => {
    const index = session.turns.findIndex(turn => turn.turnId === turnId)
    if (index < 0 || session.closed) return
    session.turns.splice(index, 1)
    emit({ type: 'session.turn', sessionId: session.id, turnId, state, ...(error ? { error: { message: message(error) } } : {}) })
  }
  const finishClientTurn = (session: Session, clientMessageId: string, state: 'completed' | 'failed' | 'canceled', error?: unknown) => {
    const turn = session.turns.find(candidate => candidate.clientMessageId === clientMessageId)
    if (turn) finishTurn(session, turn.turnId, state, error)
  }
  const receipt = (session: Session, input: ConversationInput, value: ConversationReceiptView) => {
    const id = conversationRequestId(session.binding, input.clientMessageId)
    if (value.requestId !== id || value.clientMessageId !== input.clientMessageId || value.textHash !== conversationTextHash(input.text))
      throw new Error('LOCAL_REQUEST_CONFLICT')
    item(session, { type: 'user_message', id: `user:${value.triggerId}`, text: input.text, clientMessageId: input.clientMessageId }, value.at)
    if (value.routing === 'rejected') {
      notice(session, id, '请求未接单：' + (value.reason ?? '入口策略拒绝'), 'error')
      result(session, input.clientMessageId, new Error('请求未接单：' + (value.reason ?? '入口策略拒绝')))
    } else if (value.routing === 'ignored') {
      notice(session, id, '请求已被忽略：' + (value.reason ?? '未匹配任何任务'), 'warning')
      result(session, input.clientMessageId)
    } else {
      if (value.routing === 'pending') session.receipts.add(id)
      else session.receipts.delete(id)
      startTurn(session, input.clientMessageId, value.seq)
    }
    pending.remove(input)
  }
  const reconcile = async (session: Session, input: ConversationInput) => {
    const id = conversationRequestId(session.binding, input.clientMessageId), found = await transport.receipt(id)
    sameBinding(session.binding, found.binding)
    const value = found.receipt ?? await transport.submit(input)
    receipt(session, input, value)
  }
  const readEvents = async (session: Session, replay: boolean) => {
    let through: number | undefined
    // Fixed high-water mark makes replay terminate even while the Host receives new inputs.
    do {
      const page = await transport.events(session.cursor, through)
      sameBinding(session.binding, page.binding)
      through ??= page.highWater
      if (page.highWater !== through || page.nextCursor < session.cursor || page.nextCursor > through ||
        page.items.some((event, index) => event.seq !== session.cursor + index + 1) ||
        page.nextCursor !== session.cursor + page.items.length || page.hasMore !== (page.nextCursor < through))
        throw new Error('LOCAL_CONVERSATION_GAP')
      for (const event of page.items) {
        show(session, event)
        if (event.type === 'user' && event.clientMessageId) session.receipts.add(conversationRequestId(session.binding, event.clientMessageId))
      }
      session.cursor = page.nextCursor
      if (!page.hasMore) break
      if (!page.items.length) throw new Error('LOCAL_CONVERSATION_GAP')
      if (!replay) break // Live backlog drains one bounded page per pass.
    } while (!closed && !session.closed)
  }
  const enqueue = (session: Session, work: () => Promise<void>) => {
    const next = session.tail.then(async () => { if (!closed && !session.closed) await work() })
    session.tail = next.catch(() => {})
    return next
  }
  const schedule = (session: Session) => {
    if (closed || session.closed) return
    session.timer = setTimeout(() => {
      void enqueue(session, async () => {
        try {
          for (const input of pending.list(session.binding)) {
            try { await reconcile(session, input) } catch (error) {
              if (rejected(error)) { pending.remove(input); notice(session, conversationRequestId(session.binding, input.clientMessageId), '请求未接单：' + message(error), 'error') }
              if (fatal(error)) throw error
            }
          }
          await readEvents(session, false)
          for (const id of [...session.receipts].slice(0, 20)) {
            const found = await transport.receipt(id); sameBinding(session.binding, found.binding)
            if (!found.receipt) throw new Error('LOCAL_CONVERSATION_GAP')
            if (found.receipt.routing === 'rejected') {
              notice(session, id, '请求未接单：' + (found.receipt.reason ?? '入口策略拒绝'), 'error')
              finishClientTurn(session, found.receipt.clientMessageId, 'failed', new Error('请求未接单：' + (found.receipt.reason ?? '入口策略拒绝')))
            }
            if (found.receipt.routing === 'ignored') {
              notice(session, id, '请求已被忽略：' + (found.receipt.reason ?? '未匹配任何任务'), 'warning')
              finishClientTurn(session, found.receipt.clientMessageId, 'completed')
            }
            if (found.receipt.routing !== 'pending') session.receipts.delete(id)
          }
          session.delay = pollMs
          emit({ type: 'session.notice', sessionId: session.id, notice: { id: 'connection', severity: 'warning', title: '连接已恢复', dismissed: true } })
        } catch (error) {
          notice(session, 'connection', '暂时无法读取 Superagent：' + message(error), fatal(error) ? 'error' : 'warning')
          if (fatal(error)) { session.closed = true; return }
          session.delay = Math.min(30_000, session.delay * 2)
        }
      }).finally(() => schedule(session))
    }, session.delay)
    session.timer.unref?.()
  }
  const open = async (input: Extract<ProviderInput, { type: 'session.open' }>) => {
    available()
    if (sessions.has(input.sessionId)) throw new Error('Session already open')
    const persistence = input.persistence?.version === 2
      ? { version: 1, data: ProjectPersistenceSchema.parse(input.persistence).data.binding } : input.persistence
    const restored = persistence ? ConversationBinding.parse(persistence.data) : undefined
    if (restored && (persistence!.version !== 1 || input.history !== 'replay')) throw new Error('Unsupported conversation restoration')
    const binding = await transport.binding(!restored)
    if (restored) sameBinding(restored, binding)
    if (closed) return
    const session: Session = { id: input.sessionId, binding, cursor: 0, closed: false, tail: Promise.resolve(), emitted: new Set(),
      receipts: new Set(), pendingPrompts: new Set(), interrupted: new Set(), delay: pollMs, turns: [] }
    sessions.set(session.id, session)
    try {
    emit({ type: 'session.opened', requestId: input.requestId, sessionId: session.id, capabilities: [...capabilities], restoration: 'core',
      persistence: { version: 1, data: { ...binding } }, cwd: input.config.cwd, title: input.config.title })
    emit({ type: 'session.config', sessionId: session.id, config: { models: [], modes: [], thinkingOptions: [], settings: [] } })
    if (input.history === 'replay') await readEvents(session, true)
    else {
      // A second window joins the existing conversation; a first open must not silently skip its history.
      const page = await transport.events(0, undefined)
      sameBinding(binding, page.binding)
      if (page.highWater) await readEvents(session, true)
    }
    emit({ type: 'session.ready', requestId: input.requestId, sessionId: session.id })
    schedule(session)
    } catch (error) { session.closed = true; sessions.delete(session.id); throw error }
  }
  const prompt = async (session: Session, input: Extract<ProviderInput, { type: 'session.prompt' }>) => {
    const p = input.prompt
    if (session.pendingPrompts.has(p.clientMessageId)) throw new Error('Prompt is already pending')
    session.pendingPrompts.add(p.clientMessageId)
    return enqueue(session, async () => {
      try {
        available()
        if (session.interrupted.delete(p.clientMessageId)) throw new Error('输入等待已中断，任务状态以接收记录为准')
        if (p.delivery !== 'auto' || p.input.type !== 'message' || p.outputSchema !== undefined || p.input.content.some(part => part.type !== 'text'))
          throw new Error('Superagent currently accepts plain text messages only')
        const value = ConversationInput.parse({ binding: session.binding, clientMessageId: p.clientMessageId,
          text: p.input.content.map(part => part.type === 'text' ? part.text : '').join('\n') })
        pending.put(value)
        try { receipt(session, value, await transport.submit(value)) }
        catch (error) {
          if (fatal(error) || rejected(error)) { pending.remove(value); throw error }
          try { await reconcile(session, value) } catch (failure) {
            if (fatal(failure) || rejected(failure)) { pending.remove(value); throw failure }
            notice(session, conversationRequestId(session.binding, p.clientMessageId), '接收结果待确认，连接恢复后使用原请求身份对账。')
            throw failure
          }
        }
      } catch (error) { result(session, p.clientMessageId, error) }
    })
  }
  return { version: 1, capabilities: [...capabilities], onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async send(input) {
      if (closed) throw new Error('Provider closed')
      try {
        if (input.type === 'catalog') { emit({ type: 'catalog', requestId: input.requestId, catalog: { models: [], modes: [] } }); return }
        if (input.type === 'session.open') { await open(input); return }
        if (!('sessionId' in input)) throw new Error('Unsupported provider operation')
        const session = sessions.get(input.sessionId)
        if (!session || session.closed) throw new Error('Unknown or closed conversation')
        if (input.type === 'session.prompt') { await prompt(session, input); return }
        if (input.type === 'session.can_stop_runtime') {
          emit({ type: 'session.can_stop_runtime', requestId: input.requestId, sessionId: session.id, canStop: false }); return
        }
        if (input.type === 'session.interrupt') {
          for (const turn of session.turns.splice(0)) emit({ type: 'session.turn', sessionId: session.id, turnId: turn.turnId, state: 'canceled' })
          for (const id of session.pendingPrompts) { session.interrupted.add(id); result(session, id, new Error('输入等待已中断，任务状态以接收记录为准')) }
          emit({ type: 'request.completed', requestId: input.requestId }); return
        }
        if (input.type === 'session.close') {
          for (const id of session.pendingPrompts) result(session, id, new Error('Conversation closed; submitted requests may still run'))
          session.closed = true; clearTimeout(session.timer); sessions.delete(session.id)
          emit({ type: 'session.closed', sessionId: session.id }); return
        }
        throw new Error('Unsupported provider operation')
      } catch (error) {
        if ('requestId' in input) requestFailed(input.requestId, error)
        else if (input.type === 'session.prompt') emit({ type: 'session.prompt_result', sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId, result: { type: 'failed', error: { message: message(error) } } })
      }
    },
    async close() { closed = true; for (const session of sessions.values()) { session.closed = true; clearTimeout(session.timer) }; sessions.clear(); listeners.clear() },
  }
}
