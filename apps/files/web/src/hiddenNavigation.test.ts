import { describe, expect, it } from 'vitest'
import type { Entry, EntryPage } from './api'
import { retainActiveHiddenDirectory } from './hiddenNavigation'

const entry = (id: string, parentId: string, name: string, kind: Entry['kind'] = 'directory'): Entry => ({
  id, parentId, name, kind, path: `/fs-root/${name}`, size: 0, mode: 0o755, permissions: 'rwxr-xr-x', uid: 1000, gid: 1000,
  mime: kind === 'directory' ? 'inode/directory' : 'text/plain', etag: id, hasProvenance: false, browserReady: false,
})
const page = (...entries: Entry[]): EntryPage => ({ entries, total: entries.length, nextOffset: null })

describe('retainActiveHiddenDirectory', () => {
  const hiddenParent = entry('hidden', '', '.hidden')
  const visibleChild = entry('visible', 'hidden', 'visible')
  const hiddenChild = entry('nested-hidden', 'visible', '.nested')
  const path = [hiddenParent, visibleChild, hiddenChild]

  it('retains a hidden directory in the active path while other hidden entries stay absent', () => {
    const visibleSibling = entry('sibling', '', 'sibling')
    expect(retainActiveHiddenDirectory(page(visibleSibling), '', path, false)).toEqual({
      entries: [hiddenParent, visibleSibling], total: 2, nextOffset: null,
    })
  })

  it('retains hidden directories at each applicable level of a nested path', () => {
    expect(retainActiveHiddenDirectory(page(), 'visible', path, false)).toEqual({
      entries: [hiddenChild], total: 1, nextOffset: null,
    })
  })

  it('does not duplicate a path directory already returned by the API', () => {
    const original = page(hiddenParent)
    expect(retainActiveHiddenDirectory(original, '', path, false)).toBe(original)
  })

  it('does not retain hidden files or hidden directories outside the active path', () => {
    const hiddenFile = entry('secret', '', '.secret', 'file')
    expect(retainActiveHiddenDirectory(page(), '', [hiddenFile], false).entries).toEqual([])
    expect(retainActiveHiddenDirectory(page(), 'unrelated', path, false).entries).toEqual([])
  })

  it('leaves pages unchanged while hidden entries are enabled', () => {
    const original = page()
    expect(retainActiveHiddenDirectory(original, '', path, true)).toBe(original)
  })
})
