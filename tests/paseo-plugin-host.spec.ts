import { expect, it, vi } from 'vitest'
import { createPluginHostControl, type HostModule } from '../src/paseo-ui/host-control.ts'
import type { HostConfig } from '../src/hosts/paseo.ts'
const config: HostConfig = { stateDir: '/tmp/sa-plugin', paseo: { url: 'ws://127.0.0.1:6767/ws', orchestrator: 'codex', worker: 'codex',
  orchestratorMode: 'read-only', workerMode: 'read-only', bridgeNode: process.execPath, bridgeCommand: '/tmp/bridge.mjs' } }
it('never starts a host when cleanup precedes dynamic import completion', async () => {
  let loaded!: (module: HostModule) => void
  const pending = new Promise<HostModule>(resolve => { loaded = resolve }), create = vi.fn()
  const control = createPluginHostControl({ mode: 'embedded', runtimeEntry: '/tmp/host.js', config, loadRuntime: () => pending })
  expect(await control.stop()).toEqual({ closed: true })
  loaded({ createPaseoHost: create }); await Promise.resolve(); await Promise.resolve()
  expect(create).not.toHaveBeenCalled()
})
it.each(['import', 'ready'])('records a rejected %s as an error without an unhandled rejection', async stage => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const control = createPluginHostControl({ mode: 'embedded', runtimeEntry: '/tmp/host.js', config,
      loadRuntime: async () => {
        if (stage === 'import') throw new Error('loader failed')
        return { createPaseoHost: () => ({ ready: Promise.reject(new Error('startup failed')), status: () => ({ phase: 'starting' }), stop: async () => ({ closed: true }) }) }
      } })
    await vi.waitFor(() => expect(control.status().phase).toBe('error'))
    await control.stop()
  } finally { error.mockRestore() }
})
it('exposes needs_setup and shares a single host with an idempotent cleanup', async () => {
  const stop = vi.fn(async () => ({ closed: true as const }))
  const create = vi.fn(() => ({ ready: Promise.resolve(), status: () => ({ phase: 'needs_setup' as const }), stop }))
  const control = createPluginHostControl({ mode: 'embedded', runtimeEntry: '/tmp/host.js', config, loadRuntime: async () => ({ createPaseoHost: create }) })
  await vi.waitFor(() => expect(control.status().phase).toBe('needs_setup'))
  expect(create).toHaveBeenCalledOnce(); await control.stop(); await control.stop()
  expect(stop).toHaveBeenCalled()
})
it('external mode never claims that an independently owned host is ready', async () => {
  const control = createPluginHostControl({ mode: 'external' })
  expect(control.status().phase).toBe('stopped'); expect(await control.stop()).toEqual({ closed: true })
})
