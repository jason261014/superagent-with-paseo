/** Owner-only Unix socket for explicit operator requests; not an HTTP/TCP ingress or an agent report bridge. */
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import type { LocalRequest } from '../sources/local.ts'
import type { OutboundMessage, ReceiveResult } from '../core/index.ts'

const MAX_BODY = 524_288 // A 64 KiB text can expand when JSON escapes control characters.
const MAX_REPLY = 8 * 1024 * 1024
export const localSocketPath = (stateDir: string): string => join(stateDir, 'local-ipc', 's')
export interface LocalHost {
  receive(request: LocalRequest): ReceiveResult
  replies(threadId: string): OutboundMessage[]
  status(): { configured: boolean; paused: boolean; accepting: boolean; actor: string }
}
const errorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : ''
  return /^LOCAL_[A-Z_]+$/.test(message) ? message : 'LOCAL_INVALID_REQUEST'
}

/** Caller must hold the Runtime state-directory lock until close() resolves. */
export async function listenLocal(stateDir: string, host: LocalHost): Promise<{ close(): Promise<void> }> {
  if (typeof process.getuid !== 'function') throw new Error('LOCAL_UID_UNAVAILABLE')
  const uid = process.getuid(), directory = join(stateDir, 'local-ipc'), path = localSocketPath(stateDir)
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
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      const text = JSON.stringify(value)
      res.writeHead(status, { 'content-type': 'application/json', 'connection': 'close' }); res.end(text)
    }
    try {
      if (req.method === 'GET' && req.url === '/status') { reply(200, host.status()); return }
      if (req.method === 'GET' && req.url?.startsWith('/threads/')) {
        const messages = host.replies(decodeURIComponent(req.url.slice('/threads/'.length)))
        reply(200, { messages }); return
      }
      if (req.method !== 'POST' || req.url !== '/requests') { reply(404, { error: 'LOCAL_NOT_FOUND' }); return }
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
      const result = host.receive(JSON.parse(Buffer.concat(chunks).toString('utf8')) as LocalRequest)
      reply(200, { result })
    } catch (error) { reply(errorCode(error) === 'LOCAL_REQUEST_CONFLICT' ? 409 : 400, { error: errorCode(error) }) }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    socket.setTimeout(10_000, () => socket.destroy())
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve() }) })
  try { chmodSync(path, 0o600) } catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error }
  let closing: Promise<void> | undefined
  return { close: () => closing ??= new Promise<void>(resolve => {
    server.close(() => resolve())
    for (const socket of sockets) socket.destroy()
  }) }
}

/** Connect only to an existing host; never launch one or retry a write with a new identity. */
export async function localCall(stateDir: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const text = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: localSocketPath(stateDir), method, path,
      headers: text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, res => {
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
