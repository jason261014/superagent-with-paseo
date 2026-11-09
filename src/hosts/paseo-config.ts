import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { LIMITS } from '../limits.ts'

export const AbsolutePathSchema = z.string().trim().min(1).refine(value => isAbsolute(value) && !value.includes('\0'), 'Expected an absolute path')
const role = z.string().trim().min(1).refine(value => value.split('/')[0] !== 'superagent', 'Superagent cannot execute its own orchestration')
const limit = (bounds: { min: number; max: number }, fallback: number) => z.number().int().min(bounds.min).max(bounds.max).default(fallback)
export const HostConfigSchema = z.strictObject({
  stateDir: AbsolutePathSchema,
  workspaceDir: AbsolutePathSchema.optional(),
  paseo: z.strictObject({
    url: z.string().refine(value => {
      try {
        const url = new URL(value)
        return url.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
          && Number(url.port) > 0 && url.pathname === '/ws' && !url.username && !url.password && !url.search && !url.hash
      } catch { return false }
    }, 'Expected a loopback Paseo WebSocket URL'),
    orchestrator: role, worker: role, orchestratorMode: z.string().trim().min(1), workerMode: z.string().trim().min(1),
    bridgeCommand: AbsolutePathSchema, bridgeNode: AbsolutePathSchema,
  }),
  flowWeb: z.strictObject({
    enabled: z.boolean().default(false), host: z.literal('127.0.0.1').default('127.0.0.1'),
    port: z.number().int().min(0).max(65_535).default(17_890),
  }).optional(),
  promptMaxChars: limit(LIMITS.promptMaxChars, 100_000),
  admissionContextMaxPages: limit(LIMITS.admissionContextMaxPages, 10),
  admissionContextTimeoutMs: limit(LIMITS.admissionContextTimeoutMs, 15_000),
})
export type HostConfig = z.input<typeof HostConfigSchema>
