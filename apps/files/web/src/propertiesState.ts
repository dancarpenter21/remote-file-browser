import type { Entry } from './api'

export function propertyTypeLabel(kind: Entry['kind']) {
  if (kind === 'directory') return 'Folder'
  if (kind === 'file') return 'File'
  if (kind === 'symlink') return 'Symbolic link'
  return 'Other'
}

export function directoryContentsLabel(entry: Pick<Entry, 'childFileCount' | 'childDirectoryCount'>, loading: boolean) {
  if (loading) return 'Loading…'
  if (entry.childFileCount === undefined || entry.childDirectoryCount === undefined) return 'Unavailable'
  const files = `${entry.childFileCount} file${entry.childFileCount === 1 ? '' : 's'}`
  const folders = `${entry.childDirectoryCount} folder${entry.childDirectoryCount === 1 ? '' : 's'}`
  return `${files}, ${folders}`
}
