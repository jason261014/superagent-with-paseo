import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createProjectRegistry } from '../src/projects/registry.ts'
import { resolvePluginOptions } from '../src/projects/config.ts'
import { createProjectFixture } from './fixtures/projects.ts'

const fixtures: ReturnType<typeof createProjectFixture>[] = []
const setup = () => { const fixture = createProjectFixture(['alpha', 'beta']); fixtures.push(fixture); return fixture }
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.dispose() })
it('matches canonical paths by component and longest registered root', () => {
  const fixture = setup()
  mkdirSync(join(fixture.root('alpha'), 'src'))
  mkdirSync(fixture.root('alpha') + '-other')
  const alias = join(fixture.directory, 'alias'); symlinkSync(fixture.root('alpha'), alias)
  const registry = createProjectRegistry(fixture.config)
  expect(registry.match(join(alias, 'src')).id).toBe('alpha')
  expect(() => registry.match(fixture.root('alpha') + '-other')).toThrow('PROJECT_NOT_REGISTERED')
  fixture.config.projects[1]!.root = join(fixture.root('alpha'), 'src')
  fixture.config.projects[1]!.enabled = false
  expect(() => createProjectRegistry(fixture.config).match(join(alias, 'src'))).toThrow('PROJECT_DISABLED')
})
it.each(['state', 'root', 'id', 'port'])('rejects duplicate %s ownership', kind => {
  const fixture = setup(), first = fixture.config.projects[0]!, second = fixture.config.projects[1]!
  if (kind === 'state') second.hostConfig.stateDir = first.hostConfig.stateDir
  if (kind === 'root') second.root = first.root
  if (kind === 'id') second.id = first.id
  if (kind === 'port') { first.hostConfig.flowWeb = { enabled: true, port: 17890 }; second.hostConfig.flowWeb = { enabled: true, port: 17890 } }
  expect(() => createProjectRegistry(fixture.config)).toThrow('PROJECT_DUPLICATE_')
})
it('keeps explicit aliases and rejects mixed managed configuration', () => {
  const fixture = setup()
  fixture.config.projects[0]!.aliases = [fixture.root('beta')]
  expect(() => createProjectRegistry(fixture.config)).toThrow('PROJECT_DUPLICATE_ROOT')
  expect(() => resolvePluginOptions({ hostMode: 'managed', managerConfig: fixture.config }, { SUPERAGENT_STATE_DIR: '/tmp/shared' })).toThrow('PROJECT_MANAGED_CONFIG_CONFLICT')
  expect(resolvePluginOptions({ hostMode: 'external', stateDir: fixture.stateDir('alpha') }, {})).toMatchObject({ mode: 'external' })
})
