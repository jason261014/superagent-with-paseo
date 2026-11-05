import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSnapshot, readSnapshot, type SnapshotRef } from '../src/delivery/snapshot.ts'

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) }

})

let root: string
let source: string
let store: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'delivery-snapshot-'))
  source = join(root, 'source'); store = join(root, 'store')
  await mkdir(join(source, 'docs'), { recursive: true })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('delivery snapshot', () => {
  it('preserves selected original bytes and deletions despite subsequent source edits', async () => {
    const binary = Buffer.from([0, 255, 4, 128])
    await writeFile(join(source, 'docs', 'draft.bin'), binary)
    await writeFile(join(source, 'untracked.txt'), 'before')
    await chmod(join(source, 'untracked.txt'), 0o755)
    const ref = await createSnapshot({ sourceRoot: source, storeRoot: store, selections: [
      { path: 'untracked.txt', kind: 'file' }, { path: 'docs/draft.bin', kind: 'file' }, { path: 'old.txt', kind: 'deleted' },
    ] })
    await writeFile(join(source, 'untracked.txt'), 'after')
    await chmod(join(source, 'untracked.txt'), 0o644)
    await rm(join(source, 'docs', 'draft.bin'))
    await writeFile(join(source, 'old.txt'), 'recreated')
    const result = await readSnapshot(store, ref)
    expect(result.files.get('docs/draft.bin')).toEqual(binary)
    expect(result.files.get('untracked.txt')?.toString()).toBe('before')
    expect(result.manifest.entries.find(entry => entry.path === 'untracked.txt')).toMatchObject({ mode: 0o755 })
    expect(result.manifest.entries.map(entry => [entry.path, entry.kind])).toEqual([
      ['docs/draft.bin', 'file'], ['old.txt', 'deleted'], ['untracked.txt', 'file'],
    ])
    expect(result.files.has('old.txt')).toBe(false)
  })

  it('refuses traversal, absolute and duplicate names, and a false deletion', async () => {
    await writeFile(join(source, 'present'), 'value')
    for (const path of ['../outside', '/tmp/outside', 'docs/../present', 'docs//x', 'docs\\x']) {
      await expect(createSnapshot({ sourceRoot: source, storeRoot: store, selections: [{ path, kind: 'file' }] })).rejects.toThrow()
    }
    await expect(createSnapshot({ sourceRoot: source, storeRoot: store, selections: [
      { path: 'present', kind: 'file' }, { path: 'present', kind: 'deleted' },
    ] })).rejects.toThrow('duplicate selection')
    await expect(createSnapshot({ sourceRoot: source, storeRoot: store, selections: [{ path: 'present', kind: 'deleted' }] })).rejects.toThrow('deleted path exists')
  })

  it('refuses symlinks at the leaf and intermediate components, including deletion paths', async () => {
    await writeFile(join(root, 'secret'), 'private')
    await symlink(join(root, 'secret'), join(source, 'link'))
    await symlink(root, join(source, 'external'))
    for (const selection of [{ path: 'link', kind: 'file' }, { path: 'external/secret', kind: 'file' }, { path: 'external/missing', kind: 'deleted' }] as const) {
      await expect(createSnapshot({ sourceRoot: source, storeRoot: store, selections: [selection] })).rejects.toThrow('symbolic link')
    }
  })

  it('detects tampering with a blob and a manifest', async () => {
    await writeFile(join(source, 'data'), 'original')
    const ref = await createSnapshot({ sourceRoot: source, storeRoot: store, selections: [{ path: 'data', kind: 'file' }] })
    const { manifest } = await readSnapshot(store, ref)
    const entry = manifest.entries[0]!
    if (entry.kind !== 'file') throw new Error('expected file')
    await writeFile(join(store, ref.id, 'snapshot', 'blobs', entry.sha256), 'modified')
    await expect(readSnapshot(store, ref)).rejects.toThrow('blob digest mismatch')
    await writeFile(join(store, ref.id, 'snapshot', 'manifest.json'), '{}')
    await expect(readSnapshot(store, ref)).rejects.toThrow('manifest digest mismatch')
  })

  it('fails closed for missing content and an invalid reference', async () => {
    await writeFile(join(source, 'data'), 'original')
    const ref = await createSnapshot({ sourceRoot: source, storeRoot: store, selections: [{ path: 'data', kind: 'file' }] })
    const manifest = JSON.parse(await readFile(join(store, ref.id, 'snapshot', 'manifest.json'), 'utf8')) as { entries: { sha256: string }[] }
    await rm(join(store, ref.id, 'snapshot', 'blobs', manifest.entries[0]!.sha256))
    await expect(readSnapshot(store, ref)).rejects.toThrow()
    await expect(readSnapshot(store, { ...ref, id: '../other' })).rejects.toThrow('invalid snapshot reference')
  })

  it('reserves IDs exclusively and leaves an existing colliding snapshot untouched', async () => {
    await mkdir(store, { mode: 0o700 })
    const existing = '00000000-0000-4000-8000-000000000001'
    const fresh = '00000000-0000-4000-8000-000000000002'
    await mkdir(join(store, existing))
    await writeFile(join(store, existing, 'sentinel'), 'keep')
    vi.mocked(randomUUID).mockReturnValueOnce(existing).mockReturnValueOnce(fresh)
    await writeFile(join(source, 'data'), 'original')
    const ref = await createSnapshot({ sourceRoot: source, storeRoot: store, selections: [{ path: 'data', kind: 'file' }] })
    expect(ref.id).toBe(fresh)
    expect(await readFile(join(store, existing, 'sentinel'), 'utf8')).toBe('keep')
    expect((await readSnapshot(store, ref)).files.get('data')?.toString()).toBe('original')
  })

  it('cleans reserved and temporary paths after capture fails', async () => {
    await expect(createSnapshot({ sourceRoot: source, storeRoot: store, selections: [{ path: 'absent', kind: 'file' }] })).rejects.toThrow()
    expect(await readdir(store)).toEqual([])
  })

  it('rejects empty and untrusted references and a forged manifest with an unsafe path', async () => {
    await expect(createSnapshot({ sourceRoot: source, storeRoot: store, selections: [] })).rejects.toThrow('empty selection')
    await expect(readSnapshot(store, null as unknown as SnapshotRef)).rejects.toThrow('invalid snapshot reference')
    await expect(readSnapshot(store, { id: '00000000-0000-4000-8000-000000000001', manifestSha256: '' })).rejects.toThrow('invalid snapshot reference')
    await writeFile(join(source, 'data'), 'value')
    const ref = await createSnapshot({ sourceRoot: source, storeRoot: store, selections: [{ path: 'data', kind: 'file' }] })
    const path = join(store, ref.id, 'snapshot', 'manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as { entries: { path: string }[] }
    manifest.entries[0]!.path = '../secret'
    const forged = JSON.stringify(manifest)
    await writeFile(path, forged)
    const forgedDigest = createHash('sha256').update(forged).digest('hex')
    await expect(readSnapshot(store, { ...ref, manifestSha256: forgedDigest })).rejects.toThrow('invalid manifest entry')
  })
  it('publishes concurrent snapshots separately', async () => {
    await writeFile(join(source, 'data'), 'value')
    const options = { sourceRoot: source, storeRoot: store, selections: [{ path: 'data', kind: 'file' as const }] }
    const [first, second] = await Promise.all([createSnapshot(options), createSnapshot(options)])
    expect(first.id).not.toBe(second.id)
    expect((await readSnapshot(store, first)).files.get('data')?.toString()).toBe('value')
    expect((await readSnapshot(store, second)).files.get('data')?.toString()).toBe('value')
    expect((await readdir(store)).sort()).toEqual([first.id, second.id].sort())
  })

})
