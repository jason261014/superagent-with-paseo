/** Cordis registration and the original native-session backend. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { Machine } from '../deployment.ts'
import type { SourceHost } from '../sources/host.ts'
import type { BackendServices, RuntimeBackend, RuntimeHost } from './contracts.ts'
import { Runtime } from '../app/runtime.ts'
import { Sessions } from '../app/sessions.ts'
import { DshExecutor } from '../executor/dsh.ts'
import { workerSessionId } from '../executor/shared.ts'
import { runAsWorker } from '../infra/environment.ts'
import { createPaseoBackend } from '../paseo/backend.ts'
import { registerHttp } from '../app/http.ts'
import { resolveRoleModel } from '../app/role-models.ts'
import { transcriptEntry } from '../app/context.ts'
import { mainTools } from '../app/tools/main.ts'
import { executorTools } from '../app/tools/executor.ts'
import { repliedTo } from '../app/links.ts'

declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }

function nativeBackend(ctx: Context, services: BackendServices): RuntimeBackend {
  const { runtime, health, sourceLink, closing, paused } = services
  const { store, prompts, effects, masterId, machine, lifetime, sources } = runtime
  const environment = runtime.ticketEnvironment.bind(runtime)
  const sessions = new Sessions({ context: ctx, store, prompts, effects, health: health.claim('models'), masterId, lifetime,
    closing, environment,
    tools: (agent, ticket) => ticket ? executorTools(services.tools(), ticket) : mainTools(services.tools(), { id: agent.id,
      readImage: (source, commands, message, key, signal) => source.image(agent, commands, message, key, machine.stateDir, signal) }) })
  const executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: health.claim('worker'), machine,
    lifetime, sessions, closing, paused, environment, sourceLink, repliedTo: trigger => repliedTo({ store, sources }, trigger) })
  return { sessions, executor,
    transcript: async id => (await ctx.sessionController.inspect(id as SessionId)).events.map(transcriptEntry),
    async start() {},
    async quiesce() {
      const ids = [masterId, ...store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled(agents.map(agent => agent.whenIdle()))
    },
    async stop() { await executor.shutdown(); executor.dispose(); sessions.dispose(); await ctx.sessionPersistence.flush() },
  }
}

export function createDshRuntime(ctx: Context, machine: Machine, restart: () => void): Runtime {
  const host: RuntimeHost = {
    logger: ctx.logger,
    runWorker: ({ argv, cwd, signal, env }) => runAsWorker(ctx.subprocess, [...argv], cwd, signal, env),
    backend: services => machine.paseo ? createPaseoBackend(services) : nativeBackend(ctx, services),
    modelCatalog: () => {
      if (machine.paseo) throw new Error('Paseo models are configured in the profile paseo section; DSH model settings do not apply')
      return ctx.sessionController.modelCatalog()
    },
    validateModel: model => machine.paseo ? Promise.reject(new Error('Configure Paseo role models in the profile paseo section')) : resolveRoleModel(ctx, model),
    mountHttp: http => registerHttp(ctx, Object.assign(http, { models: () => ctx.sessionController.modelCatalog() })),
  }
  const unprovide = ctx.provide('orchestrator')
  let runtime: Runtime | undefined
  try {
    runtime = new Runtime(host, machine, restart)
    ctx.set('orchestrator', runtime)
    return runtime
  } catch (error) {
    unprovide()
    void runtime?.stop().catch(error => ctx.logger.error('Superagent cleanup failed: %s', String(error)))
    throw error
  }
}
