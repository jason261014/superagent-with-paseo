import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ProjectIdSchema } from './config.ts'

export const PaseoAgentIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
const Schema = z.strictObject({ version: z.literal(1), projects: z.record(ProjectIdSchema, PaseoAgentIdSchema) })

export interface ProjectEntryAgents {
  get(id: string): string | undefined
  set(id: string, agentId: string): Promise<void>
  flush(): Promise<void>
}

/** The latest Paseo conversation that launched each project, used as its next orchestrator parent. */
export function openProjectEntryAgents(directory: string): ProjectEntryAgents {
  const path = join(directory, 'entry-agents.json')
  let values = new Map<string, string>()
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o177)) throw new Error('PROJECT_UNSAFE_ENTRY_AGENTS')
    values = new Map(Object.entries(Schema.parse(JSON.parse(readFileSync(path, 'utf8'))).projects))
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let queue: Promise<void> = Promise.resolve()
  return {
    get: id => values.get(id),
    set(id, agentId) {
      queue = queue.then(async () => {
        ProjectIdSchema.parse(id); PaseoAgentIdSchema.parse(agentId)
        if (values.get(id) === agentId) return
        const updated = new Map(values); updated.set(id, agentId)
        const temporary = join(directory, 'entry-agents-' + randomUUID()), descriptor = openSync(temporary, 'wx', 0o600)
        try {
          writeFileSync(descriptor, JSON.stringify({ version: 1, projects: Object.fromEntries(updated) }))
          fsyncSync(descriptor); renameSync(temporary, path)
          const parent = openSync(directory, 'r')
          try { fsyncSync(parent) } finally { closeSync(parent) }
          values = updated
        } finally { closeSync(descriptor); try { unlinkSync(temporary) } catch {} }
      })
      return queue
    },
    flush: () => queue,
  }
}
