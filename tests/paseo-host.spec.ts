import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createPaseoHost, type HostConfig } from '../src/hosts/paseo.ts'
import type { PaseoHost } from '../src/hosts/lifecycle.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { localCall } from '../src/local/transport.ts'

const hosts: PaseoHost[] = [], dirs: string[] = []
afterEach(async () => { for (const host of hosts.splice(0)) await host.stop(2000); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function config(): HostConfig {
  const stateDir = mkdtempSync(join(tmpdir(), 'sa-host-')); dirs.push(stateDir)
  return { stateDir, paseo: { url: 'ws://127.0.0.1:6767/ws', orchestrator: 'codex', worker: 'codex',
    orchestratorMode: 'read-only', workerMode: 'read-only', bridgeNode: process.execPath, bridgeCommand: resolve('bin/superagent-mcp.mjs') } }
}
function host(value: HostConfig, options: Parameters<typeof createPaseoHost>[1] = {}) {
  const result = createPaseoHost(value, options); hosts.push(result); return result
}
it('boots without DSH, exposes needs_setup, preserves the database, and releases its lock only after stop', async () => {
  const c = config(), first = host(c)
  await first.ready
  expect(first.status().phase).toBe('needs_setup')
  expect(await localCall(c.stateDir, 'GET', '/status')).toMatchObject({ configured: false, accepting: false })
  expect(existsSync(c.stateDir + '.lock')).toBe(true)
  await expect(first.stop()).resolves.toEqual({ closed: true })
  const store = new Store(join(c.stateDir, 'orchestrator.sqlite'))
  const id = store.get(KV.runtime.masterId)
  expect(store.get(KV.host.lifecycle)?.phase).toBe('stopped'); store.close()
  const second = host(c); await second.ready; await second.stop()
  const restored = new Store(join(c.stateDir, 'orchestrator.sqlite'))
  expect(restored.get(KV.runtime.masterId)).toBe(id); restored.close()
})
it.each(['remote', 'relative', 'recursive', 'unknown'])('rejects invalid %s config before opening the store', async problem => {
  const c = config()
  if (problem === 'remote') c.paseo.url = 'ws://example.com:6767/ws'
  if (problem === 'relative') c.paseo.bridgeNode = 'node'
  if (problem === 'recursive') c.paseo.worker = 'superagent/model'
  if (problem === 'unknown') Object.assign(c, { stray: true })
  await expect(host(c).ready).rejects.toThrow()
  expect(existsSync(join(c.stateDir, 'orchestrator.sqlite'))).toBe(false)
})
it('does not start after cancellation during preflight', async () => {
  const c = config(); let complete!: (value: string) => void
  const first = host(c, { runWorker: () => new Promise(resolve => { complete = resolve }) })
  expect(await first.stop(1)).toEqual({ closed: false, reason: 'deadline' })
  complete(''); await first.ready
  expect(await first.stop()).toEqual({ closed: true })
  expect(existsSync(join(c.stateDir, 'orchestrator.sqlite'))).toBe(false)
})
it('waits for the old host and cancels that wait without touching the current lock', async () => {
  const c = config(), first = host(c); await first.ready
  const blocked = host(c, { lockWaitMs: 20 })
  await expect(blocked.ready).rejects.toThrow('still owned')
  const next = host(c); await vi.waitFor(() => expect(next.status().phase).toBe('starting'))
  expect(await next.stop()).toEqual({ closed: true })
  expect(existsSync(c.stateDir + '.lock')).toBe(true)
  await first.stop()
  const last = host(c); await last.ready
  expect(last.status().phase).toBe('needs_setup')
})
