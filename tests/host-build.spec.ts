import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, type RolldownChunk } from 'tsdown'
import { afterAll, beforeAll, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let directory: string
type CodeChunk = Extract<RolldownChunk, { type: 'chunk' }>
let chunks: CodeChunk[]
beforeAll(async () => {
  mkdirSync(join(root, '.artifacts'), { recursive: true })
  directory = mkdtempSync(join(root, '.artifacts', 'host-build-'))
  const bundles = await build({ config: join(root, 'tsdown.config.ts'), outDir: directory, dts: false, logLevel: 'silent' })
  chunks = bundles.flatMap(bundle => bundle.chunks).filter((chunk): chunk is CodeChunk => chunk.type === 'chunk')
}, 20_000)
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })

it('keeps DSH value modules out of every chunk reachable from the standalone host', () => {
  const seen = new Set<string>(), modules: string[] = []
  function visit(name: string) {
    if (seen.has(name)) return
    seen.add(name)
    const chunk = chunks.find(chunk => chunk.fileName === name)
    expect(chunk, name).toBeDefined()
    modules.push(...Object.keys(chunk!.modules))
    for (const imported of [...chunk!.imports, ...chunk!.dynamicImports]) {
      expect(imported).not.toContain('@deepseek-ai')
      if (chunks.some(chunk => chunk.fileName === imported)) visit(imported)
    }
  }
  visit('paseo-host.js')
  expect(modules.some(id => id.endsWith('/src/hosts/paseo.ts'))).toBe(true)
  expect(modules.filter(id => /@deepseek-ai|\/src\/(hosts\/dsh(?:-config)?|executor\/dsh|app\/(sessions|role-models))\.ts/.test(id))).toEqual([])
})

it('keeps application and database value modules out of project management and provider routing', () => {
  const seen = new Set<string>(), modules: string[] = [], imports: string[] = []
  function visit(name: string) {
    if (seen.has(name)) return
    seen.add(name)
    const chunk = chunks.find(chunk => chunk.fileName === name)
    expect(chunk, name).toBeDefined()
    modules.push(...Object.keys(chunk!.modules))
    for (const imported of [...chunk!.imports, ...chunk!.dynamicImports]) {
      imports.push(imported)
      if (chunks.some(chunk => chunk.fileName === imported)) visit(imported)
    }
  }
  visit('project-manager.mjs'); visit('provider.mjs'); visit('paseo-project-child.js')
  expect(modules.filter(id => /\/src\/app\/(runtime|store)\.ts|@deepseek-ai/.test(id))).toEqual([])
  expect(imports).not.toContain('node:sqlite')
})

it('boots the built host from another cwd with DSH resolution denied and reopens the same state', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'sa-built-'))
  const config = { stateDir, paseo: { url: 'ws://127.0.0.1:6767/ws', orchestrator: 'codex', worker: 'codex',
    orchestratorMode: 'read-only', workerMode: 'read-only', bridgeNode: process.execPath,
    bridgeCommand: join(root, 'bin/superagent-mcp.mjs') } }
  const script = `
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import { createPaseoHost } from ${JSON.stringify(pathToFileURL(join(directory, 'paseo-host.js')).href)};
    const config = ${JSON.stringify(config)};
    const adapter = { create: async input => ({ agentId: 'agent-orchestrator', cwd: input.cwd }), send: async () => {},
      findByLabels: async () => ({ kind: 'complete', matches: [] }), findMessage: async () => ({ kind: 'absent_confirmed', epoch: 'test' }),
      timeline: async () => ({ kind: 'complete', epoch: 'test', entries: [] }),
      snapshot: async agentId => ({ agentId, cwd: null, status: 'idle', activeTurn: null, pendingPermissions: [],
        observedAt: new Date().toISOString(), unknownChildren: true }),
      interrupt: async () => ({ requestSent: true, runtime: null }), archive: async () => ({ archivedAt: new Date().toISOString() }),
      close: async () => {} };
    let masterId;
    for (let attempt = 0; attempt < 2; attempt++) {
      const host = createPaseoHost(config, { createAdapter: () => adapter });
      try { await host.ready; assert.equal(host.status().phase, 'ready'); }
      finally { assert.deepEqual(await host.stop(2000), { closed: true }); }
      assert.equal(existsSync(config.stateDir + '.lock'), false);
      const db = new DatabaseSync(config.stateDir + '/orchestrator.sqlite', { readOnly: true });
      try {
        const id = db.prepare("SELECT value FROM kv WHERE key='master-id'").get().value;
        if (attempt) assert.equal(id, masterId);
        masterId = id;
      } finally { db.close(); }
    }
    console.log('standalone host reopened');
  `
  try {
    const result = await promisify(execFile)(process.execPath, [
      '--loader', join(root, 'tests/fixtures/reject-dsh-loader.mjs'), '--input-type=module', '-e', script,
    ], { cwd: tmpdir(), timeout: 15_000 })
    expect(result.stdout).toContain('standalone host reopened')
  } finally { rmSync(stateDir, { recursive: true, force: true }) }
}, 20_000)

it('builds the standalone flow canvas without DSH runtime or the DSH module loader', () => {
  const app = chunks.find(chunk => chunk.fileName === 'flow-web/app.js')
    ?? chunks.find(chunk => chunk.fileName.endsWith('app.js'))
  expect(app, 'flow-web/app.js').toBeDefined()
  const modules = Object.keys(app!.modules)
  expect(modules.some(id => /@deepseek-ai|\/src\/(client|paseo-ui|hosts|app)\//.test(id))).toBe(false)
  const code = app!.code
  expect(code).not.toContain('__ModuleLoader__')
  expect(app!.imports).toEqual([])
  expect(app!.dynamicImports).toEqual([])
  expect(modules.some(id => id.includes('@xyflow/react'))).toBe(true)
})
