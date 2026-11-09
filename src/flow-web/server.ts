/** Loopback-only, token-guarded read-only HTTP server for the flow canvas. */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Store } from '../app/store.ts'
import type { FlowHostPhase } from './model.ts'
import { projectFlowItem, projectFlowOverview } from './project.ts'

export interface FlowWebOptions {
  stateDir: string
  port: number
  host?: '127.0.0.1'
  status: () => { phase: FlowHostPhase; detail?: string }
  store: Pick<Store, 'get' | 'keys' | 'db' | 'tickets' | 'decisions' | 'triggers' | 'receipts'>
  staticDir?: string
  transcript?: (sessionKey: string) => Promise<unknown>
}

export interface FlowWebServer {
  url: string
  token: string
  close(): Promise<void>
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, JSON_HEADERS)
  res.end(status === 204 ? undefined : JSON.stringify(value))
}

function sendText(res: ServerResponse, status: number, contentType: string, value: string | Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" })
  res.end(value)
}

function tokenOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
  return header.slice('Bearer '.length).trim()
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let index = 0; index < a.length; index++) result |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return result === 0
}

/** Creates or reuses `<stateDir>/flow-web/access.json` with 0600 permissions; never logs the token. */
function accessFile(stateDir: string): { token: string; url?: string; file: string } {
  const dir = join(stateDir, 'flow-web')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const file = join(dir, 'access.json')
  if (existsSync(file)) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown; url?: unknown }
      if (typeof value.token === 'string' && value.token.length >= 32) {
        chmodSync(file, 0o600)
        return { token: value.token, ...(typeof value.url === 'string' ? { url: value.url } : {}), file }
      }
    } catch { /* regenerate a malformed token file */ }
  }
  const token = randomBytes(32).toString('hex')
  writeFileSync(file, JSON.stringify({ version: 1, token }), { mode: 0o600 })
  chmodSync(file, 0o600)
  return { token, file }
}

function parseInteger(value: string | null, fallback: number | undefined, min: number, max: number): number | undefined {
  if (value === null) return fallback
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined
  const number = Number(value)
  return number >= min && number <= max ? number : undefined
}

const FALLBACK_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Superagent Flow</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;margin:3rem;color:#1f2937;background:#f8fafc}
code{background:#e2e8f0;padding:.15rem .35rem;border-radius:4px}.card{border:1px solid #cbd5e1;border-radius:10px;padding:1.25rem 1.5rem;background:#fff;max-width:52rem}
h1{font-size:1.15rem;margin:0 0 .75rem}</style></head>
<body><div class="card"><h1>Superagent flow canvas</h1>
<p>The canvas assets have not been built yet. Run <code>pnpm build</code> and reload this page.</p>
<p id="host"></p></div>
<script>fetch('/api/flow/overview',{headers:{authorization:'Bearer '+decodeURIComponent((location.hash.match(/(?:^#|&)token=([^&]+)/)||[])[1]||'')}})
.then(async r=>{const el=document.getElementById('host');if(!r.ok){el.textContent='Host status unavailable ('+r.status+')';return}const b=await r.json();el.textContent='Host: '+b.host.phase+(b.host.detail?' — '+b.host.detail:'')})
.catch(()=>{document.getElementById('host').textContent='Host status unavailable'})</script></body></html>`

export async function startFlowWebServer(options: FlowWebOptions): Promise<FlowWebServer> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error('Invalid flow web port')
  if (options.host !== undefined && options.host !== '127.0.0.1') throw new Error('Flow web must bind to 127.0.0.1')
  const access = accessFile(options.stateDir)
  const staticDir = options.staticDir
  const inFlight = new Set<Promise<void>>()
  let closed = false
  let server: Server | undefined

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (closed) { req.destroy(); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: 'READ_ONLY' }); return }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/' || url.pathname.startsWith('/assets/')) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice('/assets/'.length)
      if (name.includes('..') || name.includes('/')) { sendJson(res, 404, { error: 'NOT_FOUND' }); return }
      const file = staticDir ? join(staticDir, name === 'index.html' ? 'index.html' : name) : undefined
      if (!file || !existsSync(file)) { sendText(res, 200, 'text/html; charset=utf-8', FALLBACK_HTML); return }
      const type = file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8'
      sendText(res, 200, type, readFileSync(file)); return
    }
    if (!url.pathname.startsWith('/api/flow/')) { sendJson(res, 404, { error: 'NOT_FOUND' }); return }
    const supplied = tokenOf(req)
    if (!supplied || !safeEqual(supplied, access.token)) { sendJson(res, 401, { error: 'UNAUTHORIZED' }); return }

    try {
      if (url.pathname === '/api/flow/overview') {
        const cursor = parseInteger(url.searchParams.get('cursor'), 0, 0, Number.MAX_SAFE_INTEGER)
        const limit = parseInteger(url.searchParams.get('limit'), 50, 1, 200)
        if (cursor === undefined || limit === undefined) { sendJson(res, 400, { error: 'INVALID_QUERY' }); return }
        const filter = url.searchParams.get('filter') ?? 'all'
        if (!['all', 'active', 'attention', 'completed', 'unaccepted'].includes(filter)) { sendJson(res, 400, { error: 'INVALID_FILTER' }); return }
        sendJson(res, 200, projectFlowOverview(options.store as Store, options.status(),
          { cursor, limit, filter: filter as 'all' | 'active' | 'attention' | 'completed' | 'unaccepted', ...(url.searchParams.get('q') ? { q: url.searchParams.get('q')! } : {}) })); return
      }
      if (url.pathname.startsWith('/api/flow/items/')) {
        const [, , , , kind, ...rest] = url.pathname.split('/')
        if ((kind !== 'ticket' && kind !== 'request') || rest.length === 0) { sendJson(res, 400, { error: 'INVALID_ITEM' }); return }
        const item = projectFlowItem(options.store as Store, kind, decodeURIComponent(rest.join('/')))
        if (!item) { sendJson(res, 404, { error: 'NOT_FOUND' }); return }
        sendJson(res, 200, item); return
      }
      if (url.pathname.startsWith('/api/flow/transcript/')) {
        const sessionKey = decodeURIComponent(url.pathname.slice('/api/flow/transcript/'.length))
        if (!sessionKey || sessionKey.includes('/')) { sendJson(res, 400, { error: 'INVALID_SESSION' }); return }
        if (!options.transcript) {
          sendJson(res, 200, { sessionKey, agentId: null, status: 'unavailable', reason: 'transcript_access_not_configured',
            note: 'Live transcript requires a configured Paseo adapter; local records remain available.', entries: [], truncated: false }); return
        }
        sendJson(res, 200, await options.transcript(sessionKey)); return
      }
      sendJson(res, 404, { error: 'NOT_FOUND' })
    } catch (error) {
      sendJson(res, 500, { error: 'FLOW_READ_FAILED', detail: error instanceof Error ? error.message : String(error) })
    }
  }

  server = createServer((req, res) => {
    const work = handle(req, res).catch(() => { try { sendJson(res, 500, { error: 'FLOW_READ_FAILED' }) } catch { res.destroy() } })
    inFlight.add(work)
    void work.finally(() => inFlight.delete(work))
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 15_000
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(options.port, '127.0.0.1', () => { server!.off('error', reject); resolve() })
  })
  const port = (server.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}`
  writeFileSync(access.file, JSON.stringify({ version: 1, token: access.token, url }), { mode: 0o600 })
  chmodSync(access.file, 0o600)
  return {
    url,
    token: access.token,
    async close() {
      if (closed) return
      closed = true
      await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections?.() })
      await Promise.allSettled([...inFlight])
    },
  }
}
