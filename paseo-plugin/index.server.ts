import type { PluginServerContext } from '@getpaseo/plugin/server'
import { createSuperagentProvider, createProjectProvider } from './server/provider.mjs'
import { createPluginHostControl } from './server/host-control.mjs'
import { createProjectManager, resolvePluginOptions } from './server/project-manager.mjs'
import * as localConfig from './shared/local-config.ts'

export default function contribute(server: PluginServerContext) {
  const options = resolvePluginOptions(localConfig, process.env)
  if (options.mode === 'managed') {
    const manager = createProjectManager(options.managerConfig)
    void manager.ready.catch(error => console.error('Superagent manager:', error instanceof Error ? error.message : 'initialization failed'))
    try { server.registerProvider(createProjectProvider({ manager, legacyProjectId: options.managerConfig.legacyProjectId })) }
    catch (error) { void manager.shutdown().catch(() => {}); throw error }
    return async () => {
      const result = await manager.shutdown(1000)
      if (!result.closed) console.warn('Superagent project shutdown deadline reached')
    }
  }
  const host = createPluginHostControl(options.mode === 'embedded'
    ? { mode: 'embedded', runtimeEntry: options.runtimeEntry, config: options.hostConfig } : { mode: 'external' })
  try { server.registerProvider(createSuperagentProvider({ stateDir: options.stateDir, ...(options.mode === 'embedded' ? { hostStatus: () => host.status() } : {}) })) }
  catch (error) { void host.stop().catch(error => console.error('Superagent cleanup failed:', error)); throw error }
  return async () => {
    const result = await host.stop(1000)
    if (!result.closed) console.warn('Superagent cleanup deadline reached; the state lock remains owned until final shutdown or process exit')
  }
}
