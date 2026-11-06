/**
 * Disabled-by-default local Source/Channel using the official Engine and Outbox.
 *
 * Runtime's opt-in Unix socket is restricted to the local OS account. Only trusted operator entry
 * points may call these functions; they are not an authentication boundary.
 * A process UID or a request body's claimed identity alone does not authenticate a remote caller or
 * prove that a human initiated the request. The caller is a trusted component of the host process.
 */
import { getuid } from 'node:process'
import { z } from 'zod'
import { key, type OutboundMessage, type ReceiveResult, type Trigger } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { KV } from '../kv.ts'
import type { SourceKind } from './kind.ts'

const LocalConfig = z.object({ acceptRequests: z.boolean().default(false) }).strict()
const LocalPolicy = z.object({ allowed: z.array(z.object({ id: z.string().regex(/^uid:[0-9]+$/) }).strict()).default([]) }).strict()
const Request = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  threadId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional(),
  text: z.string().trim().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 65_536, 'Request too large'),
}).strict()
export type LocalRequest = z.input<typeof Request>

/** Register explicitly; absent configuration remains closed even when SourceRegistry defaults instances on. */
export const localKind: SourceKind<z.infer<typeof LocalConfig>> = {
  kind: 'local',
  title: { zh: '本机请求', en: 'Local requests' },
  description: { zh: '由可信的本机入口显式提交的请求。', en: 'Requests explicitly submitted by a trusted local entry point.' },
  schema: LocalConfig,
  fields: [{ key: 'acceptRequests', type: 'switch', label: { zh: '接收本机请求', en: 'Receive local requests' } }],
  health: [],
  scope: (_input, config) => config.acceptRequests ? { listened: true, observed: false } : { listened: false, reason: 'source_disabled' },
  policy: {
    schema: LocalPolicy,
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '允许发起工作的本机用户 ID', en: 'Local user IDs allowed to originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' }, pattern: 'uid:[0-9]+' }] }],
    explicit: { zh: '允许名单中的本机用户通过经过认证的入口明确发出请求。', en: 'An allowed local user explicitly submits through an authenticated entry point.' },
  },
}

/**
 * Map an already authenticated and explicitly submitted local request to the official Trigger model.
 * This function is NOT an authentication boundary. The trusted in-process caller must authenticate the
 * actual requester as the same local OS account and know the request was intentionally submitted by
 * that person. Runtime's private Unix socket is one such entry point; do not expose it over TCP.
 * The request may not supply its own identity. Engine.receive must still apply scope and Policy gate.
 * Engine.receive deduplicates by ID without comparing content; use createLocalSource.receive to
 * reject conflicting replays atomically. Neither function authenticates a transport caller.
 */
export function localTrigger(request: LocalRequest, at = new Date().toISOString()): Trigger {
  const parsed = Request.parse(request)
  if (typeof getuid !== 'function') throw new Error('LOCAL_UID_UNAVAILABLE')
  const actorId = `uid:${getuid()}`
  const thread = key('local-thread', actorId, parsed.threadId ?? parsed.requestId)
  return { id: key('local', actorId, parsed.requestId), source: 'local',
    threads: [{ source: 'local', id: thread }],
    channel: { source: 'local', thread: `local:${thread}`, address: { actorId, thread } },
    actor: { source: 'local', id: actorId }, human: true, addressed: 'direct', at, text: parsed.text,
    meta: { requestId: parsed.requestId, origin: 'local-request' } }
}

/** Store-backed Source/Channel adapter for an authenticated, trusted in-process caller. No transport is opened. */
export function createLocalSource(store: Pick<Store, 'atomic' | 'get' | 'set' | 'triggers'>) {
  const sameMessage = (left: OutboundMessage, right: OutboundMessage) => left.id === right.id && left.text === right.text &&
    left.kind === right.kind && left.ticketId === right.ticketId && left.channel.source === right.channel.source &&
    left.channel.thread === right.channel.thread && left.channel.address.actorId === right.channel.address.actorId &&
    left.channel.address.thread === right.channel.address.thread
  const validAddress = (message: OutboundMessage) => message.channel.source === 'local' &&
    message.channel.address.actorId === `uid:${getuid?.()}` &&
    /^[a-f0-9]{32}$/.test(message.channel.address.thread ?? '') && message.channel.thread === `local:${message.channel.address.thread}`
  const kind: SourceKind<z.infer<typeof LocalConfig>> = {
    ...localKind,
    channel: {
      allowed: (_address, config) => config.acceptRequests,
      link: () => ({ url: '', label: { zh: '本机请求', en: 'Local request' } }),
      send: async (_host, message) => {
        if (!validAddress(message)) throw new Error('INVALID_LOCAL_CHANNEL')
        store.atomic(() => {
          const name = KV.local.reply(message.id)
          const previous = store.get(name)
          if (previous && !sameMessage(previous, message)) throw new Error('LOCAL_REPLY_CONFLICT')
          if (!previous) {
            // Outbox passes a receipt structurally extending OutboundMessage; do not persist its pre-send status.
            const { id, channel, text, kind, ticketId } = message
            store.set(name, { id, channel, text, kind, ...(ticketId ? { ticketId } : {}) })
            const index = KV.local.threadReplies(message.channel.thread)
            store.set(index, [...store.get(index) ?? [], message.id])
          }
        })
        return 'sent'
      },
    },
  }
  return {
    kind,
    receive(request: LocalRequest, receive: (trigger: Trigger) => ReceiveResult, at?: string): ReceiveResult {
      const trigger = localTrigger(request, at)
      return store.atomic(() => {
        const previous = store.triggers.get(trigger.id)
        if (previous && (previous.source !== trigger.source || previous.actor.id !== trigger.actor.id ||
          previous.text !== trigger.text || previous.threads[0]?.id !== trigger.threads[0]?.id)) throw new Error('LOCAL_REQUEST_CONFLICT')
        return receive(previous ?? trigger)
      })
    },
    /** Replies on one thread; records are immutable and survive host/process restarts. */
    replies(threadId: string): OutboundMessage[] {
      const thread = localTrigger({ requestId: 'read', threadId, text: 'read' }).channel!.thread
      return (store.get(KV.local.threadReplies(thread)) ?? []).flatMap(id => {
        const message = store.get(KV.local.reply(id))
        return message?.channel.thread === thread ? [message] : []
      })
    },
  }
}
