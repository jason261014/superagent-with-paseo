import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createProjectManager, type ProjectManager } from '../src/projects/manager.ts'
import { spawnProjectProcess } from '../src/projects/process.ts'
import { createProjectFixture } from './fixtures/projects.ts'

const fixtures: ReturnType<typeof createProjectFixture>[] = [], managers: ProjectManager[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.shutdown(4000))); for (const fixture of fixtures.splice(0)) fixture.dispose() })
function setup(ids = ['alpha', 'beta', 'gamma']) {
  const fixture = createProjectFixture(ids); fixtures.push(fixture)
  fixture.config.childEntry = resolve('src/projects/child.ts')
  fixture.config.runtimeEntry = resolve('tests/fixtures/project-runtime.mjs')
  const processFactory = vi.fn(spawnProjectProcess)
  const create = () => { const manager = createProjectManager(fixture.config, { processFactory }); managers.push(manager); return manager }
  return { ...fixture, processFactory, create }
}
it('coalesces demand, keeps idle projects alive and remembers manual stop across restart', async () => {
  const fixture = setup(), first = fixture.create(); await first.ready
  expect(fixture.processFactory).not.toHaveBeenCalled()
  await Promise.all([first.ensure('alpha'), first.ensure('alpha')])
  expect(fixture.processFactory).toHaveBeenCalledTimes(1)
  await first.act('beta', 'stop')
  await expect(first.ensure('beta')).rejects.toThrow('PROJECT_MANUALLY_STOPPED')
  expect(first.status('alpha').host.phase).toBe('ready')
  await first.shutdown(3000)
  const second = fixture.create(); await second.ready; await second.ensure('alpha')
  expect(fixture.processFactory).toHaveBeenCalledTimes(2)
  expect(second.status('beta').desired).toBe('stopped')
  expect(second.status('gamma').desired).toBe('dormant')
  expect(JSON.parse(readFileSync(join(fixture.config.managerDir, 'intents.json'), 'utf8')).projects).toEqual({ alpha: 'running', beta: 'stopped' })
})
it('persists the entry conversation and restores it as the next project process parent', async () => {
  const fixture = setup(['alpha']), first = fixture.create(); await first.ready
  await first.ensure('alpha', 5000, 'entry-agent-1')
  expect(fixture.processFactory).toHaveBeenLastCalledWith(expect.objectContaining({ entryAgentId: 'entry-agent-1' }))
  expect(JSON.parse(readFileSync(join(fixture.config.managerDir, 'entry-agents.json'), 'utf8')).projects)
    .toEqual({ alpha: 'entry-agent-1' })
  await first.shutdown(3000)
  const second = fixture.create(); await second.ready
  await vi.waitFor(() => expect(second.status('alpha').host.phase).toBe('ready'))
  expect(fixture.processFactory).toHaveBeenCalledTimes(2)
  expect(fixture.processFactory).toHaveBeenLastCalledWith(expect.objectContaining({ entryAgentId: 'entry-agent-1' }))
})
it('does not revive a project when stop overtakes a pending restart', async () => {
  const fixture = setup(), manager = fixture.create(); await manager.ready
  await manager.ensure('alpha')
  await manager.act('alpha', 'restart')
  await manager.act('alpha', 'stop')
  await vi.waitFor(() => expect(manager.status('alpha').host.phase).toBe('stopped'))
  expect(fixture.processFactory).toHaveBeenCalledTimes(1)
})
it('uses one shutdown budget and isolates a crashed project', async () => {
  const fixture = setup(), manager = fixture.create(); await manager.ready
  for (const id of ['alpha', 'beta', 'gamma']) writeFileSync(join(fixture.stateDir(id), 'control.json'), JSON.stringify({ holdStop: true }))
  await Promise.all([manager.ensure('alpha'), manager.ensure('beta'), manager.ensure('gamma')])
  process.kill(manager.status('alpha').pid!, 'SIGKILL')
  await vi.waitFor(() => expect(manager.status('alpha').host.phase).toBe('error'))
  expect(manager.status('beta').host.phase).toBe('ready')
  await expect(manager.ensure('alpha')).rejects.toThrow('PROJECT_RESTART_REQUIRED')
  const began = Date.now()
  expect(await manager.shutdown(50)).toEqual({ closed: false, reason: 'deadline' })
  expect(Date.now() - began).toBeLessThan(300)
  expect(await manager.shutdown(3000)).toEqual({ closed: true })
})
it('cancels a second manager lock wait during cleanup', async () => {
  const fixture = setup(), first = fixture.create(); await first.ready
  const second = fixture.create()
  expect(await second.shutdown(1000)).toEqual({ closed: true })
  await first.ensure('alpha')
  expect(first.status('alpha').host.phase).toBe('ready')
})
it('does not start on an invalid waiting budget or overwrite a corrupt intent file', async () => {
  const fixture = setup(), first = fixture.create(); await first.ready
  await expect(first.ensure('alpha', -1)).rejects.toThrow('PROJECT_INVALID_BUDGET')
  expect(fixture.processFactory).not.toHaveBeenCalled()
  await first.shutdown(1000)
  writeFileSync(join(fixture.config.managerDir, 'intents.json'), '{broken', { mode: 0o600 })
  const second = fixture.create()
  await expect(second.ready).rejects.toThrow()
  await second.shutdown(1000)
  expect(readFileSync(join(fixture.config.managerDir, 'intents.json'), 'utf8')).toBe('{broken')
})
