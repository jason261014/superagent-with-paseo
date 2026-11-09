/** Cordis configuration adapter; ordinary hosts import deployment without loading Schemastery. */
import s from '@deepseek-ai/schemastery'
import { LIMITS } from '../limits.ts'
import type { Machine } from '../deployment.ts'
import type { PaseoConfig } from '../paseo/sessions.ts'

const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Volatile numeric limits apply on each use; changing stateDir, localRequests or paseo remounts the DSH plugin. */
export const Config: Schemastery<Record<string, unknown>, Omit<Machine, 'paseo'> & { paseo?: PaseoConfig | null }> = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  localRequests: s.boolean().default(false).description('Open the private local request socket. Source and Policy settings must also allow local requests. Requires a restart.'),
  paseo: s.union([s.const(null), s.object({
    url: s.string().default('ws://127.0.0.1:6767/ws'),
    orchestrator: s.string().required().description('Paseo provider/model for the coordinator.'),
    worker: s.string().required().description('Paseo provider/model for workers.'),
    orchestratorMode: s.string().required(), workerMode: s.string().required(),
    bridgeCommand: absolute('Path to bin/superagent-mcp.mjs in this checkout.').required(),
    bridgeNode: absolute('Node executable for new MCP bridges.'),
  })]).default(null).description('Opt-in Paseo session adapter. Omit to keep DSH sessions. Requires a restart.'),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, localRequests, paseo, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, localRequests, ...(paseo ? { paseo } : {}), promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

