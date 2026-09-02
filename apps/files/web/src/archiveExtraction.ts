import type { Entry } from './api'

const archiveSuffix = /\.(?:zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i

export function isExtractableArchive(entry: Entry) {
  return entry.kind === 'file' && archiveSuffix.test(entry.name)
}
