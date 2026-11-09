import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ProjectManagerConfig } from '../../src/projects/config.ts'

export function createProjectFixture(ids: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'sa-multi-'))
  const root = (id: string) => join(directory, id)
  const stateDir = (id: string) => join(directory, id + '-state')
  for (const id of ids) { mkdirSync(root(id), { mode: 0o700 }); mkdirSync(stateDir(id), { mode: 0o700 }) }
  const config: ProjectManagerConfig = {
    managerDir: join(directory, 'manager'), nodeExecutable: process.execPath,
    childEntry: resolve('bin/superagent-local.mjs'), runtimeEntry: resolve('bin/superagent-mcp.mjs'),
    projects: ids.map(id => ({ id, label: id, root: root(id), enabled: true, hostConfig: {
      stateDir: stateDir(id), paseo: { url: 'ws://127.0.0.1:6767/ws', orchestrator: 'codex', worker: 'codex',
        orchestratorMode: 'read-only', workerMode: 'read-only', bridgeNode: process.execPath, bridgeCommand: resolve('bin/superagent-mcp.mjs') },
    } })),
  }
  return { directory, root, stateDir, config, dispose: () => rmSync(directory, { recursive: true, force: true }) }
}
