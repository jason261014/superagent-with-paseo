import { execFile } from 'node:child_process'
import { isDeepStrictEqual, promisify } from 'node:util'
import { createPaseoClient, type PaseoAgentCreateOptions, type PaseoClient } from '@getpaseo/client'

const execFileAsync = promisify(execFile)
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const PAGE_LIMIT = 50
const MAX_PAGES = 100
const HISTORY_LIMIT = 200
const MAX_HISTORY_PAGES = 20

function fail(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function assertId(id: string): void {
  if (typeof id !== 'string' || !ID.test(id)) throw fail('INVALID_AGENT_ID')
}

function assertMessageId(id: string): void {
  if (typeof id !== 'string' || !MESSAGE_ID.test(id)) throw fail('INVALID_MESSAGE_ID')
}

function assertLabels(labels: Record<string, string>): void {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels) || !Object.keys(labels).length ||
      Object.entries(labels).some(([key, value]) => !key || typeof value !== 'string' || !value)) throw fail('INVALID_LABELS')
}

/** Only an exact ID observed from a successful create or refresh may be passed here. */
export function buildStopArgs(authority: string, agentId: string, confirmedId: string): string[] {
  if (!/^(127\.0\.0\.1|localhost):[0-9]+$/.test(authority) || !ID.test(agentId) || agentId !== confirmedId) throw fail('INVALID_STOP_TARGET')
  const port = Number(authority.slice(authority.lastIndexOf(':') + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('INVALID_STOP_TARGET')
  return ['stop', agentId, '--host', authority, '--json']
}

export interface PaseoAdapterOptions {
  url: string
  lifetime?: AbortSignal
  password?: string
  binary?: string
  createClient?: typeof createPaseoClient
  exec?: (file: string, args: string[], options: { timeout: number; shell: false; signal?: AbortSignal }) => Promise<unknown>
}
export interface LabelMatch { agentId: string; cwd: string | null; labels: Record<string, string> }
export type LabelLookup = { kind: 'complete'; matches: LabelMatch[] } | { kind: 'unknown'; matches: LabelMatch[]; reason: string }
export interface RuntimeSnapshot {
  agentId: string; cwd: string | null; status: string; activeTurn: unknown; pendingPermissions: unknown[]
  observedAt: string; unknownChildren: true
}
export type MessageLookup = { kind: 'present'; entry: unknown; epoch: string } |
  { kind: 'absent_confirmed'; epoch: string } | { kind: 'unknown'; reason: string }
export interface PaseoTimelineEntry {
  item: unknown
  timestamp: string
  seqStart: number
  seqEnd: number
}
export type TimelineLookup = { kind: 'complete'; epoch: string; entries: PaseoTimelineEntry[] } |
  { kind: 'unknown'; reason: string }
export interface PaseoAdapter {
  create(input: PaseoAgentCreateOptions): Promise<{ agentId: string; cwd: string }>
  send(agentId: string, text: string, messageId: string): Promise<void>
  findByLabels(labels: Record<string, string>): Promise<LabelLookup>
  findMessage(agentId: string, messageId: string): Promise<MessageLookup>
  timeline(agentId: string): Promise<TimelineLookup>
  snapshot(agentId: string): Promise<RuntimeSnapshot>
  interrupt(agentId: string, signal?: AbortSignal): Promise<{ requestSent: true | null; runtime: RuntimeSnapshot | null }>
  archive(agentId: string): Promise<{ archivedAt: string }>
  close(): Promise<void>
}

/** Paseo public SDK/CLI adapter. It does not manage tasks or retry uncertain writes. */
export function createPaseoAdapter(options: PaseoAdapterOptions): PaseoAdapter {
  const parsed = new URL(options.url)
  if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.port ||
      parsed.pathname !== '/ws' || parsed.username || parsed.password || parsed.search || parsed.hash) throw fail('INVALID_PASEO_URL')
  const authority = parsed.host
  // URL validation does not prove a port is in range on every JS implementation.
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('INVALID_PASEO_URL')
  const binary = options.binary ?? 'paseo'
  if (!binary) throw fail('INVALID_PASEO_BINARY')
  const createClient = options.createClient ?? createPaseoClient
  const exec = options.exec ?? execFileAsync
  const knownAgents = new Set<string>()
  let client: PaseoClient | undefined
  let connecting: Promise<PaseoClient> | undefined
  let pendingClient: PaseoClient | undefined
  let closed = false
  let closing: Promise<void> | undefined

  async function connected(): Promise<PaseoClient> {
    if (closed) throw fail('PASEO_CLOSED')
    if (connecting) return connecting
    options.lifetime?.throwIfAborted()
    const pending = createClient({ url: options.url, ...(options.password ? { password: options.password } : {}),
      reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 30000 } })
    pendingClient = pending
    const abort = () => { void pending.close().catch(() => {}) }
    options.lifetime?.addEventListener('abort', abort, { once: true })
    connecting = (async () => {
      try { await pending.connect(); if (closed) throw fail('PASEO_CLOSED'); options.lifetime?.throwIfAborted(); client = pending; return pending }
      catch (error) { await pending.close().catch(() => {}); connecting = undefined; throw error }
      finally { options.lifetime?.removeEventListener('abort', abort) }
    })()
    return connecting
  }

  async function snapshot(agentId: string) {
    assertId(agentId)
    const handle = (await connected()).agents.ref(agentId)
    const refreshed = await handle.refresh()
    const agent = refreshed?.agent ?? handle.current()
    // A reference alone is not proof the supplied string is a full agent ID.
    if (agent && agent.id === agentId) knownAgents.add(agentId)
    return { agentId: agent?.id ?? agentId, cwd: agent?.cwd ?? null, status: agent?.status ?? 'unknown',
      activeTurn: agent?.activeTurn ?? null, pendingPermissions: agent?.pendingPermissions ?? [],
      observedAt: new Date().toISOString(), unknownChildren: true as const }
  }

  return {
    async create(input: PaseoAgentCreateOptions) {
      if (!input || typeof input.cwd !== 'string' || !input.cwd.startsWith('/') ||
          typeof input.config?.provider !== 'string' || !input.config.provider ||
          typeof input.config.modeId !== 'string' || !input.config.modeId) throw fail('INVALID_CREATE_OPTIONS')
      if (input.labels) assertLabels(input.labels)
      if (input.prompt && !input.clientMessageId) throw fail('INITIAL_MESSAGE_ID_REQUIRED')
      if (input.clientMessageId !== undefined) assertMessageId(input.clientMessageId)
      const handle = await (await connected()).agents.create(input)
      assertId(handle.id)
      knownAgents.add(handle.id)
      return { agentId: handle.id, cwd: input.cwd }
    },

    async send(agentId: string, text: string, messageId: string) {
      assertId(agentId); assertMessageId(messageId)
      if (typeof text !== 'string' || !text) throw fail('INVALID_MESSAGE')
      await (await connected()).agents.ref(agentId).send(text, { messageId })
    },

    /** Complete pagination is not proof that a concurrent/uncertain creation did not occur. */
    async findByLabels(labels: Record<string, string>): Promise<LabelLookup> {
      assertLabels(labels)
      const matches: LabelMatch[] = []
      const ids = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      try {
        const client = await connected()
        for (let page = 0; page < MAX_PAGES; page++) {
          const result = await client.agents.list({ filter: { labels, includeArchived: true },
            page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) } })
          if (!result || !Array.isArray(result.entries) || !result.pageInfo || typeof result.pageInfo.hasMore !== 'boolean') {
            return { kind: 'unknown', matches, reason: 'INVALID_PAGE' }
          }
          for (const entry of result.entries) {
            const agent = entry?.agent
            if (!agent || typeof agent.id !== 'string' || !ID.test(agent.id) || !agent.labels || typeof agent.labels !== 'object') {
              return { kind: 'unknown', matches, reason: 'INVALID_ENTRY' }
            }
            if (!ids.has(agent.id) && Object.entries(labels).every(([key, value]) => agent.labels?.[key] === value)) {
              ids.add(agent.id)
              matches.push({ agentId: agent.id, cwd: agent.cwd ?? null, labels: agent.labels })
            }
          }
          if (!result.pageInfo.hasMore) return { kind: 'complete', matches }
          const next = result.pageInfo.nextCursor
          if (typeof next !== 'string' || !next || cursors.has(next)) return { kind: 'unknown', matches, reason: 'INVALID_CURSOR' }
          cursors.add(next); cursor = next
        }
        return { kind: 'unknown', matches, reason: 'PAGE_BOUND' }
      } catch { return { kind: 'unknown', matches, reason: 'LIST_FAILED' } }
    },

    async findMessage(agentId: string, messageId: string) {
      assertId(agentId); assertMessageId(messageId)
      try {
        const handle = (await connected()).agents.ref(agentId)
        let epoch: string | null = null
        let cursor: { epoch: string; seq: number } | undefined
        const seen = new Set<string>()
        for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
          const result = await handle.timeline.refetch({ direction: cursor ? 'before' : 'tail',
            ...(cursor ? { cursor } : {}), limit: HISTORY_LIMIT })
          if (!result || result.error || !Array.isArray(result.entries) || typeof result.epoch !== 'string' ||
              typeof result.hasOlder !== 'boolean') return { kind: 'unknown' as const, reason: 'INVALID_HISTORY' }
          if (epoch !== null && epoch !== result.epoch) return { kind: 'unknown' as const, reason: 'EPOCH_CHANGED' }
          epoch = result.epoch
          if (result.gap || result.staleCursor) return { kind: 'unknown' as const, reason: 'TIMELINE_GAP' }
          const entry = result.entries.find(({ item }) => item.type === 'user_message' &&
            (item.messageId === messageId || item.clientMessageId === messageId))
          if (entry) return { kind: 'present' as const, entry, epoch }
          if (!result.hasOlder) return { kind: 'absent_confirmed' as const, epoch }
          const next = result.startCursor
          const cursorKey = next && `${next.epoch}:${next.seq}`
          if (!next || !cursorKey || seen.has(cursorKey)) return { kind: 'unknown' as const, reason: 'HISTORY_BOUND' }
          seen.add(cursorKey); cursor = next
        }
        return { kind: 'unknown' as const, reason: 'HISTORY_BOUND' }
      } catch { return { kind: 'unknown' as const, reason: 'HISTORY_FAILED' } }
    },

    async timeline(agentId: string): Promise<TimelineLookup> {
      assertId(agentId)
      try {
        const handle = (await connected()).agents.ref(agentId)
        const entries = new Map<number, PaseoTimelineEntry>()
        let epoch: string | null = null
        let cursor: { epoch: string; seq: number } | undefined
        for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
          const result = await handle.timeline.refetch({ direction: cursor ? 'before' : 'tail',
            ...(cursor ? { cursor } : {}), limit: HISTORY_LIMIT })
          if (!result || result.error || !Array.isArray(result.entries) || typeof result.epoch !== 'string' ||
              typeof result.hasOlder !== 'boolean' || result.reset || result.gap || result.staleCursor) {
            return { kind: 'unknown', reason: result?.gap || result?.staleCursor ? 'TIMELINE_GAP' : 'INVALID_HISTORY' }
          }
          if (epoch !== null && epoch !== result.epoch) return { kind: 'unknown', reason: 'EPOCH_CHANGED' }
          epoch = result.epoch
          for (const entry of result.entries) {
            if (!entry || typeof entry !== 'object' || typeof entry.seqStart !== 'number' ||
                !Number.isSafeInteger(entry.seqStart) || entry.seqStart < 0 || typeof entry.seqEnd !== 'number' ||
                !Number.isSafeInteger(entry.seqEnd) || entry.seqEnd < entry.seqStart ||
                typeof entry.timestamp !== 'string' || !('item' in entry)) {
              return { kind: 'unknown', reason: 'INVALID_ENTRY' }
            }
            const projected = { item: entry.item, timestamp: entry.timestamp, seqStart: entry.seqStart, seqEnd: entry.seqEnd }
            const old = entries.get(entry.seqStart)
            if (old && !isDeepStrictEqual(old, projected)) return { kind: 'unknown', reason: 'HISTORY_CHANGED' }
            entries.set(entry.seqStart, projected)
          }
          if (!result.hasOlder) {
            const sorted = [...entries.values()].sort((a, b) => a.seqStart - b.seqStart)
            if (sorted.some((entry, i) => i > 0 && entry.seqStart <= sorted[i - 1]!.seqEnd)) {
              return { kind: 'unknown', reason: 'HISTORY_CHANGED' }
            }
            return { kind: 'complete', epoch: epoch!, entries: sorted }
          }
          const next = result.startCursor
          if (!next || typeof next.epoch !== 'string' || !Number.isSafeInteger(next.seq) ||
              next.seq < 0 || next.epoch !== epoch || (cursor && next.seq >= cursor.seq)) {
            return { kind: 'unknown', reason: 'HISTORY_BOUND' }
          }
          cursor = next
        }
        return { kind: 'unknown', reason: 'HISTORY_BOUND' }
      } catch { return { kind: 'unknown', reason: 'HISTORY_FAILED' } }
    },

    snapshot,
    async interrupt(agentId: string, signal?: AbortSignal) {
      assertId(agentId)
      if (!knownAgents.has(agentId)) throw fail('UNKNOWN_AGENT')
      const args = buildStopArgs(authority, agentId, agentId)
      let requestSent: true | null = null
      try { await exec(binary, args, { timeout: 10_000, shell: false, ...(signal ? { signal } : {}) }); requestSent = true } catch { /* the request may have reached the daemon */ }
      const runtime = await snapshot(agentId).catch(() => null)
      return { requestSent, runtime }
    },
    async archive(agentId: string) {
      assertId(agentId)
      if (!knownAgents.has(agentId)) throw fail('UNKNOWN_AGENT')
      return (await connected()).agents.ref(agentId).archive()
    },
    close() {
      closed = true
      return closing ??= (async () => {
        // Close first to reject a pending connect/request, then wait for it to settle.
        await (client ?? pendingClient)?.close()
        await connecting?.catch(() => undefined)
        client = undefined; pendingClient = undefined; connecting = undefined; knownAgents.clear()
      })()
    },
  }
}
