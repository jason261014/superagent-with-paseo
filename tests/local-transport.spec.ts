import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { listenLocal, listenPrivate, localCall, localSocketPath, type LocalHost } from '../src/local/transport.ts'
import { main } from '../src/local/cli.ts'

const dirs: string[] = [], servers: Awaited<ReturnType<typeof listenLocal>>[] = []
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'sa-ipc-')); dirs.push(dir); return dir }
const host = (): LocalHost => ({ receive: vi.fn(() => 'stored' as const), replies: vi.fn(() => []),
  status: () => ({ configured: true, paused: false, accepting: true, actor: `uid:${process.getuid!()}` }) })
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('keeps the socket private and lets the CLI submit explicit identities and read without starting work', async () => {
  const dir = directory(), h = host(), output: string[] = []
  servers.push(await listenLocal(dir, h))
  expect(lstatSync(join(dir, 'local-ipc')).mode & 0o777).toBe(0o700)
  expect(lstatSync(localSocketPath(dir)).mode & 0o777).toBe(0o600)
  const run = (...args: string[]) => main(['--state-dir', dir, ...args], text => output.push(text))
  await run('status')
  await run('replies', '--thread-id', 'thread-1')
  expect(h.receive).not.toHaveBeenCalled()
  await run('submit', '--request-id', 'request-1', '--text', 'Hello')
  expect(h.receive).toHaveBeenCalledWith({ requestId: 'request-1', threadId: 'request-1', text: 'Hello' })
  expect(JSON.parse(output.at(-1)!)).toEqual({ requestId: 'request-1', threadId: 'request-1', result: 'stored' })
  await expect(run('submit', '--text', 'No identity')).rejects.toThrow('Usage:')
  await servers[0]!.close(); await servers[0]!.close()
  expect(existsSync(localSocketPath(dir))).toBe(false)
  await expect(run('status')).rejects.toThrow()
  expect(h.receive).toHaveBeenCalledTimes(1)
})

it('refuses unsafe directories and never replaces a file or symlink with a socket', async () => {
  const dir = directory(), ipc = join(dir, 'local-ipc')
  mkdirSync(ipc, { mode: 0o755 }); chmodSync(ipc, 0o755)
  await expect(listenLocal(dir, host())).rejects.toThrow('LOCAL_UNSAFE_DIRECTORY')
  chmodSync(ipc, 0o700)
  writeFileSync(localSocketPath(dir), 'preserve')
  await expect(listenLocal(dir, host())).rejects.toThrow('LOCAL_UNSAFE_SOCKET')
  rmSync(localSocketPath(dir)); rmSync(ipc, { recursive: true })
  const target = directory(); symlinkSync(target, ipc)
  await expect(listenLocal(dir, host())).rejects.toThrow('LOCAL_UNSAFE_DIRECTORY')
})

it('caps incoming bodies, blocks disabled input and propagates replay conflicts without retrying', async () => {
  const dir = directory(), h = host()
  servers.push(await listenLocal(dir, h))
  await expect(localCall(dir, 'POST', '/requests', { text: 'x'.repeat(600_000) })).rejects.toThrow()
  expect(h.receive).not.toHaveBeenCalled()
  vi.mocked(h.receive).mockImplementation(() => { throw new Error('LOCAL_REQUEST_CONFLICT') })
  await expect(localCall(dir, 'POST', '/requests', { requestId: 'id', text: 'new' })).rejects.toThrow('LOCAL_REQUEST_CONFLICT')
  expect(h.receive).toHaveBeenCalledTimes(1)
  h.status = () => ({ configured: true, paused: false, accepting: false, actor: 'uid:0' })
  await expect(localCall(dir, 'POST', '/requests', { requestId: 'id', text: 'new' })).rejects.toThrow('LOCAL_SOURCE_DISABLED')
  expect(h.receive).toHaveBeenCalledTimes(1)
})

it('waits for an asynchronous request to finish even after its client socket closes', async () => {
  const dir = directory(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const finished = vi.fn(), closed = vi.fn()
  const server = await listenPrivate(dir, 'local-ipc', async (_req, res) => {
    entered.resolve()
    await release.promise
    finished()
    res.end('{}')
  })
  servers.push(server)
  const request = localCall(dir, 'GET', '/held').catch(error => error)
  await entered.promise
  const stopping = server.close().then(closed)
  try {
    expect(await request).toBeInstanceOf(Error)
    expect(finished).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
  } finally { release.resolve(); await stopping }
  expect(finished).toHaveBeenCalledOnce()
  expect(closed).toHaveBeenCalledOnce()
})
