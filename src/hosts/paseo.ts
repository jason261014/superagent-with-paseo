/** Standalone ESM host loaded once by the Paseo server plugin. */
import { accessSync, constants, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Runtime } from '../app/runtime.ts'
import { HostConfigSchema, type HostConfig } from './paseo-config.ts'
import { createPaseoBackend } from '../paseo/backend.ts'
import { createNodeWorkerRunner, type RunWorkerCommand } from '../infra/worker-command.ts'
import type { PaseoAdapter, PaseoAdapterOptions } from '../paseo/client.ts'
import { waitForHostStop, type HostStatus, type PaseoHost } from './lifecycle.ts'
import { startFlowWebServer, type FlowWebServer } from '../flow-web/server.ts'
import { packagePath } from '../infra/paths.ts'

export { HostConfigSchema, type HostConfig } from './paseo-config.ts'
export interface PaseoHostOptions {
  runWorker?: RunWorkerCommand
  createAdapter?: (options: PaseoAdapterOptions) => PaseoAdapter
  lockWaitMs?: number
}

export function createPaseoHost(config: HostConfig, options: PaseoHostOptions = {}): PaseoHost {
  let state: HostStatus = { phase: 'starting' }
  let runtime: Runtime | undefined
  let backendRef: ReturnType<typeof createPaseoBackend> | undefined
  let flowWeb: FlowWebServer | undefined
  let stopping: Promise<void> | undefined
  const cancelled = new AbortController()
  const runWorker = options.runWorker ?? createNodeWorkerRunner()
  // Always resolve resources from their explicit paths, independent of the plugin's working directory.
  const ready = (async () => {
    const parsed = HostConfigSchema.parse(config)
    const lockWaitMs = options.lockWaitMs ?? 35_000
    if (!Number.isFinite(lockWaitMs) || lockWaitMs < 0) throw new Error('Invalid state lock wait')
    for (const file of [parsed.paseo.bridgeCommand, parsed.paseo.bridgeNode]) if (!statSync(file).isFile()) throw new Error('Superagent bridge must refer to files')
    accessSync(parsed.paseo.bridgeNode, constants.X_OK)
    const check = `import {createRequire} from 'node:module'; const [major,minor]=process.versions.node.split('.').map(Number); if(!((major===22&&minor>=19)||major>=24))throw new Error('Unsupported bridge Node version'); await import(createRequire(process.argv[1]).resolve('@modelcontextprotocol/sdk/server/mcp.js'));`
    await runWorker({ argv: [parsed.paseo.bridgeNode, '--input-type=module', '-e', check, parsed.paseo.bridgeCommand],
      cwd: dirname(parsed.paseo.bridgeCommand), signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(10_000)]) })
    const deadline = Date.now() + lockWaitMs
    for (;;) {
      cancelled.signal.throwIfAborted()
      try {
        runtime = new Runtime({ logger: console, runWorker,
          runId: randomUUID(),
          backend: services => (backendRef = createPaseoBackend(services, options.createAdapter)),
          modelCatalog: async () => ({ default: { provider: parsed.paseo.orchestrator.split('/')[0]!, model: parsed.paseo.orchestrator.split('/').slice(1).join('/') }, routableProviders: [], groups: [], failures: [] }),
          validateModel: async () => { throw new Error('Configure role models in the Paseo plugin host configuration') },
        }, { stateDir: parsed.stateDir, workspaceDir: parsed.workspaceDir, paseo: parsed.paseo, localRequests: true,
          promptMaxChars: { get: () => parsed.promptMaxChars },
          admissionContextMaxPages: { get: () => parsed.admissionContextMaxPages },
          admissionContextTimeoutMs: { get: () => parsed.admissionContextTimeoutMs },
        }, () => { state = { phase: 'error', detail: 'Setup changed; reload the Superagent plugin to apply it' }; void stop() })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error
        if (Date.now() >= deadline) throw new Error('Superagent state directory is still owned by another host; stop that host before reloading this plugin')
        await delay(Math.min(250, deadline - Date.now()), undefined, { signal: cancelled.signal })
      }
    }
    if (cancelled.signal.aborted) { await runtime.stop(); return }
    await runtime.ready
    if (!cancelled.signal.aborted) state = runtime.configured() ? { phase: 'ready' }
      : { phase: 'needs_setup', detail: runtime.setupProblem?.detail }
    // The canvas reads the same locked Store; it starts after the database is open and stops before it closes.
    if (parsed.flowWeb?.enabled && runtime && !cancelled.signal.aborted) {
      flowWeb = await startFlowWebServer({ stateDir: parsed.stateDir, port: parsed.flowWeb.port,
        status: () => ({ phase: state.phase, ...(state.detail ? { detail: state.detail } : {}) }),
        store: runtime.store,
        staticDir: packagePath('lib', 'flow-web'),
        transcript: async sessionKey => {
          const bound = runtime?.store.get<{ agentId?: string }>(`paseo-session:${sessionKey}`)
          const agentId = typeof bound?.agentId === 'string' ? bound.agentId : null
          if (!agentId || !backendRef) {
            return { sessionKey, agentId, status: 'unavailable', reason: 'session_not_currently_bound',
              note: 'Only currently bound sessions have live Paseo transcript access; historical Assignment Worker identities come from confirmed create intents.', entries: [], truncated: false }
          }
          try {
            const raw = (await backendRef.transcript(sessionKey)).filter((entry): entry is NonNullable<typeof entry> => !!entry)
            const sliced = raw.slice(-60)
            return { sessionKey, agentId, status: 'ok',
              note: 'Supplementary live Paseo transcript (omits reasoning and per-entry timestamps).',
              entries: sliced.map(entry => ({
                id: entry.id,
                type: entry.type,
                role: entry.message?.role ?? 'unknown',
                text: (entry.message?.content ?? []).map(part => ('text' in part && typeof part.text === 'string' ? part.text : '')).join('\n').slice(0, 400),
              })),
              truncated: raw.length > sliced.length }
          } catch (error) {
            return { sessionKey, agentId, status: 'unavailable',
              reason: error instanceof Error ? error.message : String(error),
              note: 'Live Paseo transcript could not be read; local SQLite records remain authoritative.', entries: [], truncated: false }
          }
        } })
    }
  })().catch(async error => {
    if (!cancelled.signal.aborted) state = { phase: 'error', detail: error instanceof Error ? error.message : String(error) }
    await runtime?.stop()
    if (!cancelled.signal.aborted) throw error
  })
  // The plugin observes status even when no caller awaits ready.
  void ready.catch(() => {})
  function stop(budgetMs = 1000) {
    if (!stopping) {
      cancelled.abort()
      if (state.phase !== 'error') state = { phase: 'stopping' }
      // Start cancellation now, including while runtime.ready is pending.
      const final = runtime?.stop()
      stopping = (async () => {
        await ready.catch(() => {})
        // Close the reader first so no in-flight request can touch a closing database.
        await flowWeb?.close().catch(() => {}); flowWeb = undefined
        await final; await runtime?.stop(); state = { phase: 'stopped' }
      })()
    }
    return waitForHostStop(stopping, budgetMs)
  }
  return { ready, status: () => ({ ...state }), flowWeb: () => flowWeb?.url, stop }
}
