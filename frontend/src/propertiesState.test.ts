import { describe, expect, it } from 'vitest'
import { directoryContentsLabel, propertyTypeLabel } from './propertiesState'

describe('property type labels', () => {
  it('labels every filesystem entry kind', () => {
    expect(propertyTypeLabel('file')).toBe('File')
    expect(propertyTypeLabel('directory')).toBe('Folder')
    expect(propertyTypeLabel('symlink')).toBe('Symbolic link')
    expect(propertyTypeLabel('other')).toBe('Other')
  })
})

describe('directory contents labels', () => {
  it('shows loading and unavailable states', () => {
    expect(directoryContentsLabel({}, true)).toBe('Loading…')
    expect(directoryContentsLabel({}, false)).toBe('Unavailable')
  })

  it('formats empty, singular, and plural counts', () => {
    expect(directoryContentsLabel({ childFileCount: 0, childDirectoryCount: 0 }, false)).toBe('0 files, 0 folders')
    expect(directoryContentsLabel({ childFileCount: 1, childDirectoryCount: 1 }, false)).toBe('1 file, 1 folder')
    expect(directoryContentsLabel({ childFileCount: 3, childDirectoryCount: 2 }, false)).toBe('3 files, 2 folders')
  })
})
