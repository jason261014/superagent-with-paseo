/** One plugin owns one host; provider connections never create or stop it. */
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HostConfig } from '../hosts/paseo.ts'
import type { HostStatus, HostStop, PaseoHost } from '../hosts/lifecycle.ts'
export type { HostConfig, HostStatus, HostStop }
export interface HostModule { createPaseoHost(config: HostConfig): PaseoHost }
export type PluginHostOptions = { mode: 'external' } | {
  mode: 'embedded'; runtimeEntry: string; config: HostConfig
  loadRuntime?: (entry: string) => Promise<HostModule>
}
export interface PluginHostControl { status(): HostStatus; stop(budgetMs?: number): Promise<HostStop> }
export function createPluginHostControl(options: PluginHostOptions): PluginHostControl {
  let state: HostStatus = options.mode === 'external' ? { phase: 'stopped', detail: 'Externally managed host' } : { phase: 'starting' }
  let host: PaseoHost | undefined
  let cancelled = false
  let closed = false
  if (options.mode === 'embedded') {
    void (async () => {
      if (!isAbsolute(options.runtimeEntry)) throw new Error('Superagent runtimeEntry must be absolute')
      const load = options.loadRuntime ?? (async entry => await import(pathToFileURL(entry).href) as HostModule)
      const module = await load(options.runtimeEntry)
      if (cancelled) return
      if (typeof module.createPaseoHost !== 'function') throw new Error('Superagent runtime has no createPaseoHost export')
      host = module.createPaseoHost(options.config)
      await host.ready
      if (!cancelled) state = host.status()
    })().catch(error => {
      if (!cancelled) { state = { phase: 'error', detail: error instanceof Error ? error.message : String(error) }; console.error('Superagent host:', state.detail) }
    })
  }
  return {
    status: () => closed || state.phase === 'error' ? { ...state } : host?.status() ?? { ...state },
    async stop(budgetMs = 1000) {
      if (closed) return { closed: true }
      cancelled = true
      state = { phase: 'stopping' }
      const result = host ? await host.stop(budgetMs) : { closed: true as const }
      if (result.closed) { closed = true; state = { phase: 'stopped' } }
      return result
    },
  }
}
