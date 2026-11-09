// Optional override for a DSH profile whose state directory is not the default.
export const stateDir: string | undefined = '/absolute/private/superagent-state'
// external: keep the existing DSH host; embedded: this plugin owns its local control plane.
export const hostMode: 'external' | 'embedded' = 'external'
export const runtimeEntry: string | undefined = '/absolute/superagent-with-paseo/lib/paseo-host.js'
export const hostConfig = {
  stateDir: stateDir!,
  paseo: {
    url: 'ws://127.0.0.1:6767/ws',
    orchestrator: 'codex', worker: 'codex', orchestratorMode: 'read-only', workerMode: 'read-only',
    bridgeNode: '/absolute/path/to/node', bridgeCommand: '/absolute/superagent-with-paseo/bin/superagent-mcp.mjs',
  },
  // Optional read-only flow canvas on 127.0.0.1; leave disabled to avoid reserving a port.
  flowWeb: { enabled: true, port: 17890 },
}
