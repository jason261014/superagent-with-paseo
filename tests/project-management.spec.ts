import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { localCall } from '../src/local/transport.ts'
import { createProjectManager } from '../src/projects/manager.ts'
import { main } from '../src/projects/cli.ts'
import { createProjectFixture } from './fixtures/projects.ts'

it('controls projects over the private socket without accepting configuration or starting on reads', async () => {
  const fixture = createProjectFixture(['alpha'])
  fixture.config.childEntry = resolve('src/projects/child.ts'); fixture.config.runtimeEntry = resolve('tests/fixtures/project-runtime.mjs')
  const manager = createProjectManager(fixture.config)
  try {
    await manager.ready
    const output: string[] = []
    await main(['--manager-dir', fixture.config.managerDir, 'list'], text => { output.push(text) })
    expect(JSON.parse(output[0]!).projects[0]).toMatchObject({ desired: 'dormant', host: { phase: 'stopped' } })
    await expect(localCall(fixture.config.managerDir, 'POST', '/projects/alpha/start', { stateDir: '/tmp/elsewhere' })).rejects.toThrow('PROJECT_INVALID_REQUEST')
    await expect(localCall(fixture.config.managerDir, 'GET', '/projects/unknown')).rejects.toThrow('PROJECT_NOT_REGISTERED')
    expect(await localCall(fixture.config.managerDir, 'POST', '/projects/alpha/start', {})).toMatchObject({ accepted: true })
    await manager.ensure('alpha')
    expect(await localCall(fixture.config.managerDir, 'POST', '/projects/alpha/stop', {})).toMatchObject({ stopped: { closed: true } })
    await expect(manager.ensure('alpha')).rejects.toThrow('PROJECT_MANUALLY_STOPPED')
  } finally { await manager.shutdown(3000); fixture.dispose() }
})
