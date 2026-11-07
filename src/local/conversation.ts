/** Conversation mapping and replay index. Domain records remain authoritative. */
import { randomBytes } from 'node:crypto'
import type { Store } from '../app/store.ts'
import { ticketCard } from '../app/cards.ts'
import { type OutboundMessage, type ReceiveResult } from '../core/index.ts'
import { KV } from '../kv.ts'
import { localTrigger, type LocalRequest } from '../sources/local.ts'
import { ConversationBinding, ConversationInput, conversationRequestId, conversationTextHash,
  type ConversationEvent, type ConversationPage, type ConversationReceipt, type ConversationReceiptView } from './protocol.ts'

export type ConversationIndex = { at: string } & ({ type: 'user'; requestId: string } | { type: 'assistant'; replyId: string })

/** Maps one Paseo conversation to Local Source requests and a durable replay index. */
export class LocalConversation {
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'atomic' | 'triggers' | 'tickets' | 'decisions'>) {}
  binding(): ConversationBinding | undefined { return this.store.get(KV.conversation.binding) }
  bind(): ConversationBinding {
    return this.store.atomic(() => {
      const existing = this.binding()
      if (existing) return existing
      const binding: ConversationBinding = { version: 1, hostId: randomBytes(16).toString('hex'), conversationId: randomBytes(16).toString('hex') }
      this.store.set(KV.conversation.binding, binding)
      return binding
    })
  }
  private bound(value?: ConversationBinding): ConversationBinding {
    const binding = this.binding()
    if (!binding) throw new Error('LOCAL_CONVERSATION_UNBOUND')
    if (value && (value.hostId !== binding.hostId || value.conversationId !== binding.conversationId || value.version !== binding.version))
      throw new Error('LOCAL_CONVERSATION_MISMATCH')
    return binding
  }
  receive(input: ConversationInput, receive: (request: LocalRequest) => ReceiveResult): ConversationReceiptView {
    const parsed = ConversationInput.parse(input), binding = this.bound(parsed.binding)
    const requestId = conversationRequestId(binding, parsed.clientMessageId)
    return this.store.atomic(() => {
      const previous = this.store.get(KV.conversation.receipt(requestId))
      if (previous) {
        const trigger = this.store.triggers.get(previous.triggerId)
        if (!trigger || trigger.text !== parsed.text || previous.clientMessageId !== parsed.clientMessageId) throw new Error('LOCAL_REQUEST_CONFLICT')
        return { ...this.receipt(requestId)!, result: 'duplicate' }
      }
      const trigger = localTrigger({ requestId, threadId: requestId, text: parsed.text })
      const seq = this.append({ type: 'user', requestId, at: trigger.at })
      // Mapping is committed atomically with admission, so even synchronous replies can find their conversation.
      this.store.set(KV.conversation.channel(trigger.channel!.thread), requestId)
      this.store.set(KV.conversation.trigger(trigger.id), requestId)
      const result = receive({ requestId, threadId: requestId, text: parsed.text })
      const receipt: ConversationReceipt = { requestId, triggerId: trigger.id, clientMessageId: parsed.clientMessageId,
        textHash: conversationTextHash(parsed.text), seq, at: trigger.at, result }
      this.store.set(KV.conversation.receipt(requestId), receipt)
      return this.receipt(requestId)!
    })
  }
  receipt(requestId: string): ConversationReceiptView | undefined {
    const receipt = this.store.get(KV.conversation.receipt(requestId))
    if (!receipt) return undefined
    const disposition = this.store.triggers.disposition(receipt.triggerId)
    const decision = disposition?.decisionId ? this.store.decisions.get(disposition.decisionId) : undefined
    const reason = disposition?.filtered ?? decision?.reason[0]
    const ticketId = decision?.ticketId ?? disposition?.fanout[0]
    const rejected = !!disposition?.filtered || decision?.kind === 'unavailable'
    return { ...receipt, routing: rejected ? 'rejected' : ticketId ? 'routed' : decision ? 'ignored' : 'pending',
      ...(reason ? { reason: typeof reason === 'string' ? reason : reason.code } : {}), ...(ticketId ? { ticketId } : {}) }
  }
  /** Called inside the same Local Channel transaction that saves the immutable reply. */
  recordReply(message: OutboundMessage): void {
    if (!this.store.get(KV.conversation.channel(message.channel.thread))) return
    if (this.store.get(KV.conversation.reply(message.id)) !== undefined) return
    const seq = this.append({ type: 'assistant', replyId: message.id, at: new Date().toISOString() })
    this.store.set(KV.conversation.reply(message.id), seq)
  }
  private append(event: ConversationIndex): number {
    const seq = (this.store.get(KV.conversation.seq) ?? 0) + 1
    this.store.set(KV.conversation.event(seq), event)
    this.store.set(KV.conversation.seq, seq)
    return seq
  }
  events(after = 0, through = this.store.get(KV.conversation.seq) ?? 0, limit = 100): ConversationPage {
    const binding = this.bound(), highWater = this.store.get(KV.conversation.seq) ?? 0
    if (![after, through, limit].every(Number.isSafeInteger) || after < 0 || through < after || through > highWater || limit < 1 || limit > 100)
      throw new Error('LOCAL_CONVERSATION_CURSOR')
    const items: ConversationEvent[] = []
    let bytes = 0, cursor = after
    while (cursor < through && items.length < limit) {
      const seq = cursor + 1, ref = this.store.get(KV.conversation.event(seq))
      if (!ref) throw new Error('LOCAL_CONVERSATION_GAP')
      let item: ConversationEvent
      if (ref.type === 'user') {
        const receipt = this.store.get(KV.conversation.receipt(ref.requestId))
        const trigger = receipt && this.store.triggers.get(receipt.triggerId)
        if (!receipt || !trigger) throw new Error('LOCAL_CONVERSATION_GAP')
        item = { seq, id: `user:${trigger.id}`, type: 'user', text: trigger.text, at: ref.at,
          clientMessageId: receipt.clientMessageId, triggerId: trigger.id }
      } else {
        const reply = this.store.get(KV.local.reply(ref.replyId))
        if (!reply) throw new Error('LOCAL_CONVERSATION_GAP')
        item = { seq, id: `reply:${reply.id}`, type: 'assistant', text: reply.text, at: ref.at,
          ...(reply.ticketId ? { ticketId: reply.ticketId } : {}) }
      }
      const size = Buffer.byteLength(JSON.stringify(item))
      if (bytes + size > 500_000) break
      items.push(item); bytes += size; cursor = seq
    }
    if (cursor < through && !items.length) throw new Error('LOCAL_CONVERSATION_EVENT_TOO_LARGE')
    return { binding, items, nextCursor: cursor, highWater: through, hasMore: cursor < through }
  }
  context(triggerId: string) {
    const requestId = this.store.get(KV.conversation.trigger(triggerId))
    const receipt = requestId && this.store.get(KV.conversation.receipt(requestId))
    if (!receipt) return undefined
    const binding = this.bound()
    return { conversation_id: binding.conversationId, through: receipt.seq,
      read: `conversation/${binding.conversationId}/through/${receipt.seq}`, ...this.tickets(receipt.seq) }
  }
  tickets(through: number) {
    const ids = new Set<string>()
    // Bound candidate enrichment; the full conversation stays paginated behind its read resource.
    for (let seq = through; seq > Math.max(0, through - 100); seq--) {
      const ref = this.store.get(KV.conversation.event(seq))
      if (ref?.type !== 'user') continue
      const receipt = this.receipt(ref.requestId)
      if (receipt?.ticketId) ids.add(receipt.ticketId)
    }
    return { recent_tickets: [...ids].slice(0, 8).flatMap(id => { const ticket = this.store.tickets.get(id); return ticket ? [ticketCard(ticket)] : [] }) }
  }
}
