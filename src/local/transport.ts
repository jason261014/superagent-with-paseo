/** Owner-only Unix socket for explicit operator requests; not an HTTP/TCP ingress or an agent report bridge. */
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, request as httpRequest, type RequestListener } from 'node:http'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import type { LocalRequest } from '../sources/local.ts'
import type { OutboundMessage, ReceiveResult } from '../core/index.ts'
import type { LocalConversation } from './conversation.ts'
import { ConversationInput } from './protocol.ts'

const MAX_BODY = 524_288 // A 64 KiB text can expand when JSON escapes control characters.
const MAX_REPLY = 8 * 1024 * 1024
export const localSocketPath = (stateDir: string): string => join(stateDir, 'local-ipc', 's')
export interface LocalHost {
  receive(request: LocalRequest): ReceiveResult
  replies(threadId: string): OutboundMessage[]
  status(): { configured: boolean; paused: boolean; accepting: boolean; actor: string }
  conversation?: LocalConversation
}
const errorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : ''
  return /^LOCAL_[A-Z_]+$/.test(message) ? message : 'LOCAL_INVALID_REQUEST'
}

/** Caller must hold the Runtime state-directory lock until close() resolves. */
export async function listenPrivate(stateDir: string, name: 'local-ipc' | 'agent-ipc', listener: RequestListener): Promise<{ close(): Promise<void> }> {
  if (typeof process.getuid !== 'function') throw new Error('LOCAL_UID_UNAVAILABLE')
  const uid = process.getuid(), directory = join(stateDir, name), path = join(directory, 's')
  if (Buffer.byteLength(path) > 103) throw new Error('LOCAL_SOCKET_PATH_TOO_LONG')
  const parent = lstatSync(stateDir)
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o022)) throw new Error('LOCAL_UNSAFE_DIRECTORY')
  try { mkdirSync(directory, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  // Do not follow a symlink or silently change an existing directory's ownership/permissions.
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077)) throw new Error('LOCAL_UNSAFE_DIRECTORY')
  try {
    const stale = lstatSync(path)
    if (!stale.isSocket() || stale.uid !== uid) throw new Error('LOCAL_UNSAFE_SOCKET')
    unlinkSync(path)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const sockets = new Set<Socket>()
  const server = createServer(listener)
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    socket.setTimeout(60_000, () => socket.destroy())
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve() }) })
  try { chmodSync(path, 0o600) } catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error }
  let closing: Promise<void> | undefined
  return { close: () => closing ??= new Promise<void>(resolve => {
    server.close(() => resolve())
    for (const socket of sockets) socket.destroy()
  }) }
}

/** Caller holds the Runtime state lock; operator routes never accept agent reports. */
export async function listenLocal(stateDir: string, host: LocalHost): Promise<{ close(): Promise<void> }> {
  return listenPrivate(stateDir, 'local-ipc', async (req, res) => {
    const reply = (status: number, value: unknown) => {
      const text = JSON.stringify(value)
      res.writeHead(status, { 'content-type': 'application/json', 'connection': 'close' }); res.end(text)
    }
    try {
      if (req.method === 'GET' && req.url === '/status') { reply(200, host.status()); return }
      const url = new URL(req.url ?? '/', 'http://local')
      if (host.conversation && url.pathname.startsWith('/paseo/')) {
        const conversation = host.conversation
        if (req.method === 'GET' && url.pathname === '/paseo/binding') {
          reply(200, { binding: conversation.binding() ?? null, status: host.status() }); return
        }
        if (req.method === 'POST' && url.pathname === '/paseo/binding') {
          if (!host.status().accepting) { reply(409, { error: 'LOCAL_SOURCE_DISABLED' }); return }
          reply(200, { binding: conversation.bind(), status: host.status() }); return
        }
        if (req.method === 'GET' && url.pathname.startsWith('/paseo/requests/')) {
          const id = url.pathname.slice('/paseo/requests/'.length)
          if (!/^paseo-[a-f0-9]{64}$/.test(id)) throw new Error('LOCAL_INVALID_REQUEST')
          reply(200, { binding: conversation.binding() ?? null, receipt: conversation.receipt(id) ?? null }); return
        }
        if (req.method === 'GET' && url.pathname === '/paseo/events') {
          const number = (name: string, fallback?: number) => {
            const text = url.searchParams.get(name)
            if (text === null) return fallback
            if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error('LOCAL_CONVERSATION_CURSOR')
            return Number(text)
          }
          reply(200, conversation.events(number('after', 0), number('through'), number('limit', 100))); return
        }
      }
      if (req.method === 'GET' && req.url?.startsWith('/threads/')) {
        const messages = host.replies(decodeURIComponent(req.url.slice('/threads/'.length)))
        reply(200, { messages }); return
      }
      const conversationRequest = !!host.conversation && req.url === '/paseo/requests'
      if (req.method !== 'POST' || (req.url !== '/requests' && !conversationRequest)) { reply(404, { error: 'LOCAL_NOT_FOUND' }); return }
      if (!host.status().accepting) { reply(409, { error: 'LOCAL_SOURCE_DISABLED' }); return }
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk); size += buffer.length
        if (size > MAX_BODY) { reply(413, { error: 'LOCAL_REQUEST_TOO_LARGE' }); return }
        chunks.push(buffer)
      }
      // Admission is checked again after reading the body; settings may have changed meanwhile.
      if (!host.status().accepting) { reply(409, { error: 'LOCAL_SOURCE_DISABLED' }); return }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (conversationRequest) reply(200, host.conversation!.receive(ConversationInput.parse(body), request => host.receive(request)))
      else reply(200, { result: host.receive(body as LocalRequest) })
    } catch (error) { reply(errorCode(error) === 'LOCAL_REQUEST_CONFLICT' ? 409 : 400, { error: errorCode(error) }) }
  })
}

/** Connect only to an existing host; never launch one or retry a write with a new identity. */
export async function localCall(stateDir: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  return privateCall(localSocketPath(stateDir), method, path, body)
}
/** Bounded request to an existing private socket; never retries a write automatically. */
export async function privateCall(socketPath: string, method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<unknown> {
  const text = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, method, path,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }) } }, res => {
      let size = 0
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_REPLY) { res.destroy(new Error('LOCAL_REPLY_TOO_LARGE')); return }
        chunks.push(chunk)
      })
      res.on('error', reject)
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: string }
          if (res.statusCode !== 200) reject(new Error(value.error ?? 'LOCAL_REQUEST_FAILED'))
          else resolve(value)
        } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => req.destroy(new Error('LOCAL_REQUEST_TIMEOUT')))
    req.end(text)
  })
}
