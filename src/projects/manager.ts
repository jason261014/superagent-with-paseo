import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { lockSync } from 'proper-lockfile'
import { waitForHostStop, type HostStatus, type HostStop } from '../hosts/lifecycle.ts'
import { parseProjectManagerConfig, type ProjectManagerConfig } from './config.ts'
import { createProjectRegistry, type ProjectRegistry } from './registry.ts'
import { openProjectIntents, type ProjectIntents } from './intents.ts'
import { spawnProjectProcess, type ProjectProcess, type ProjectProcessFactory } from './process.ts'
import { listenProjectManagement } from './management.ts'
import type { ProjectAction, ProjectActionResult, ProjectSnapshot } from './protocol.ts'

export interface ProjectEndpoint { projectId: string; stateDir: string; status(): HostStatus }
export interface ProjectManager {
  readonly ready: Promise<void>
  registry: ProjectRegistry
  list(): ProjectSnapshot[]
  status(id: string): ProjectSnapshot
  ensure(id: string, budgetMs?: number): Promise<ProjectEndpoint>
  act(id: string, action: ProjectAction): Promise<ProjectActionResult>
  shutdown(budgetMs?: number): Promise<HostStop>
}
interface Entry {
  version: number
  process?: ProjectProcess
  generation?: string
  pending?: Promise<ProjectProcess | undefined>
  transition?: HostStatus
}
export function createProjectManager(input: ProjectManagerConfig, options: { processFactory?: ProjectProcessFactory } = {}): ProjectManager {
  const config = parseProjectManagerConfig(input), registry = createProjectRegistry(config)
  const createProcess = options.processFactory ?? spawnProjectProcess
  const entries = new Map(registry.list().map(project => [project.id, { version: 0 } as Entry]))
  let intents: ProjectIntents | undefined, release: (() => void) | undefined
  let listener: { close(): Promise<void> } | undefined
  let closing = false, finalStop: Promise<void> | undefined, ready: Promise<void>
  const cancelled = new AbortController()
  const status = (id: string): ProjectSnapshot => {
    const project = registry.get(id), entry = entries.get(id)!
    return { id, label: project.label, enabled: project.enabled, desired: intents?.get(id) ?? 'dormant',
      host: entry.transition ?? entry.process?.status() ?? { phase: 'stopped' },
      ...(entry.generation ? { generation: entry.generation } : {}),
      ...(entry.process?.pid ? { pid: entry.process.pid } : {}),
      ...(entry.process?.flowWebUrl() ? { flowWebUrl: entry.process.flowWebUrl() } : {}) }
  }
  const launch = (id: string, restart = false): Promise<ProjectProcess | undefined> => {
    const project = registry.get(id), entry = entries.get(id)!
    if (closing) return Promise.reject(new Error('PROJECT_MANAGER_STOPPING'))
    if (!project.enabled) return Promise.reject(new Error('PROJECT_DISABLED'))
    if (!restart && entry.pending) return entry.pending
    if (!restart && entry.process && !['error', 'stopped'].includes(entry.process.status().phase)) return Promise.resolve(entry.process)
    const version = entry.version
    const previous = entry.pending
    entry.transition = { phase: restart ? 'stopping' : 'starting' }
    const pending = (async () => {
      await previous?.catch(() => {})
      const current = entry.process
      if (current) { void current.stop(1000); await current.closed }
      if (closing || version !== entry.version || intents?.get(id) !== 'running') return
      registry.match(project.root)
      const generation = randomUUID()
      const process = createProcess({ project, generation, nodeExecutable: config.nodeExecutable,
        runtimeEntry: config.runtimeEntry, childEntry: config.childEntry, logDirectory: join(config.managerDir, 'logs') })
      entry.process = process; entry.generation = generation; entry.transition = undefined
      void process.ready.catch(() => {})
      return process
    })()
    entry.pending = pending
    void pending.catch(error => {
      if (!closing && version === entry.version) entry.transition = { phase: 'error', detail: error instanceof Error ? error.message : 'PROJECT_START_FAILED' }
    }).finally(() => { if (entry.pending === pending) entry.pending = undefined })
    return pending
  }
  const manager: ProjectManager = {
    get ready() { return ready }, registry,
    list: () => registry.list().map(project => status(project.id)), status,
    async ensure(id, budgetMs = 5000) {
      if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new Error('PROJECT_INVALID_BUDGET')
      const work = (async () => {
        await ready
        if (closing) throw new Error('PROJECT_MANAGER_STOPPING')
        const project = registry.get(id), entry = entries.get(id)!
        if (!project.enabled) throw new Error('PROJECT_DISABLED')
        if (intents!.get(id) === 'stopped') throw new Error('PROJECT_MANUALLY_STOPPED')
        if (entry.transition?.phase === 'error' && !entry.pending) throw new Error('PROJECT_RESTART_REQUIRED')
        if (entry.process && ['error', 'stopped'].includes(entry.process.status().phase) && !entry.pending) throw new Error('PROJECT_RESTART_REQUIRED')
        if (intents!.get(id) === 'dormant') await intents!.set(id, 'running')
        const process = await launch(id)
        if (!process) throw new Error('PROJECT_STOPPED')
        const observed = await process.ready
        if (closing || intents!.get(id) !== 'running') throw new Error('PROJECT_STOPPED')
        if (observed.phase !== 'ready') throw new Error(`PROJECT_${observed.phase.toUpperCase()}: ${observed.detail ?? '请检查项目配置'}`)
        return { projectId: id, stateDir: project.hostConfig.stateDir, status: () => status(id).host }
      })()
      return within(work, budgetMs)
    },
    async act(id, action) {
      await ready
      if (closing) throw new Error('PROJECT_MANAGER_STOPPING')
      const project = registry.get(id), entry = entries.get(id)!
      if (action !== 'stop' && !project.enabled) throw new Error('PROJECT_DISABLED')
      await intents!.set(id, action === 'stop' ? 'stopped' : 'running')
      if (closing) throw new Error('PROJECT_MANAGER_STOPPING')
      if (action === 'stop') {
        entry.version++; entry.transition = { phase: 'stopping' }
        const version = entry.version
        const process = entry.process
        void process?.closed.then(() => { if (version === entry.version) entry.transition = { phase: 'stopped' } })
        const stopped = process ? await process.stop(1000) : { closed: true as const }
        if (stopped.closed && entry.process === process) entry.transition = { phase: 'stopped' }
        return { accepted: true, project: status(id), stopped }
      }
      if (action === 'restart') entry.version++
      void launch(id, action === 'restart').catch(() => {})
      return { accepted: true, project: status(id) }
    },
    shutdown(budgetMs = 1000) {
      if (!finalStop) {
        closing = true; cancelled.abort()
        for (const entry of entries.values()) { entry.version++; void entry.process?.stop(1000) }
        finalStop = (async () => {
          await ready.catch(() => {})
          await listener?.close()
          await Promise.allSettled([...entries.values()].map(entry => entry.pending))
          await Promise.all([...entries.values()].flatMap(entry => entry.process ? [entry.process.closed] : []))
          await intents?.flush()
          release?.(); release = undefined
        })()
      }
      return waitForHostStop(finalStop, budgetMs)
    },
  }
  ready = (async () => {
    mkdirSync(config.managerDir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(config.managerDir)
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('PROJECT_UNSAFE_MANAGER')
    const deadline = Date.now() + 35_000
    for (;;) {
      cancelled.signal.throwIfAborted()
      try { release = lockSync(config.managerDir, { stale: 30_000, onCompromised: () => { console.error('PROJECT_MANAGER_LOCK_COMPROMISED'); void manager.shutdown().catch(() => {}) } }); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= deadline) throw error
        await delay(250, undefined, { signal: cancelled.signal })
      }
    }
    if (closing) return
    intents = openProjectIntents(config.managerDir)
    listener = await listenProjectManagement(manager, config.managerDir)
    if (closing) return
    for (const project of registry.list()) if (project.enabled && intents.get(project.id) === 'running') void launch(project.id).catch(() => {})
  })()
  void ready.catch(() => { void manager.shutdown().catch(() => {}) })
  return manager
}

async function within<Value>(work: Promise<Value>, budgetMs: number): Promise<Value> {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new Error('PROJECT_INVALID_BUDGET')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('PROJECT_STARTING')), budgetMs) })])
  } finally { clearTimeout(timer) }
}
