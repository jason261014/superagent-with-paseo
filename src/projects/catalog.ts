import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { ProjectDefinitionSchema, type ProjectDefinition } from './config.ts'

const Schema = z.strictObject({ version: z.literal(1), projects: z.array(ProjectDefinitionSchema) })

export interface ProjectCatalog {
  list(): readonly ProjectDefinition[]
  add(project: ProjectDefinition): Promise<void>
  remove(id: string): Promise<void>
}

/** Durable catalog for projects created from a Paseo workspace on first use. */
export function openProjectCatalog(directory: string): ProjectCatalog {
  const path = join(directory, 'projects.json')
  let values: ProjectDefinition[] = []
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o177)) throw new Error('PROJECT_UNSAFE_CATALOG')
    values = Schema.parse(JSON.parse(readFileSync(path, 'utf8'))).projects
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let queue: Promise<void> = Promise.resolve()
  const write = (update: (current: readonly ProjectDefinition[]) => readonly ProjectDefinition[]) => {
    queue = queue.then(async () => {
      const next = update(values)
      const temporary = join(directory, 'projects-' + randomUUID()), descriptor = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(descriptor, JSON.stringify({ version: 1, projects: next }))
        fsyncSync(descriptor); renameSync(temporary, path)
        const parent = openSync(directory, 'r')
        try { fsyncSync(parent) } finally { closeSync(parent) }
        values = [...next]
      } finally { closeSync(descriptor); try { unlinkSync(temporary) } catch {} }
    })
    return queue
  }
  return {
    list: () => [...values],
    add: project => write(current => [...current.filter(value => value.id !== project.id), project]),
    remove: id => write(current => current.filter(value => value.id !== id)),
  }
}
