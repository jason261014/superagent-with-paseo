/** Compose the existing Paseo execution path without loading the DSH execution backend. */
import { stat } from 'node:fs/promises'
import type { Ticket } from '../core/index.ts'
import type { BackendServices, RuntimeBackend, ExecutorPort } from '../hosts/contracts.ts'
import { PaseoExecutor } from '../executor/paseo.ts'
import { sourceTrigger, triggerMessage, ticketExecution, prepareWorkerDirectory, inputMessage, batchOf, batchLine } from '../executor/shared.ts'
import { PaseoSessions } from './sessions.ts'
import { PaseoToolBridge } from './bridge.ts'
import { PaseoReports } from './reports.ts'
import { createPaseoAdapter, type PaseoAdapter, type PaseoAdapterOptions } from './client.ts'
import { readPaseoTranscript } from './transcript.ts'
import { PaseoOperationJournal } from '../paseo-control/journal.ts'
import { mainTools } from '../app/tools/main.ts'
import { executorTools } from '../app/tools/executor.ts'

export function createPaseoBackend(services: BackendServices,
  createAdapter: (options: PaseoAdapterOptions) => PaseoAdapter = createPaseoAdapter): RuntimeBackend {
  const { runtime, sourceLink: link, runWorker } = services
  const { store, prompts, effects, masterId, machine, lifetime } = runtime
  const paseo = createAdapter({ url: machine.paseo!.url, lifetime })
  const journal = new PaseoOperationJournal(store.db)
  const environment = (ticket: Ticket) => runtime.ticketEnvironment(ticket)
  let reports: PaseoReports
  const bridge = new PaseoToolBridge(machine.stateDir, { store, lifetime, tools: (binding, requestId) => {
    if (binding.role === 'orchestrator') return mainTools(services.tools(), { id: binding.sessionId })
    const ticket = store.tickets.get(binding.ticketId)
    if (!ticket) throw new Error('Unknown worker ticket')
    return executorTools({ ...services.tools(), submitReport: (report, claim) =>
      reports.receive(binding.ticketId, binding.assignmentId, requestId, report, claim) }, ticket)
  } })
  const sessions = new PaseoSessions({ store, prompts, effects, masterId, stateDir: machine.stateDir,
    config: machine.paseo!, paseo, journal, bridge, lifetime, environment })
  const executor = new PaseoExecutor({ store, effects, journal, paseo, get engine() { return runtime.engine },
    createOptions: (ticket, assignment) => sessions.workerOptions(ticket, assignment),
    created: (ticket, assignment, id) => sessions.workerCreated(ticket, assignment, id),
    started: (ticket, assignment) => reports.replay(ticket, assignment),
    paused: () => services.paused() || services.closing(), maxWorkers: () => store.settings().executor.maxWorkers,
    prepareWorkspace: async ticket => {
      if (!await stat(ticket.execution!.directory).then(() => true, () => false)) {
        await prepareWorkerDirectory({ runWorker, store, environment, lifetime }, ticket)
      }
    },
    initialText: async ticket => {
      const trigger = sourceTrigger({ store }, ticket)
      return JSON.stringify({ ticket_id: ticket.id, title: ticket.title, directory: ticket.execution?.directory, assignment: ticket.execution?.assignment,
        ...(trigger ? { trigger: triggerMessage(trigger, await link(trigger)) } : {}), batch: batchOf({ store }, ticket).map(batchLine),
        ...(ticket.assignments.length > 1 ? { note: 'Continue this ticket from its existing files and reports. Read ticket/' + ticket.id + '/inputs before work; do not repeat completed actions.' } : {}) })
    },
    inputText: async (_ticket, input) => {
      const trigger = input.kind === 'trigger' ? store.triggers.get(input.triggerId) : undefined
      return inputMessage(input, trigger ? triggerMessage(trigger, await link(trigger)) : undefined) ?? 'Historical input; no new work.'
    } })
  const prepared: ExecutorPort = Object.assign(executor, { prepare: (ticket: Ticket, outcome: Parameters<ExecutorPort['prepare']>[1]) =>
    ({ ...ticket, execution: ticketExecution(ticket, outcome, store.settings(), machine.stateDir) }) })
  reports = new PaseoReports({ store, report: (ticket, assignment, report) => executor.report(ticket, assignment, report),
    relay: (id, text) => sessions.relay(id, text) })
  let opening: Promise<void> | undefined
  let quiescing: Promise<void> | undefined
  return { sessions, executor: prepared,
    transcript: id => readPaseoTranscript(paseo, sessions.agentId(id)),
    start: () => opening ??= bridge.start(),
    quiesce: () => quiescing ??= (async () => {
      // Stop only bound agents; closing the SDK after a short grace cancels pending requests.
      // Still await all callers before Runtime releases SQLite and its directory lock.
      let close: Promise<void> | undefined
      const timer = setTimeout(() => { close = paseo.close(); void close.catch(() => {}) }, 500)
      try {
        await Promise.all([
          (async () => { await opening?.catch(() => {}); await bridge.close() })(),
          sessions.shutdown(),
        ])
      } finally { clearTimeout(timer); await (close ?? paseo.close()) }
    })(),
    async stop() {
      await executor.shutdown()
      await paseo.close()
      executor.dispose(); sessions.dispose()
    },
  }
}
