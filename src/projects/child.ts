import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PaseoHost } from '../hosts/lifecycle.ts'
import { ProjectCommandSchema } from './protocol.ts'

const [major, minor] = process.versions.node.split('.').map(Number)
if (!process.send || process.versions.electron || !((major === 22 && minor! >= 19) || major! >= 24)) {
  console.error('PROJECT_CHILD_REQUIRES_SUPPORTED_NODE_IPC')
  process.exitCode = 1
} else {
  let identity: { version: 1; projectId: string; generation: string } | undefined
  let host: PaseoHost | undefined
  let initializing: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let stopped = false
  let statusTimer: ReturnType<typeof setInterval> | undefined
  let lastStatus = ''
  const initTimer = setTimeout(() => { void stop(1) }, 10_000)
  const send = (message: object) => { if (identity && process.connected) process.send?.({ ...identity, ...message }, () => {}) }
  const report = () => {
    if (!host || stopped) return
    const value = { type: 'status', status: host.status(), ...(host.flowWeb?.() ? { flowWebUrl: host.flowWeb() } : {}) }
    const serialized = JSON.stringify(value)
    if (serialized !== lastStatus) { lastStatus = serialized; send(value) }
  }
  function stop(exitCode = 0): Promise<void> {
    if (stopping) return stopping
    stopped = true
    clearTimeout(initTimer); clearInterval(statusTimer)
    const forced = setTimeout(() => process.exit(1), 1500)
    const earlyStop = host?.stop(1000)
    stopping = (async () => {
      await earlyStop
      await initializing?.catch(() => {})
      const result = await host?.stop(0)
      if (result && !result.closed) return
      send({ type: 'stopped' })
      clearTimeout(forced)
      process.exit(exitCode)
    })().catch(() => { process.exit(1) })
    return stopping
  }
  process.on('disconnect', () => { void stop() })
  process.on('SIGTERM', () => { void stop() })
  process.on('SIGINT', () => { void stop() })
  process.on('message', value => {
    const parsed = ProjectCommandSchema.safeParse(value)
    if (!parsed.success) { void stop(1); return }
    const message = parsed.data
    if (identity && (identity.projectId !== message.projectId || identity.generation !== message.generation)) return
    if (message.type === 'stop') { void stop(); return }
    if (initializing || stopped || !isAbsolute(message.runtimeEntry)) { void stop(1); return }
    identity = { version: 1, projectId: message.projectId, generation: message.generation }
    clearTimeout(initTimer)
    initializing = (async () => {
      const module = await import(pathToFileURL(message.runtimeEntry).href)
      if (stopped) return
      if (typeof module.createPaseoHost !== 'function') throw new Error('PROJECT_HOST_EXPORT_MISSING')
      host = module.createPaseoHost(message.config)
      statusTimer = setInterval(report, 250); statusTimer.unref()
      await host!.ready
      report()
    })()
    void initializing.catch(error => {
      send({ type: 'status', status: { phase: 'error', detail: error instanceof Error ? error.message : 'PROJECT_START_FAILED' } })
      void stop(1)
    })
  })
}
