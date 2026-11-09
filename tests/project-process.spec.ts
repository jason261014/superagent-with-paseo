import { fork } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { spawnProjectProcess, type ProjectProcess } from '../src/projects/process.ts'
import { createProjectRegistry } from '../src/projects/registry.ts'
import { createProjectFixture } from './fixtures/projects.ts'

const fixtures: ReturnType<typeof createProjectFixture>[] = [], children: ProjectProcess[] = []
afterEach(async () => { await Promise.all(children.splice(0).map(child => child.stop(3000))); for (const fixture of fixtures.splice(0)) fixture.dispose() })
function setup() {
  const fixture = createProjectFixture(['alpha', 'beta']); fixtures.push(fixture)
  fixture.config.childEntry = resolve('src/projects/child.ts')
  fixture.config.runtimeEntry = resolve('tests/fixtures/project-runtime.mjs')
  const registry = createProjectRegistry(fixture.config)
  const options = (id: string) => ({ project: registry.get(id), generation: randomUUID(),
    nodeExecutable: process.execPath, childEntry: fixture.config.childEntry,
    runtimeEntry: fixture.config.runtimeEntry, logDirectory: join(fixture.directory, 'logs') })
  const start = (id: string) => { const child = spawnProjectProcess(options(id)); children.push(child); return child }
  return { ...fixture, options, start }
}
it('uses independent real Node processes and leaves the parent environment unchanged', async () => {
  const fixture = setup(), original = process.env.PATH
  const alpha = fixture.start('alpha'), beta = fixture.start('beta')
  await Promise.all([alpha.ready, beta.ready])
  expect(alpha.pid).not.toBe(beta.pid); expect(process.env.PATH).toBe(original)
  const data = (id: string) => JSON.parse(readFileSync(join(fixture.stateDir(id), 'process.json'), 'utf8'))
  expect(data('alpha').git).toBe(realpathSync(fixture.stateDir('alpha')) + '/worker-gitconfig')
  expect(data('beta').path).not.toContain(fixture.stateDir('alpha'))
  expect(await alpha.stop()).toEqual({ closed: true })
  expect(beta.status().phase).toBe('ready')
})
it('cancels startup and waits for actual exit after a cleanup deadline', async () => {
  const fixture = setup()
  writeFileSync(join(fixture.stateDir('alpha'), 'control.json'), JSON.stringify({ delay: 10_000 }))
  const alpha = fixture.start('alpha')
  expect(await alpha.stop(1000)).toEqual({ closed: true })
  await expect(alpha.ready).rejects.toThrow()
  writeFileSync(join(fixture.stateDir('beta'), 'control.json'), JSON.stringify({ holdStop: true }))
  const beta = fixture.start('beta'); await beta.ready
  expect(await beta.stop(10)).toEqual({ closed: false, reason: 'deadline' })
  expect(() => process.kill(beta.pid!, 0)).not.toThrow()
  await beta.closed
  expect(beta.status().phase).toBe('stopped')
})
it('exits its child after the actual parent is killed', async () => {
  const fixture = setup(), launcher = join(fixture.directory, 'launcher.mjs')
  writeFileSync(launcher, `import {spawnProjectProcess} from ${JSON.stringify(pathToFileURL(resolve('src/projects/process.ts')).href)};
    const child=spawnProjectProcess(${JSON.stringify(fixture.options('alpha'))});
    await child.ready; process.send({pid:child.pid}); setInterval(()=>{},1000);`)
  const parent = fork(launcher, [], { execArgv: ['--experimental-transform-types'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let childPid: number | undefined
  try {
    const [message] = await once(parent, 'message', { signal: AbortSignal.timeout(5000) })
    childPid = message.pid
    const exited = once(parent, 'exit'); parent.kill('SIGKILL'); await exited
    await vi.waitFor(() => expect(() => process.kill(childPid!, 0)).toThrow(), { timeout: 4000 })
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
    if (childPid) try { process.kill(childPid, 'SIGKILL') } catch {}
  }
}, 10_000)
it('bounds child output and rejects repeated initialization without leaving a live process', async () => {
  const fixture = setup()
  writeFileSync(join(fixture.stateDir('alpha'), 'control.json'), JSON.stringify({ outputBytes: 3 * 1024 * 1024 }))
  const alpha = fixture.start('alpha'); await alpha.ready
  await alpha.stop(2000)
  for (const suffix of ['', '.1']) {
    const file = join(fixture.directory, 'logs', 'alpha.log' + suffix)
    if (existsSync(file)) { expect(statSync(file).size).toBeLessThanOrEqual(1 << 20); expect(statSync(file).mode & 0o077).toBe(0) }
  }
  const options = fixture.options('beta')
  const child = fork(options.childEntry, [], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const identity = { version: 1, projectId: 'beta', generation: options.generation }
  const init = { ...identity, type: 'init', config: options.project.hostConfig, runtimeEntry: options.runtimeEntry }
  try {
    const ready = once(child, 'message', { signal: AbortSignal.timeout(5000) }); child.send(init); await ready
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(4000) })
    child.send(init)
    expect((await exited)[0]).toBe(1)
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
})
