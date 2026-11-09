export const hostMode = 'managed'
export const managerConfig = {
  managerDir: '/absolute/private/superagent-manager',
  nodeExecutable: '/absolute/path/to/node',
  childEntry: '/absolute/superagent-with-paseo/lib/paseo-project-child.js',
  runtimeEntry: '/absolute/superagent-with-paseo/lib/paseo-host.js',
  autoRegister: true,
  projectStateRoot: '/absolute/private/superagent-projects',
  projects: [
    {
      id: 'alpha', label: 'Alpha', root: '/absolute/projects/alpha', aliases: [], enabled: true,
      hostConfig: {
        stateDir: '/absolute/private/alpha-state',
        paseo: {
          url: 'ws://127.0.0.1:6767/ws',
          orchestrator: 'codex', worker: 'codex',
          orchestratorMode: 'read-only', workerMode: 'read-only',
          bridgeNode: '/absolute/path/to/node',
          bridgeCommand: '/absolute/superagent-with-paseo/bin/superagent-mcp.mjs',
        },
      },
    },
  ],
}
