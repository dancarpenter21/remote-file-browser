import type { Entry } from './api'
import type { LocalUploadManifest } from './uploadIntake'

export type UploadConflict = {
  path: string[]
  localKind: 'file' | 'directory'
  remote: Entry
}

export type PlannedDirectory = {
  path: string[]
  existingId?: string
  conflict?: UploadConflict
}

export type PlannedFile = LocalUploadManifest['files'][number] & { conflict?: UploadConflict }
export type UploadPlan = { directories: PlannedDirectory[]; files: PlannedFile[]; conflicts: UploadConflict[] }

export const uploadPathKey = (path: string[]) => JSON.stringify(path)

export async function planUpload(
  manifest: LocalUploadManifest,
  destinationId: string,
  listDirectory: (id: string) => Promise<Entry[]>,
): Promise<UploadPlan> {
  if (destinationId === '' && [...manifest.directories, ...manifest.files.map(source => source.path)].some(path => path[0] === '.trash' || path[0] === '.cache' && path[1] === 'remote-file-browser')) {
    throw new Error('The upload includes storage reserved for Remote Files')
  }
  const pages = new Map<string, Entry[]>()
  const directoryIds = new Map<string, string>([['[]', destinationId]])
  const blocked = new Set<string>()
  const directories: PlannedDirectory[] = []
  const conflicts: UploadConflict[] = []
  const list = async (id: string) => {
    if (!pages.has(id)) pages.set(id, await listDirectory(id))
    return pages.get(id)!
  }
  const hasBlockedAncestor = (path: string[]) => path.some((_, index) => blocked.has(uploadPathKey(path.slice(0, index + 1))))

  for (const path of manifest.directories) {
    const key = uploadPathKey(path)
    const parentPath = path.slice(0, -1)
    if (hasBlockedAncestor(parentPath)) { blocked.add(key); directories.push({ path }); continue }
    const parentId = directoryIds.get(uploadPathKey(parentPath))
    if (parentId === undefined) { directories.push({ path }); continue }
    const remote = (await list(parentId)).find(entry => entry.name === path.at(-1))
    if (!remote) { directories.push({ path }); continue }
    if (remote.kind === 'directory') {
      directoryIds.set(key, remote.id)
      directories.push({ path, existingId: remote.id })
      continue
    }
    const conflict: UploadConflict = { path, localKind: 'directory', remote }
    conflicts.push(conflict); blocked.add(key); directories.push({ path, conflict })
  }

  const files: PlannedFile[] = []
  for (const source of manifest.files) {
    const parentPath = source.path.slice(0, -1)
    if (hasBlockedAncestor(parentPath)) { files.push(source); continue }
    const parentId = directoryIds.get(uploadPathKey(parentPath))
    if (parentId === undefined) { files.push(source); continue }
    const remote = (await list(parentId)).find(entry => entry.name === source.path.at(-1))
    if (!remote) { files.push(source); continue }
    const conflict: UploadConflict = { path: source.path, localKind: 'file', remote }
    conflicts.push(conflict); files.push({ ...source, conflict })
  }
  return { directories, files, conflicts }
}

export function conflictSummary(conflicts: UploadConflict[]) {
  const shown = conflicts.slice(0, 12).map(conflict => `• ${conflict.path.join('/')}`)
  if (conflicts.length > shown.length) shown.push(`…and ${conflicts.length - shown.length} more`)
  return `${conflicts.length} existing ${conflicts.length === 1 ? 'item conflicts' : 'items conflict'} with this upload:\n\n${shown.join('\n')}`
}
