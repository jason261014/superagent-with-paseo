import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { ProjectIdSchema } from './config.ts'
import type { ProjectDesired } from './protocol.ts'

const Schema = z.strictObject({ version: z.literal(1), projects: z.record(ProjectIdSchema, z.enum(['running', 'stopped'])) })
export interface ProjectIntents {
  get(id: string): ProjectDesired
  set(id: string, desired: 'running' | 'stopped'): Promise<void>
  flush(): Promise<void>
}
export function openProjectIntents(directory: string): ProjectIntents {
  const path = join(directory, 'intents.json')
  let values = new Map<string, 'running' | 'stopped'>()
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o177)) throw new Error('PROJECT_UNSAFE_INTENTS')
    values = new Map(Object.entries(Schema.parse(JSON.parse(readFileSync(path, 'utf8'))).projects))
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return {
    get: id => values.get(id) ?? 'dormant',
    async set(id, desired) {
      ProjectIdSchema.parse(id)
      const updated = new Map(values); updated.set(id, desired)
      const temporary = join(directory, 'intents-' + randomUUID()), descriptor = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(descriptor, JSON.stringify({ version: 1, projects: Object.fromEntries(updated) }))
        fsyncSync(descriptor); renameSync(temporary, path)
        const parent = openSync(directory, 'r')
        try { fsyncSync(parent) } finally { closeSync(parent) }
        values = updated
      } finally { closeSync(descriptor); try { unlinkSync(temporary) } catch {} }
    },
    async flush() {},
  }
}
