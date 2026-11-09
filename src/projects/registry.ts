import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parseProjectManagerConfig, type ProjectDefinition, type ProjectManagerConfig } from './config.ts'

export interface RegisteredProject extends ProjectDefinition { roots: readonly string[] }
export interface ProjectRegistry {
  list(): readonly RegisteredProject[]
  get(id: string): RegisteredProject
  match(cwd: string): RegisteredProject
}
export function createProjectRegistry(input: ProjectManagerConfig): ProjectRegistry {
  const config = parseProjectManagerConfig(input)
  for (const file of [config.nodeExecutable, config.childEntry, config.runtimeEntry]) {
    if (!statSync(file).isFile()) throw new Error('PROJECT_ENTRY_NOT_FILE')
  }
  accessSync(config.nodeExecutable, constants.X_OK)
  const identities = new Set<string>(), states = new Set<string>(), roots = new Map<string, string>(), ports = new Set<number>()
  const directory = (path: string, state = false) => {
    const actual = realpathSync(path), stat = statSync(actual)
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (state && (stat.mode & 0o022))) throw new Error('PROJECT_UNSAFE_DIRECTORY')
    return actual
  }
  const projects = config.projects.map(project => {
    if (identities.has(project.id)) throw new Error('PROJECT_DUPLICATE_ID')
    identities.add(project.id)
    const root = directory(project.root), stateDir = directory(project.hostConfig.stateDir, true)
    if (states.has(stateDir)) throw new Error('PROJECT_DUPLICATE_STATE')
    states.add(stateDir)
    const projectRoots = [...new Set([root, ...project.aliases.map(path => directory(path))])]
    for (const path of projectRoots) {
      if (roots.has(path)) throw new Error('PROJECT_DUPLICATE_ROOT')
      roots.set(path, project.id)
    }
    const workspaceDir = project.hostConfig.workspaceDir ? directory(project.hostConfig.workspaceDir) : root
    if (!projectRoots.some(path => contains(path, workspaceDir))) throw new Error('PROJECT_WORKSPACE_MISMATCH')
    const flow = project.hostConfig.flowWeb
    if (project.enabled && flow?.enabled && flow.port) {
      if (ports.has(flow.port)) throw new Error('PROJECT_DUPLICATE_PORT')
      ports.add(flow.port)
    }
    return { ...project, root, roots: projectRoots, hostConfig: { ...project.hostConfig, stateDir, workspaceDir } }
  })
  const managerPath = (() => { try { return realpathSync(config.managerDir) } catch { return resolve(config.managerDir) } })()
  if (states.has(managerPath)) throw new Error('PROJECT_MANAGER_STATE_CONFLICT')
  if (config.legacyProjectId && !identities.has(config.legacyProjectId)) throw new Error('PROJECT_LEGACY_NOT_REGISTERED')
  const get = (id: string) => {
    const project = projects.find(project => project.id === id)
    if (!project) throw new Error('PROJECT_NOT_REGISTERED')
    return project
  }
  return {
    list: () => projects, get,
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
