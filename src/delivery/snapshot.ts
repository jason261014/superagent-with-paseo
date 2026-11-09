/** Private, content-verified snapshots of explicitly selected files. This module does not accept a delivery. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

export type Selection = { path: string; kind: 'file' | 'deleted' }
export type Entry = { path: string; kind: 'file'; sha256: string; size: number; mode: number } | { path: string; kind: 'deleted' }
export type Manifest = { version: 1; entries: Entry[] }
/** The digest must be persisted independently of the snapshot, e.g. with the delivery record. */
export type SnapshotRef = { id: string; manifestSha256: string }

function sha256(data: Buffer | string): string { return createHash('sha256').update(data).digest('hex') }
function bad(message: string): never { throw new Error(message) }
function validPath(path: unknown): path is string {
  return typeof path === 'string' && !!path && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every(part => !!part && part !== '.' && part !== '..')
}
function assertRoot(root: string): void { if (!isAbsolute(root)) bad('root must be absolute') }
function manifestBytes(manifest: Manifest): Buffer { return Buffer.from(JSON.stringify(manifest)) }

/** Check every path component. Even in-root symlinks are rejected to keep selection semantics unambiguous. */
async function checkPath(root: string, path: string, absent: boolean): Promise<string> {
  let current = root
  const parts = path.split('/')
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!)
    let stat
    try { stat = await lstat(current) } catch (error) {
      if (absent && (error as NodeJS.ErrnoException).code === 'ENOENT') return current
      throw error
    }
    if (stat.isSymbolicLink()) bad(`symbolic link in selection: ${path}`)
    if (i < parts.length - 1 && !stat.isDirectory()) bad(`non-directory parent: ${path}`)
    if (i === parts.length - 1 && (absent || !stat.isFile())) bad(absent ? `deleted path exists: ${path}` : `not a regular file: ${path}`)
  }
  return current
}

/**
 * Capture each explicit selection to a new private directory. A deleted path must be absent at capture time.
 * Files are captured sequentially, not as an atomic filesystem-wide snapshot. Concurrent modification is rejected
 * when detected; callers must quiesce actively modifying sources. Parent-directory replacement can race the path
 * checks and open: this is not a security isolation boundary or a reliable complete delivery from untrusted sources.
 */
export async function createSnapshot(options: { sourceRoot: string; storeRoot: string; selections: Selection[] }): Promise<SnapshotRef> {
  const { sourceRoot, storeRoot, selections } = options
  assertRoot(sourceRoot); assertRoot(storeRoot)
  if (!Array.isArray(selections) || !selections.length) bad('empty selection')
  const sorted = [...selections].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i]
    if (!item || !validPath(item.path) || (item.kind !== 'file' && item.kind !== 'deleted')) bad('invalid selection')
    if (i && sorted[i - 1]!.path === item.path) bad('duplicate selection')
  }
  const source = await realpath(sourceRoot)
  if (!(await lstat(source)).isDirectory()) bad('source root is not a directory')
  await mkdir(storeRoot, { recursive: true, mode: 0o700 })
  const store = await realpath(storeRoot)
  const storeStat = await lstat(store)
  if (!storeStat.isDirectory()) bad('store root is not a directory')
  if ((storeStat.mode & 0o077) !== 0) bad('snapshot store must be private')
  if (store === source || store.startsWith(source + sep)) bad('snapshot store must be outside source root')
  const stage = await mkdtemp(join(store, '.snapshot-'))
  let id = ''
  let reserved = ''
  try {
    // mkdir is exclusive. Never replace an existing snapshot, even on an ID collision.
    for (let attempt = 0; attempt < 10; attempt++) {
      id = randomUUID()
      reserved = join(store, id)
      try { await mkdir(reserved, { mode: 0o700 }); break } catch (error) {
        reserved = ''
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 9) throw error
      }
    }
    await mkdir(join(stage, 'blobs'), { mode: 0o700 })
    const entries: Entry[] = []
    for (const item of sorted) {
      const path = await checkPath(source, item.path, item.kind === 'deleted')
      if (item.kind === 'deleted') { entries.push({ path: item.path, kind: 'deleted' }); continue }
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let bytes: Buffer
      let mode: number
      try {
        const before = await file.stat({ bigint: true })
        if (!before.isFile()) bad(`not a regular file: ${item.path}`)
        mode = Number(before.mode & 0o777n)
        bytes = await file.readFile()
        const after = await file.stat({ bigint: true })
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) bad(`file changed during capture: ${item.path}`)
      } finally { await file.close() }
      const digest = sha256(bytes)
      try { await writeFile(join(stage, 'blobs', digest), bytes, { flag: 'wx', mode: 0o600 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      entries.push({ path: item.path, kind: 'file', sha256: digest, size: bytes.length, mode })
    }
    const manifest: Manifest = { version: 1, entries }
    const encoded = manifestBytes(manifest)
    await writeFile(join(stage, 'manifest.json'), encoded, { flag: 'wx', mode: 0o600 })
    await rename(stage, join(reserved, 'snapshot'))
    return { id, manifestSha256: sha256(encoded) }
  } catch (error) {
    await Promise.allSettled([rm(stage, { recursive: true, force: true }),
      ...(reserved ? [rm(reserved, { recursive: true, force: true })] : [])])
    throw error
  }
}

/** Reads the manifest and every blob, failing closed on damage or an untrusted reference. */
export async function readSnapshot(storeRoot: string, ref: SnapshotRef): Promise<{ manifest: Manifest; files: Map<string, Buffer> }> {
  assertRoot(storeRoot)
  if (!ref || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ref.id)
    || !/^[0-9a-f]{64}$/.test(ref.manifestSha256)) bad('invalid snapshot reference')
  const root = resolve(storeRoot, ref.id, 'snapshot')
  const encoded = await readFile(join(root, 'manifest.json'))
  if (sha256(encoded) !== ref.manifestSha256) bad('manifest digest mismatch')
  const manifest: unknown = JSON.parse(encoded.toString('utf8'))
  if (!manifest || typeof manifest !== 'object' || (manifest as Manifest).version !== 1 || !Array.isArray((manifest as Manifest).entries)) bad('invalid manifest')
  const entries = (manifest as Manifest).entries
  const files = new Map<string, Buffer>()
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry || !validPath(entry.path) || seen.has(entry.path)) bad('invalid manifest entry')
    seen.add(entry.path)
    if (entry.kind === 'deleted') continue
    if (entry.kind !== 'file' || !/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) bad('invalid manifest entry')
    const bytes = await readFile(join(root, 'blobs', entry.sha256))
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) bad(`blob digest mismatch: ${entry.path}`)
    files.set(entry.path, bytes)
  }
  return { manifest: manifest as Manifest, files }
}
