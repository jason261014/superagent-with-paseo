import { existsSync, statSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createPaseoHost, type HostConfig } from '../src/hosts/paseo.ts'
import type { PaseoHost } from '../src/hosts/lifecycle.ts'
import { startFlowWebServer, type FlowWebServer } from '../src/flow-web/server.ts'

const dirs: string[] = [], servers: FlowWebServer[] = [], hosts: PaseoHost[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const host of hosts.splice(0)) await host.stop(2000)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-flow-server-'))
  dirs.push(dir)
  return dir
}

function fakeStore(): { get: (key: string) => unknown; keys: () => string[]; db: unknown; tickets: { list: () => unknown[]; get: () => undefined }; decisions: { get: () => undefined }; triggers: { get: () => undefined; disposition: () => undefined }; receipts: { get: () => undefined } } {
  const values = new Map<string, unknown>([
    ['master-id', 'orchestrator-master-01'],
  ])
  return {
    get: key => values.get(key),
    keys: () => [...values.keys()],
    db: { prepare: () => ({ all: () => [], get: () => undefined }) },
    tickets: { list: () => [], get: () => undefined },
    decisions: { get: () => undefined },
    triggers: { get: () => undefined, disposition: () => undefined },
    receipts: { get: () => undefined },
  }
}

it('issues a 0600 access token and refuses unauthenticated or write requests', async () => {
  const dir = stateDir()
  const server = await startFlowWebServer({ stateDir: dir, port: 0, status: () => ({ phase: 'ready' }) , store: fakeStore() as never })
  servers.push(server)
  expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
  const access = join(dir, 'flow-web', 'access.json')
  expect(existsSync(access)).toBe(true)
  expect(statSync(access).mode & 0o777).toBe(0o600)
  const token = server.token
  expect(token.length).toBeGreaterThan(20)

  const anonymous = await fetch(`${server.url}/api/flow/overview`)
  expect(anonymous.status).toBe(401)
  const wrong = await fetch(`${server.url}/api/flow/overview`, { headers: { authorization: 'Bearer wrong-token' } })
  expect(wrong.status).toBe(401)
  const write = await fetch(`${server.url}/api/flow/overview`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  expect(write.status).toBe(405)

  const authorized = await fetch(`${server.url}/api/flow/overview`, { headers: { authorization: `Bearer ${token}` } })
  expect(authorized.status).toBe(200)
  expect(authorized.headers.get('cache-control')).toBe('no-store')
  const body = await authorized.json() as { host: { phase: string }; items: unknown[] }
  expect(body.host.phase).toBe('ready')
  expect(Array.isArray(body.items)).toBe(true)
})

it('serves ticket and request item routes plus transcript unavailable diagnostics', async () => {
  const dir = stateDir()
  const server = await startFlowWebServer({ stateDir: dir, port: 0, status: () => ({ phase: 'needs_setup', detail: 'not configured' }), store: fakeStore() as never })
  servers.push(server)
  const headers = { authorization: `Bearer ${server.token}` }
  const ticket = await fetch(`${server.url}/api/flow/items/ticket/missing`, { headers })
  expect(ticket.status).toBe(404)
  const request = await fetch(`${server.url}/api/flow/items/request/missing`, { headers })
  expect(request.status).toBe(404)
  const transcript = await fetch(`${server.url}/api/flow/transcript/orchestrator-master-01`, { headers })
  expect(transcript.status).toBe(200)
  const body = await transcript.json() as { status: string; reason: string }
  expect(body.status).toBe('unavailable')
  expect(body.reason).toBeTruthy()
})

it('mounts the flow web server through createPaseoHost and closes it before releasing the state lock', async () => {
  const dir = stateDir()
  const config: HostConfig = { stateDir: dir, flowWeb: { enabled: true, port: 0 },
    paseo: { url: 'ws://127.0.0.1:6767/ws', orchestrator: 'codex', worker: 'codex',
      orchestratorMode: 'read-only', workerMode: 'read-only', bridgeNode: process.execPath,
      bridgeCommand: '/Users/anxiaojie/src/superagent-with-paseo/bin/superagent-mcp.mjs' } }
  const host = createPaseoHost(config)
  hosts.push(host)
  await host.ready
  expect(host.status().phase).toBe('needs_setup')
  const url = host.flowWeb?.()
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/)
  const metadata = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(join(dir, 'flow-web', 'access.json'), 'utf8'))) as { token: string; url: string }
  expect(metadata.url).toBe(url)
  const response = await fetch(`${url}/api/flow/overview`, { headers: { authorization: `Bearer ${metadata.token}` } })
  expect(response.status).toBe(200)
  const body = await response.json() as { host: { phase: string }; counts: { totalItems: number } }
  expect(body.host.phase).toBe('needs_setup')
  expect(body.counts.totalItems).toBe(0)
  await expect(host.stop(2000)).resolves.toEqual({ closed: true })
  expect(existsSync(join(dir, 'orchestrator.sqlite'))).toBe(true)
})
