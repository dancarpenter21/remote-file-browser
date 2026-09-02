import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, liveFilesystemWatchMessage, mediaUrl, setCsrf, thumbnailUrl, type Entry } from './api'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setCsrf()
})

describe('preview URLs', () => {
  it('builds a deduplicated live filesystem watch subscription', () => {
    expect(JSON.parse(liveFilesystemWatchMessage(['', 'folder', 'folder']))).toEqual({
      type: 'watchFilesystem',
      directoryIds: ['', 'folder'],
    })
  })

  it('remain stable for the same file version and change with its etag', () => {
    expect(mediaUrl('folder/image.png', 'etag-one')).toBe(mediaUrl('folder/image.png', 'etag-one'))
    expect(mediaUrl('folder/image.png', 'etag-one')).not.toBe(mediaUrl('folder/image.png', 'etag-two'))
    expect(thumbnailUrl('folder/image.png', 'large', 'etag-one')).not.toBe(thumbnailUrl('folder/image.png', 'large', 'etag-two'))
  })

  it('encodes file ids and versions as query values', () => {
    expect(thumbnailUrl('folder/a & b.png', 'large', '"inode size"')).toBe(
      '/api/v1/previews/thumbnail?id=folder%2Fa%20%26%20b.png&size=large&v=%22inode%20size%22',
    )
  })
})

describe('complete directory listings', () => {
  it('stops when the server serializes the final next offset as null', async () => {
    const first = { id: 'one', name: 'one' } as Entry
    const second = { id: 'two', name: 'two' } as Entry
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [first], total: 2, nextOffset: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [second], total: 2, nextOffset: null }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.listAll('Downloads', true)).resolves.toEqual([first, second])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toContain('offset=1')
  })
})
