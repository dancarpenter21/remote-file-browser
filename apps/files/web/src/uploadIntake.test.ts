import { describe, expect, it } from 'vitest'
import { INTERNAL_DRAG_TYPE, isExternalFileDrag, manifestFromDrop, manifestFromFiles, normalizeManifest } from './uploadIntake'

const file = (name: string, relativePath = '') => ({ name, size: 4, webkitRelativePath: relativePath }) as File

describe('external upload detection', () => {
  it('accepts operating-system file drags and excludes internal moves', () => {
    expect(isExternalFileDrag({ types: ['Files'] })).toBe(true)
    expect(isExternalFileDrag({ types: ['Files', INTERNAL_DRAG_TYPE] })).toBe(false)
    expect(isExternalFileDrag({ types: ['text/plain'] })).toBe(false)
  })
})

describe('upload manifests', () => {
  it('derives a deduplicated parent tree from folder-picker paths', () => {
    const manifest = manifestFromFiles([
      file('one.txt', 'project/docs/one.txt'),
      file('two.txt', 'project/docs/nested/two.txt'),
    ], true)
    expect(manifest.directories).toEqual([['project'], ['project', 'docs'], ['project', 'docs', 'nested']])
    expect(manifest.files.map(item => item.path)).toEqual([
      ['project', 'docs', 'one.txt'],
      ['project', 'docs', 'nested', 'two.txt'],
    ])
  })

  it('rejects local file/directory target collisions', () => {
    expect(() => normalizeManifest({ directories: [['same']], files: [{ file: file('same'), path: ['same'] }] }))
      .toThrow('Two selected items map')
  })

  it('reads every directory-reader batch and preserves empty folders', async () => {
    const uploaded = file('clip.mp4')
    const fileEntry = { name: 'clip.mp4', isFile: true, isDirectory: false, file: (success: (value: File) => void) => success(uploaded) } as FileSystemFileEntry
    const empty = { name: 'empty', isFile: false, isDirectory: true, createReader: () => ({ readEntries: (success: (entries: FileSystemEntry[]) => void) => success([]) }) } as FileSystemDirectoryEntry
    let read = 0
    const folder = {
      name: 'project', isFile: false, isDirectory: true,
      createReader: () => ({ readEntries: (success: (entries: FileSystemEntry[]) => void) => success(read++ === 0 ? [fileEntry] : read === 2 ? [empty] : []) }),
    } as FileSystemDirectoryEntry
    const transfer = { items: [{ kind: 'file', webkitGetAsEntry: () => folder }], files: [] } as unknown as DataTransfer
    const manifest = await manifestFromDrop(transfer)
    expect(manifest.directories).toEqual([['project'], ['project', 'empty']])
    expect(manifest.files[0].path).toEqual(['project', 'clip.mp4'])
  })
})
