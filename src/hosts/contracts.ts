/** Dependencies supplied by a host; no Cordis service is required by the shared application. */
import type { Runtime } from '../app/runtime.ts'
import type { SessionPort } from '../paseo/sessions.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { ResourceHost } from '../app/resources.ts'
import type { LinkHost } from '../app/links.ts'
import type { MainToolsHost } from '../app/tools/main.ts'
import type { ExecutorToolsHost } from '../app/tools/executor.ts'
import type { HttpHost } from '../app/http.ts'
import type { SettingsHost } from '../app/settings.ts'
import type { RunWorkerCommand } from '../infra/worker-command.ts'
import type { HealthBoard } from '../infra/health.ts'

export interface HostLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}
export type ExecutorPort = Pick<DshExecutor, 'prepare' | 'start' | 'stop' | 'deliver' | 'install' | 'resume' | 'shutdown' | 'dispose' | 'activeCount'>
export interface BackendServices {
  runtime: Runtime
  links: LinkHost
  health: HealthBoard
  runWorker: RunWorkerCommand
  sourceLink: ResourceHost['sourceLink']
  tools(): MainToolsHost & ExecutorToolsHost
  closing(): boolean
  paused(): boolean
}
export interface RuntimeBackend {
  sessions: SessionPort
  executor: ExecutorPort
  transcript: ResourceHost['transcript']
  start(): Promise<void>
  quiesce(): Promise<void>
  stop(): Promise<void>
}
export interface RuntimeHost {
  runId?: string
  logger: HostLogger
  runWorker: RunWorkerCommand
  backend(services: BackendServices): RuntimeBackend
  modelCatalog: ResourceHost['modelCatalog']
  validateModel: NonNullable<SettingsHost['validateModel']>
  mountHttp?: (host: HttpHost) => () => void
}
