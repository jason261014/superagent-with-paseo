import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createNodeWorkerRunner, workerEnvironment } from '../src/infra/worker-command.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }) })
const dir = () => { const value = mkdtempSync(join(tmpdir(), 'sa-command-')); dirs.push(value); return value }
const run = createNodeWorkerRunner()
it('filters ambient secrets and preserves explicit task variables', () => {
  expect(workerEnvironment({ PATH: '/bin', LANG: 'en', GH_TOKEN: 'secret', DeepSeek_Api_Key: 'secret', dsh_session: 'old' },
    { DSH_SUPERAGENT_DIR: '/task' })).toEqual({ PATH: '/bin', LANG: 'en', DSH_SUPERAGENT_DIR: '/task' })
})
it('preserves exit status and passes argv without a shell', async () => {
  const cwd = dir(), signal = new AbortController().signal
  await expect(run({ cwd, signal, argv: [process.execPath, '-e', 'process.exit(7)'] })).rejects.toMatchObject({ exitCode: 7 })
  expect(await run({ cwd, signal, argv: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', '$(echo unsafe)'] })).toBe('$(echo unsafe)')
})
it.each(['stdout', 'stderr'])('terminates a process exceeding its %s capture bound', async stream => {
  await expect(run({ cwd: dir(), signal: new AbortController().signal,
    argv: [process.execPath, '-e', `process.${stream}.write('x'.repeat(2**22));setInterval(()=>{},1000)`] })).rejects.toThrow(`${stream} limit`)
})
it('waits for cancellation to terminate the actual child before settling', async () => {
  const cwd = dir(), controller = new AbortController(), pidFile = join(cwd, 'pid')
  const running = run({ cwd, signal: controller.signal, argv: [process.execPath, '-e',
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`] })
  const outcome = running.catch(error => error)
  let pid = 0
  try {
    await vi.waitFor(() => { pid = Number(readFileSync(pidFile, 'utf8')); expect(pid).toBeGreaterThan(0) })
    controller.abort()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(() => process.kill(pid, 0)).toThrow()
  } finally { controller.abort(); await outcome }
})
