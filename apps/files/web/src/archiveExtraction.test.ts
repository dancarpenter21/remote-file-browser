import { describe, expect, it } from 'vitest'
import type { Entry } from './api'
import { isExtractableArchive } from './archiveExtraction'

const entry = (name: string, kind: Entry['kind'] = 'file') => ({ name, kind }) as Entry

describe('isExtractableArchive', () => {
  it('recognizes ZIP and common tarball suffixes case-insensitively', () => {
    for (const name of [
      'photos.zip', 'backup.TAR', 'source.tar.gz', 'source.tgz',
      'source.tar.bz2', 'source.tbz2', 'source.tar.xz', 'source.txz',
    ]) expect(isExtractableArchive(entry(name))).toBe(true)
  })

  it('excludes directories and unsupported compressed files', () => {
    expect(isExtractableArchive(entry('photos.zip', 'directory'))).toBe(false)
    expect(isExtractableArchive(entry('notes.txt'))).toBe(false)
    expect(isExtractableArchive(entry('source.gz'))).toBe(false)
    expect(isExtractableArchive(entry('source.tar.zst'))).toBe(false)
  })
})
