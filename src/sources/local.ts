/**
 * Disabled-by-default, in-process local Source primitives.
 *
 * No listener, HTTP route or CLI calls these functions. A future transport must authenticate the local
 * operator and explicitly attest that the request is from that operator before calling localTrigger.
 * A process UID or a request body's claimed identity alone does not authenticate a remote caller or
 * prove that a human initiated the request. The caller is a trusted component of the host process.
 */
import { getuid } from 'node:process'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import type { SourceKind } from './kind.ts'

const LocalConfig = z.object({ acceptRequests: z.boolean().default(false) }).strict()
const LocalPolicy = z.object({ allowed: z.array(z.object({ id: z.string().regex(/^uid:[0-9]+$/) }).strict()).default([]) }).strict()
const Request = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
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
 * that person; there is currently no such transport in the product. Never expose it directly to HTTP.
 * The request may not supply its own identity. Engine.receive must still apply scope and Policy gate.
 * Engine.receive deduplicates by ID without comparing content: the future ingress must atomically
 * reject reuse of a requestId with different text before it treats a duplicate as a safe retry.
 */
export function localTrigger(request: LocalRequest, at = new Date().toISOString()): Trigger {
  const parsed = Request.parse(request)
  if (typeof getuid !== 'function') throw new Error('LOCAL_UID_UNAVAILABLE')
  const actorId = `uid:${getuid()}`
  return { id: key('local', actorId, parsed.requestId), source: 'local',
    threads: [{ source: 'local', id: key('local-thread', actorId, parsed.requestId) }],
    actor: { source: 'local', id: actorId }, human: true, addressed: 'direct', at, text: parsed.text,
    meta: { requestId: parsed.requestId, origin: 'local-request' } }
}
