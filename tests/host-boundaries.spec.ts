import { expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/schemastery', () => { throw new Error('DSH schema loaded by a host-neutral module') })
it('loads deployment and shared execution without DSH configuration', async () => {
  const deployment = await import('../src/deployment.ts')
  const shared = await import('../src/executor/shared.ts')
  const host = await import('../src/hosts/paseo.ts')
  expect(deployment.GithubAccountsSchema.parse({}).repository).toBe('')
  expect(shared.workerSessionId('ticket-a')).toBe('worker-ticket-a')
  expect(typeof host.createPaseoHost).toBe('function')
})
