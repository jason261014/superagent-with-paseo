import { fork } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { workerEnvironment } from '../infra/worker-command.ts'
import { waitForHostStop, type HostStatus, type HostStop } from '../hosts/lifecycle.ts'
import type { RegisteredProject } from './registry.ts'
import { ProjectEventSchema, type ProjectExit } from './protocol.ts'

export interface ProjectProcess {
  readonly pid: number | undefined
  readonly ready: Promise<HostStatus>
  readonly closed: Promise<ProjectExit>
  status(): HostStatus
  flowWebUrl(): string | undefined
  stop(budgetMs?: number): Promise<HostStop>
}
export interface ProjectProcessOptions {
  project: RegisteredProject; generation: string; nodeExecutable: string
  runtimeEntry: string; childEntry: string; logDirectory: string
}
export type ProjectProcessFactory = (options: ProjectProcessOptions) => ProjectProcess

export function spawnProjectProcess(options: ProjectProcessOptions): ProjectProcess {
  let status: HostStatus = { phase: 'starting' }, flowWebUrl: string | undefined
  let ended = false, stopping = false, settled = false
  let soft: ReturnType<typeof setTimeout> | undefined, hard: ReturnType<typeof setTimeout> | undefined
  let resolveReady!: (value: HostStatus) => void, rejectReady!: (error: Error) => void
  const ready = new Promise<HostStatus>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void ready.catch(() => {})
  const log = projectLog(options.logDirectory, options.project.id)
  const child = fork(options.childEntry, [], {
    execPath: options.nodeExecutable, execArgv: [], cwd: options.project.root,
    env: workerEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'json', detached: process.platform !== 'win32',
  })
  const identity = { version: 1 as const, projectId: options.project.id, generation: options.generation }
  const signal = (value: NodeJS.Signals) => {
    if (ended || child.exitCode !== null || child.signalCode !== null) return
    try { child.kill(value) } catch {}
  }
  child.stdout?.on('data', chunk => log('stdout', chunk))
  child.stderr?.on('data', chunk => log('stderr', chunk))
  child.on('message', value => {
    const parsed = ProjectEventSchema.safeParse(value)
    if (!parsed.success || parsed.data.projectId !== identity.projectId || parsed.data.generation !== identity.generation || stopping || ended) return
    const message = parsed.data
    if (message.type !== 'status') return
    status = message.status; flowWebUrl = message.flowWebUrl
    if (!settled && ['ready', 'needs_setup', 'error'].includes(status.phase)) {
      settled = true
      if (status.phase === 'error') rejectReady(new Error(status.detail ?? 'PROJECT_START_FAILED'))
      else resolveReady(status)
    }
  })
  child.once('error', () => { status = { phase: 'error', detail: 'PROJECT_PROCESS_FAILED' }; if (!settled) { settled = true; rejectReady(new Error('PROJECT_PROCESS_FAILED')) } })
  const closed = new Promise<ProjectExit>(resolve => {
    child.once('close', (code, processSignal) => {
      ended = true; clearTimeout(soft); clearTimeout(hard)
      if (!settled) { settled = true; rejectReady(new Error(stopping ? 'PROJECT_STOPPED' : 'PROJECT_PROCESS_EXITED')) }
      status = stopping ? { phase: 'stopped' } : { phase: 'error', detail: status.detail ?? `PROJECT_PROCESS_EXITED (${code ?? processSignal})` }
      resolve({ code, signal: processSignal })
    })
  })
  child.send({ ...identity, type: 'init', runtimeEntry: options.runtimeEntry, config: options.project.hostConfig }, error => {
    if (error && !ended) { status = { phase: 'error', detail: 'PROJECT_INIT_FAILED' }; signal('SIGTERM') }
  })
  return {
    get pid() { return ended ? undefined : child.pid }, ready, closed, status: () => ({ ...status }), flowWebUrl: () => ended ? undefined : flowWebUrl,
    stop(budgetMs = 1000) {
      if (!stopping && !ended) {
        stopping = true; status = { phase: 'stopping' }
        if (child.connected) child.send({ ...identity, type: 'stop' }, () => {})
        else signal('SIGTERM')
        soft = setTimeout(() => signal('SIGTERM'), 1000)
        hard = setTimeout(() => signal('SIGKILL'), 2000)
      }
      return waitForHostStop(closed.then(() => {}), budgetMs)
    },
  }
}

function projectLog(directory: string, id: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const root = lstatSync(directory)
  if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o077)) throw new Error('PROJECT_UNSAFE_LOG_DIRECTORY')
  const file = join(directory, id + '.log'), previous = file + '.1'
  for (const path of [file, previous]) if (existsSync(path)) {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o177)) throw new Error('PROJECT_UNSAFE_LOG')
  }
  if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 })
  return (stream: string, value: Buffer) => {
    try {
      const text = `[${new Date().toISOString()} ${stream}] ` + value.subarray(0, 65_000).toString('utf8')
      if (statSync(file).size + Buffer.byteLength(text) > 1 << 20) {
        renameSync(file, previous); writeFileSync(file, '', { mode: 0o600 }); chmodSync(file, 0o600)
      }
      appendFileSync(file, text)
    } catch {}
  }
}
