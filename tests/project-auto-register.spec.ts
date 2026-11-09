import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createProjectManager, type ProjectManager } from '../src/projects/manager.ts'
import { spawnProjectProcess } from '../src/projects/process.ts'
import { createProjectFixture } from './fixtures/projects.ts'

const fixtures: ReturnType<typeof createProjectFixture>[] = [], managers: ProjectManager[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.shutdown(4000))); for (const fixture of fixtures.splice(0)) fixture.dispose() })
function setup() {
  const fixture = createProjectFixture(['alpha']); fixtures.push(fixture)
  fixture.config.legacyProjectId = 'alpha'
  fixture.config.childEntry = resolve('src/projects/child.ts')
  fixture.config.runtimeEntry = resolve('tests/fixtures/project-runtime.mjs')
  const processFactory = vi.fn(spawnProjectProcess)
  const create = () => { const manager = createProjectManager(fixture.config, { processFactory }); managers.push(manager); return manager }
  return { ...fixture, processFactory, create }
}
it('registers a workspace on first use and restores it after a manager restart', async () => {
  const fixture = setup(), workspace = join(fixture.directory, 'food-gui')
  mkdirSync(workspace, { mode: 0o700 })
  const first = fixture.create(); await first.ready
  const [project, duplicate] = await Promise.all([first.resolve(workspace), first.resolve(workspace)])
  expect(project.id).toMatch(/^auto-food-gui-[a-f0-9]{8}$/)
  expect(duplicate.id).toBe(project.id)
  expect(project.root).toBe(realpathSync(workspace))
  expect(project.hostConfig.stateDir).toBe(realpathSync(join(fixture.directory, 'superagent-projects', project.id)))
  expect(project.hostConfig.paseo).toEqual(fixture.config.projects[0]!.hostConfig.paseo)
  expect(project.hostConfig.flowWeb).toBeUndefined()
  expect(first.list().filter(item => item.id === project.id)).toHaveLength(1)
  await first.ensure(project.id)
  expect(first.status(project.id).host.phase).toBe('ready')
  const catalogPath = join(fixture.config.managerDir, 'projects.json')
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
  expect(catalog.version).toBe(1)
  expect(catalog.projects).toHaveLength(1)
  expect(catalog.projects[0]).toMatchObject({ id: project.id, root: realpathSync(workspace), enabled: true })
  expect(statSync(catalogPath).mode & 0o777).toBe(0o600)
  await first.shutdown(3000)
  const second = fixture.create(); await second.ready
  expect(second.status(project.id).desired).toBe('running')
  await second.ensure(project.id)
  expect(second.status(project.id).host.phase).toBe('ready')
  expect(fixture.processFactory).toHaveBeenCalledTimes(2)
})
it('matches an existing workspace subdirectory without creating another project', async () => {
  const fixture = setup(), workspace = join(fixture.directory, 'nested'), child = join(workspace, 'src')
  mkdirSync(workspace, { mode: 0o700 }); mkdirSync(child, { mode: 0o700 })
  const manager = fixture.create(); await manager.ready
  const project = await manager.resolve(workspace)
  expect((await manager.resolve(child)).id).toBe(project.id)
  expect(manager.list().filter(item => item.id.startsWith('auto-'))).toHaveLength(1)
})
it('can disable automatic registration', async () => {
  const fixture = setup(), workspace = join(fixture.directory, 'manual')
  mkdirSync(workspace, { mode: 0o700 })
  fixture.config.autoRegister = false
  const manager = fixture.create(); await manager.ready
  await expect(manager.resolve(workspace)).rejects.toThrow('PROJECT_NOT_REGISTERED')
  expect(manager.list().map(item => item.id)).toEqual(['alpha'])
})
