export const INTERNAL_DRAG_TYPE = 'application/x-remote-file-browser'

export type LocalUploadFile = { file: File; path: string[] }
export type LocalUploadManifest = { files: LocalUploadFile[]; directories: string[][] }

type CompatibleDataTransferItem = DataTransferItem & {
  getAsEntry?: () => FileSystemEntry | null
  webkitGetAsEntry?: () => FileSystemEntry | null
}

const pathKey = (path: string[]) => JSON.stringify(path)

export function isExternalFileDrag(dataTransfer: Pick<DataTransfer, 'types'>) {
  const types = Array.from(dataTransfer.types)
  return types.includes('Files') && !types.includes(INTERNAL_DRAG_TYPE)
}

function fileFromEntry(entry: FileSystemFileEntry) {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject))
}

function readDirectory(entry: FileSystemDirectoryEntry) {
  const reader = entry.createReader()
  return new Promise<FileSystemEntry[]>((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const next = () => reader.readEntries(entries => {
      if (!entries.length) { resolve(all); return }
      all.push(...entries); next()
    }, reject)
    next()
  })
}

async function collectEntry(entry: FileSystemEntry, parent: string[], manifest: LocalUploadManifest) {
  const path = [...parent, entry.name]
  if (entry.isFile) {
    manifest.files.push({ file: await fileFromEntry(entry as FileSystemFileEntry), path })
    return
  }
  if (!entry.isDirectory) return
  manifest.directories.push(path)
  const children = await readDirectory(entry as FileSystemDirectoryEntry)
  for (const child of children) await collectEntry(child, path, manifest)
}

export async function manifestFromDrop(dataTransfer: DataTransfer): Promise<LocalUploadManifest> {
  const manifest: LocalUploadManifest = { files: [], directories: [] }
  const entries = Array.from(dataTransfer.items)
    .filter(item => item.kind === 'file')
    .map(item => {
      const compatible = item as CompatibleDataTransferItem
      return compatible.getAsEntry?.() ?? compatible.webkitGetAsEntry?.() ?? null
    })
    .filter((entry): entry is FileSystemEntry => Boolean(entry))
  if (entries.length) {
    for (const entry of entries) await collectEntry(entry, [], manifest)
    return normalizeManifest(manifest)
  }
  return manifestFromFiles(dataTransfer.files)
}

export function manifestFromFiles(files: Iterable<File>, relativePaths = false): LocalUploadManifest {
  const manifest: LocalUploadManifest = { files: [], directories: [] }
  for (const file of files) {
    const raw = relativePaths && file.webkitRelativePath ? file.webkitRelativePath : file.name
    const path = raw.split('/').filter(Boolean)
    manifest.files.push({ file, path })
    for (let depth = 1; depth < path.length; depth += 1) manifest.directories.push(path.slice(0, depth))
  }
  return normalizeManifest(manifest)
}

export function normalizeManifest(manifest: LocalUploadManifest): LocalUploadManifest {
  const directoryKeys = new Set<string>()
  const directories = manifest.directories
    .filter(path => path.length)
    .filter(path => {
      if (path.some(part => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\0'))) {
        throw new Error(`Invalid upload path: ${path.join('/')}`)
      }
      const key = pathKey(path); if (directoryKeys.has(key)) return false; directoryKeys.add(key); return true
    })
    .sort((a, b) => a.length - b.length || a.join('/').localeCompare(b.join('/')))
  const targets = new Set(directoryKeys)
  for (const { path } of manifest.files) {
    if (!path.length || path.some(part => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\0'))) {
      throw new Error(`Invalid upload path: ${path.join('/') || '(empty)'}`)
    }
    const key = pathKey(path)
    if (targets.has(key)) throw new Error(`Two selected items map to “${path.join('/')}”`)
    targets.add(key)
  }
  return { files: manifest.files, directories }
}
