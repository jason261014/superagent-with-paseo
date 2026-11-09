/** Minimal worker command port, also usable outside a DSH subprocess service. */
import { spawn } from 'node:child_process'
import { CliError } from './commands.ts'

export interface WorkerCommand {
  argv: readonly string[]
  cwd: string
  signal: AbortSignal
  env?: Record<string, string>
}
export type RunWorkerCommand = (command: WorkerCommand) => Promise<string>

/** Match the existing DSH ambient scrub; intentional per-task values are merged afterwards. */
export function workerEnvironment(ambient: NodeJS.ProcessEnv, explicit: Record<string, string> = {}): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(ambient).filter((entry): entry is [string, string] => entry[1] !== undefined
    && !/KEY|PASSWORD|SECRET|TOKEN/i.test(entry[0]) && !entry[0].toUpperCase().startsWith('DSH_'))), ...explicit }
}

/** Cancellation waits for the owned child's exit; neither argv nor environment values enter errors. */
export function createNodeWorkerRunner(): RunWorkerCommand {
  return async ({ argv, cwd, signal, env }) => {
    signal.throwIfAborted()
    if (!argv[0]) throw new Error('Worker command is empty')
    return new Promise<string>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, shell: false, detached: process.platform !== 'win32',
        env: workerEnvironment(process.env, env), stdio: ['ignore', 'pipe', 'pipe'] })
      const output: Buffer[] = [], errors: Buffer[] = []
      let stdoutBytes = 0, stderrBytes = 0, failure: Error | undefined, escalation: ReturnType<typeof setTimeout> | undefined
      const kill = (value: NodeJS.Signals) => {
        if (!child.pid) return
        try { if (process.platform === 'win32') child.kill(value); else process.kill(-child.pid, value) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error as Error }
      }
      const terminate = (error: Error) => {
        failure ??= error
        kill('SIGTERM')
        escalation ??= setTimeout(() => kill('SIGKILL'), 250)
      }
      const abort = () => terminate(new DOMException('Worker command aborted', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length
        if (stdoutBytes > 1 << 20) terminate(new CliError('Worker command exceeded stdout limit'))
        else output.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length
        if (stderrBytes > 1 << 16) terminate(new CliError('Worker command exceeded stderr limit'))
        else errors.push(chunk)
      })
      child.once('error', error => { failure ??= error })
      child.once('close', code => {
        signal.removeEventListener('abort', abort)
        if (escalation) clearTimeout(escalation)
        if (failure) reject(failure)
        else if (code === 0) resolve(Buffer.concat(output).toString('utf8'))
        else reject(new CliError(Buffer.concat(errors).toString('utf8').trim() || 'Worker command did not complete', undefined, code ?? undefined))
      })
    })
  }
}
