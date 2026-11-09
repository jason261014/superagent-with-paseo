export const hostMode = 'managed'
export const managerConfig = {
  managerDir: '/Users/anxiaojie/.dsh/state/superagent-manager',
  nodeExecutable: '/Users/anxiaojie/.nvm/versions/node/v24.13.0/bin/node',
  childEntry: '/Users/anxiaojie/src/superagent-with-paseo/lib/paseo-project-child.js',
  runtimeEntry: '/Users/anxiaojie/src/superagent-with-paseo/lib/paseo-host.js',
  legacyProjectId: 'legacy',
  projects: [{
    id: 'legacy',
    label: 'oss-explore',
    root: '/Users/anxiaojie/src/oss-explore',
    enabled: true,
    hostConfig: {
      stateDir: '/Users/anxiaojie/.dsh/state/sa-paseo-check',
      paseo: {
        url: 'ws://127.0.0.1:6767/ws',
        orchestrator: 'claude-pool/friday-deepseek-v4-flash',
        worker: 'claude-pool/friday-deepseek-v4-flash',
        orchestratorMode: 'auto',
        workerMode: 'auto',
        bridgeNode: '/Users/anxiaojie/.nvm/versions/node/v24.13.0/bin/node',
        bridgeCommand: '/Users/anxiaojie/src/superagent-with-paseo/bin/superagent-mcp.mjs',
      },
      flowWeb: { enabled: true, port: 17890 },
    },
  }],
}
