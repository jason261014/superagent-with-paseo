import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { AbsolutePathSchema, HostConfigSchema, type HostConfig } from '../hosts/paseo-config.ts'

export const ProjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
export const ProjectDefinitionSchema = z.strictObject({
  id: ProjectIdSchema, label: z.string().trim().min(1).max(120), root: AbsolutePathSchema,
  aliases: z.array(AbsolutePathSchema).default([]), enabled: z.boolean(),
  hostConfig: HostConfigSchema,
})
export const ProjectManagerConfigSchema = z.strictObject({
  managerDir: AbsolutePathSchema, nodeExecutable: AbsolutePathSchema,
  childEntry: AbsolutePathSchema, runtimeEntry: AbsolutePathSchema,
  legacyProjectId: ProjectIdSchema.optional(), projects: z.array(ProjectDefinitionSchema).min(1),
  autoRegister: z.boolean().default(true), projectStateRoot: AbsolutePathSchema.optional(),
})
export type ProjectDefinition = z.input<typeof ProjectDefinitionSchema>
export type ProjectManagerConfig = z.input<typeof ProjectManagerConfigSchema>
export function parseProjectManagerConfig(input: unknown): z.output<typeof ProjectManagerConfigSchema> {
  return ProjectManagerConfigSchema.parse(input)
}
export type PluginOptions =
  | { mode: 'external'; stateDir: string }
  | { mode: 'embedded'; stateDir: string; runtimeEntry: string; hostConfig: HostConfig }
  | { mode: 'managed'; managerConfig: ProjectManagerConfig }

export function resolvePluginOptions(source: Record<string, unknown>, env: NodeJS.ProcessEnv): PluginOptions {
  if (source.hostMode === 'managed') {
    if (env.SUPERAGENT_STATE_DIR?.trim() || ['stateDir', 'hostConfig', 'runtimeEntry'].some(key => source[key] != null))
      throw new Error('PROJECT_MANAGED_CONFIG_CONFLICT')
    return { mode: 'managed', managerConfig: parseProjectManagerConfig(source.managerConfig) }
  }
  if (source.managerConfig != null) throw new Error('PROJECT_MANAGER_MODE_REQUIRED')
  const stateDir = AbsolutePathSchema.parse(env.SUPERAGENT_STATE_DIR?.trim()
    || (typeof source.stateDir === 'string' && source.stateDir.trim()) || join(homedir(), '.dsh', 'state', 'sa-paseo-check'))
  if (source.hostMode === 'embedded') {
    const hostConfig = HostConfigSchema.parse(source.hostConfig)
    if (!env.SUPERAGENT_STATE_DIR?.trim() && hostConfig.stateDir !== stateDir)
      throw new Error('Superagent provider and host must use the same stateDir')
    return { mode: 'embedded', stateDir, runtimeEntry: AbsolutePathSchema.parse(source.runtimeEntry), hostConfig: { ...hostConfig, stateDir } }
  }
  if (source.hostMode != null && source.hostMode !== 'external') throw new Error('PROJECT_UNKNOWN_HOST_MODE')
  return { mode: 'external', stateDir }
}
