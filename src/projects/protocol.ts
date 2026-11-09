import { z } from 'zod'
import { HostConfigSchema } from '../hosts/paseo-config.ts'
import type { HostStatus, HostStop } from '../hosts/lifecycle.ts'
import { ProjectIdSchema } from './config.ts'

export const HostStatusSchema = z.strictObject({
  phase: z.enum(['starting', 'needs_setup', 'ready', 'stopping', 'stopped', 'error']),
  detail: z.string().optional(),
})
const identity = { version: z.literal(1), projectId: ProjectIdSchema, generation: z.string().uuid() }
export const ProjectCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...identity, type: z.literal('init'), runtimeEntry: z.string(), config: HostConfigSchema }),
  z.strictObject({ ...identity, type: z.literal('stop') }),
])
export const ProjectEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...identity, type: z.literal('status'), status: HostStatusSchema, flowWebUrl: z.string().optional() }),
  z.strictObject({ ...identity, type: z.literal('stopped') }),
])
export type ProjectCommand = z.input<typeof ProjectCommandSchema>
export type ProjectDesired = 'dormant' | 'running' | 'stopped'
export interface ProjectExit { code: number | null; signal: NodeJS.Signals | null }
export interface ProjectSnapshot {
  id: string; label: string; desired: ProjectDesired; enabled: boolean; host: HostStatus
  generation?: string; pid?: number; flowWebUrl?: string
}
export type ProjectAction = 'start' | 'stop' | 'restart'
export interface ProjectActionResult { accepted: true; project: ProjectSnapshot; stopped?: HostStop }
