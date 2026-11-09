import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function createPaseoHost(config) {
  let control = {}
  try { control = JSON.parse(readFileSync(join(config.stateDir, 'control.json'), 'utf8')) } catch {}
  let state = { phase: 'starting' }
  process.env.PATH = config.stateDir + '/worker-bin:' + process.env.PATH
  process.env.GIT_CONFIG_GLOBAL = config.stateDir + '/worker-gitconfig'
  writeFileSync(join(config.stateDir, 'process.json'), JSON.stringify({
    pid: process.pid, path: process.env.PATH, git: process.env.GIT_CONFIG_GLOBAL,
  }))
  if (control.outputBytes) process.stdout.write('x'.repeat(control.outputBytes))
  let finish
  const ready = new Promise(resolve => { finish = resolve })
  const timer = setTimeout(() => { if (state.phase === 'starting') state = { phase: control.phase ?? 'ready' }; finish() }, control.delay ?? 0)
  return {
    ready, status: () => state,
    async stop(budget = 1000) {
      state = { phase: 'stopping' }; clearTimeout(timer); finish()
      if (control.holdStop) {
        await new Promise(resolve => setTimeout(resolve, budget))
        return { closed: false, reason: 'deadline' }
      }
      writeFileSync(join(config.stateDir, 'stopped'), '')
      state = { phase: 'stopped' }
      return { closed: true }
    },
  }
}
