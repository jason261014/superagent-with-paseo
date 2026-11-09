import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parseProjectManagerConfig, type ProjectDefinition, type ProjectManagerConfig } from './config.ts'

export interface RegisteredProject extends ProjectDefinition { roots: readonly string[] }
export interface ProjectRegistry {
  list(): readonly RegisteredProject[]
  get(id: string): RegisteredProject
  match(cwd: string): RegisteredProject
  add(project: ProjectDefinition): RegisteredProject
  remove(id: string): void
}
export function createProjectRegistry(input: ProjectManagerConfig): ProjectRegistry {
  const config = parseProjectManagerConfig(input)
  for (const file of [config.nodeExecutable, config.childEntry, config.runtimeEntry]) {
    if (!statSync(file).isFile()) throw new Error('PROJECT_ENTRY_NOT_FILE')
  }
  accessSync(config.nodeExecutable, constants.X_OK)
  const projects: RegisteredProject[] = [], identities = new Set<string>(), states = new Set<string>(),
    roots = new Map<string, string>(), ports = new Set<number>()
  const directory = (path: string, state = false) => {
    const actual = realpathSync(path), stat = statSync(actual)
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (state && (stat.mode & 0o022))) throw new Error('PROJECT_UNSAFE_DIRECTORY')
    return actual
  }
  const add = (project: ProjectDefinition) => {
    if (identities.has(project.id)) throw new Error('PROJECT_DUPLICATE_ID')
    const root = directory(project.root), stateDir = directory(project.hostConfig.stateDir, true)
    if (states.has(stateDir)) throw new Error('PROJECT_DUPLICATE_STATE')
    const projectRoots = [...new Set([root, ...(project.aliases ?? []).map(path => directory(path))])]
    for (const path of projectRoots) {
      if (roots.has(path)) throw new Error('PROJECT_DUPLICATE_ROOT')
    }
    const workspaceDir = project.hostConfig.workspaceDir ? directory(project.hostConfig.workspaceDir) : root
    if (!projectRoots.some(path => contains(path, workspaceDir))) throw new Error('PROJECT_WORKSPACE_MISMATCH')
    const flow = project.hostConfig.flowWeb
    if (project.enabled && flow?.enabled && flow.port) {
      if (ports.has(flow.port)) throw new Error('PROJECT_DUPLICATE_PORT')
    }
    const registered: RegisteredProject = { ...project, root, roots: projectRoots,
      hostConfig: { ...project.hostConfig, stateDir, workspaceDir } }
    identities.add(project.id); states.add(stateDir)
    for (const path of projectRoots) roots.set(path, project.id)
    if (project.enabled && flow?.enabled && flow.port) ports.add(flow.port)
    projects.push(registered)
    return registered
  }
  for (const project of config.projects) add(project)
  const managerPath = (() => { try { return realpathSync(config.managerDir) } catch { return resolve(config.managerDir) } })()
  if (states.has(managerPath)) throw new Error('PROJECT_MANAGER_STATE_CONFLICT')
  if (config.legacyProjectId && !identities.has(config.legacyProjectId)) throw new Error('PROJECT_LEGACY_NOT_REGISTERED')
  const get = (id: string) => {
    const project = projects.find(project => project.id === id)
    if (!project) throw new Error('PROJECT_NOT_REGISTERED')
    return project
  }
  const remove = (id: string) => {
    const project = get(id), index = projects.indexOf(project)
    identities.delete(id); states.delete(project.hostConfig.stateDir)
    for (const root of project.roots) roots.delete(root)
    const flow = project.hostConfig.flowWeb
    if (project.enabled && flow?.enabled && flow.port) ports.delete(flow.port)
    projects.splice(index, 1)
  }
  return {
    list: () => projects, get, add, remove,
    match(cwd) {
      const actual = realpathSync(cwd)
      const matches = [...roots].filter(([root]) => contains(root, actual)).sort(([left], [right]) => right.length - left.length)
      if (!matches.length) throw new Error('PROJECT_NOT_REGISTERED')
      const project = get(matches[0]![1])
      if (!project.enabled) throw new Error('PROJECT_DISABLED')
      return project
    },
  }
}
function contains(root: string, cwd: string): boolean {
  const remainder = relative(root, cwd)
  return remainder === '' || (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith('..' + sep))
}
