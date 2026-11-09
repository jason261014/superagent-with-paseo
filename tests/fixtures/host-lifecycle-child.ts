/** A real independent writer held in an effect during shutdown; controlled only by the parent test's IPC. */
import { Runtime } from '../../src/app/runtime.ts'
import { createPaseoBackend } from '../../src/paseo/backend.ts'
import { waitForHostStop } from '../../src/hosts/lifecycle.ts'
import type { PaseoAdapter } from '../../src/paseo/client.ts'

const stateDir = process.argv[2]!
const runtime = new Runtime({ runId: 'test-child', logger: console, runWorker: async () => '',
  backend: services => createPaseoBackend(services, () => ({ close: async () => {} } as PaseoAdapter)),
  modelCatalog: async () => { throw new Error('Unused catalog') }, validateModel: async () => { throw new Error('Unused model') },
}, { stateDir, promptMaxChars: { get: () => 100000 }, admissionContextMaxPages: { get: () => 10 }, admissionContextTimeoutMs: { get: () => 15000 },
  paseo: { url: 'ws://127.0.0.1:6767/ws', orchestrator: 'codex', worker: 'codex',
  orchestratorMode: 'read-only', workerMode: 'read-only', bridgeCommand: '/unused' } }, () => {})
await runtime.ready
let release!: () => void
const held = new Promise<void>(resolve => { release = resolve })
// Notice has an existing handler; a plain auxiliary queue kind exercises Runtime's real Effects drain.
runtime.effects.handle('delivery', async () => { process.send?.('entered'); await held; runtime.store.set('late-effect-write', 'complete') })
runtime.effects.enqueue('delivery', 'held', { ticketId: 'held' })
runtime.effects.start()
process.on('message', async message => {
  if (message === 'stop') process.send?.(await waitForHostStop(runtime.stop(), 20))
  if (message === 'release') { release(); await runtime.stop(); process.send?.('closed'); process.disconnect() }
})
