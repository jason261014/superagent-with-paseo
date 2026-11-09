import { expect, it, vi } from 'vitest'
import { waitForHostStop } from '../src/hosts/lifecycle.ts'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createPaseoHost } from '../src/hosts/paseo.ts'
import { Store } from '../src/app/store.ts'
it('reports deadline without completing or releasing the underlying resources', async () => {
  vi.useFakeTimers()
  try {
    let finish!: () => void
    const stopped = new Promise<void>(resolve => { finish = resolve }), closed = vi.fn()
    void stopped.then(closed)
    const pending = waitForHostStop(stopped, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toEqual({ closed: false, reason: 'deadline' })
    expect(closed).not.toHaveBeenCalled()
    finish(); expect(await waitForHostStop(stopped, 1000)).toEqual({ closed: true })
    expect(closed).toHaveBeenCalledOnce()
  } finally { vi.useRealTimers() }
})
it('keeps SQLite ownership across a timed-out stop until a real child effect has finished writing', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'sa-handoff-'))
  const child = fork(resolve('tests/fixtures/host-lifecycle-child.ts'), [stateDir], {
    execArgv: ['--experimental-transform-types'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk })
  const message = async () => {
    const [value] = await once(child, 'message', { signal: AbortSignal.timeout(5000) }).catch(error => { throw new Error(String(error) + stderr) })
    return value
  }
  const config = { stateDir, paseo: { url: 'ws://127.0.0.1:6767/ws', orchestrator: 'codex', worker: 'codex',
    orchestratorMode: 'read-only', workerMode: 'read-only', bridgeNode: process.execPath, bridgeCommand: resolve('bin/superagent-mcp.mjs') } }
  try {
    expect(await message()).toBe('entered')
    const deadline = message(); child.send('stop')
    expect(await deadline).toEqual({ closed: false, reason: 'deadline' })
    expect(existsSync(stateDir + '.lock')).toBe(true)
    const second = createPaseoHost(config, { lockWaitMs: 0, runWorker: async () => '' })
    await expect(second.ready).rejects.toThrow('still owned'); await second.stop()
    const final = message(); child.send('release'); expect(await final).toBe('closed')
    expect(existsSync(stateDir + '.lock')).toBe(false)
    const store = new Store(join(stateDir, 'orchestrator.sqlite'))
    expect(store.get('late-effect-write')).toBe('complete'); store.close()
    const successor = createPaseoHost(config); await successor.ready; await successor.stop()
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
    rmSync(stateDir, { recursive: true, force: true })
  }
}, 15000)
