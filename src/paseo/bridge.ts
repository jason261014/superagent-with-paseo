/** Private role-bound bridge exposing the existing Tool definitions to a Paseo MCP stdio process. */
import { randomBytes, createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { Store } from '../app/store.ts'
import type { Tool } from '../app/tools/tool.ts'
import { family } from '../kv.ts'
import { liveTicket } from '../core/index.ts'
import { listenPrivate } from '../local/transport.ts'

export type ToolBinding = { sessionId: string; role: 'orchestrator' } |
  { sessionId: string; role: 'worker'; ticketId: string; assignmentId: string }
const grants = family<{ token: string; binding: ToolBinding }>('paseo-tool-grant:')
const receipts = family<{ hash: string; result: unknown }>('paseo-tool-result:')
const callSchema = z.object({ requestId: z.string().min(1).max(200), name: z.string().min(1).max(100), arguments: z.unknown() }).strict()
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export const bridgeSocketPath = (stateDir: string): string => join(stateDir, 'agent-ipc', 's')
export interface ToolBridgeHost {
  store: Pick<Store, 'get' | 'set' | 'keys' | 'tickets'>
  lifetime: AbortSignal
  tools(binding: ToolBinding, requestId: string): Tool[]
}
/** Serves role-bound original Superagent tools through an owner-only local socket. */
export class PaseoToolBridge {
  private readonly inflight = new Map<string, { hash: string; result: Promise<unknown> }>()
  private readonly running = new Set<Promise<unknown>>()
  private transport?: Awaited<ReturnType<typeof listenPrivate>>
  constructor(private readonly stateDir: string, private readonly host: ToolBridgeHost) {}
  /** Stable per logical session and assignment, written before creating the Paseo agent. Never accepted from model arguments. */
  grant(binding: ToolBinding): string {
    const name = grants(digest(JSON.stringify(binding)))
    const previous = this.host.store.get(name)
    if (previous) return previous.token
    const token = randomBytes(32).toString('hex')
    this.host.store.set(name, { token, binding })
    return token
  }
  private binding(token: string): ToolBinding {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid tool capability')
    for (const key of this.host.store.keys(grants)) {
      const grant = this.host.store.get(key)
      if (grant?.token === token) return grant.binding
    }
    throw new Error('Invalid tool capability')
  }
  private current(binding: ToolBinding): void {
    this.host.lifetime.throwIfAborted()
    if (binding.role === 'orchestrator') return
    const ticket = this.host.store.tickets.get(binding.ticketId), assignment = ticket?.assignments.at(-1)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== binding.assignmentId || !['pending', 'running'].includes(assignment.state)) {
      throw new Error('Tool assignment is no longer current')
    }
  }
  list(token: string): unknown {
    const binding = this.binding(token)
    this.current(binding)
    return { tools: this.host.tools(binding, '').map(tool => ({ name: tool.name, description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema) })) }
  }
  async call(token: string, input: unknown): Promise<unknown> {
    const binding = this.binding(token), call = callSchema.parse(input)
    const key = receipts(digest(`${token}:${call.requestId}`)), hash = digest(JSON.stringify({ name: call.name, arguments: call.arguments }))
    const previous = this.host.store.get(key)
    if (previous) {
      if (previous.hash !== hash) throw new Error('Tool request identity conflict')
      return previous.result
    }
    const pending = this.inflight.get(key)
    if (pending) {
      if (pending.hash !== hash) throw new Error('Tool request identity conflict')
      return pending.result
    }
    if (call.name !== 'orchestrator_report' || binding.role !== 'worker') this.current(binding)
    const tool = this.host.tools(binding, call.requestId).find(tool => tool.name === call.name)
    if (!tool) throw new Error('Tool unavailable for this role')
    const args = tool.schema.parse(call.arguments)
    // Serialize duplicates while an asynchronous source read/reply is in flight. Domain mutations retain their original transactions.
    const result = Promise.resolve().then(async () => {
      if (call.name !== 'orchestrator_report' || binding.role !== 'worker') this.current(binding)
      const value = await tool.execute(args, this.host.lifetime)
      if (!(value && typeof value === 'object' && 'queued' in value && value.queued)) this.host.store.set(key, { hash, result: value })
      return value
    })
    this.inflight.set(key, { hash, result }); this.running.add(result)
    try { return await result } finally { this.inflight.delete(key); this.running.delete(result) }
  }
  async start(): Promise<void> {
    this.transport = await listenPrivate(this.stateDir, 'agent-ipc', async (req, res) => {
      const reply = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(value))
      }
      try {
        const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
        if (req.method === 'GET' && req.url === '/tools') { reply(200, this.list(token)); return }
        if (req.method !== 'POST' || req.url !== '/call') { reply(404, { error: 'Tool route unavailable' }); return }
        this.binding(token)
        let size = 0; const chunks: Buffer[] = []
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk); size += buffer.length
          if (size > 524288) throw new Error('Tool request too large')
          chunks.push(buffer)
        }
        reply(200, await this.call(token, JSON.parse(Buffer.concat(chunks).toString('utf8'))))
      } catch (error) { reply(400, { error: error instanceof Error ? error.message : String(error) }) }
    })
  }
  async close(): Promise<void> {
    await this.transport?.close()
    await Promise.allSettled([...this.running])
  }
}
