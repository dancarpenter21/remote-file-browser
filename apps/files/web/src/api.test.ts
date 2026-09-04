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

describe('archive extraction', () => {
  it('posts the source id, replacement choice, and CSRF token', async () => {
    const extracted = { id: 'photos', name: 'photos', kind: 'directory' } as Entry
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(extracted), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    setCsrf('csrf-token')

    await expect(api.extractArchive('photos.zip', true)).resolves.toEqual(extracted)
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/v1/fs/extractions')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ sourceId: 'photos.zip', replace: true })
    expect((init.headers as Headers).get('x-csrf-token')).toBe('csrf-token')
  })
})

describe('video extraction', () => {
  it('reads media metadata and starts authenticated extraction jobs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ durationSeconds: 12, frameRate: 24 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ key: 'job', kind: 'frame', status: 'working' }), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    setCsrf('csrf-token')

    await expect(api.mediaInfo('folder/clip.mp4')).resolves.toEqual({ durationSeconds: 12, frameRate: 24 })
    await api.startExtraction({ id: 'folder/clip.mp4', kind: 'frame', time: 1.25 })

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/media/info?id=folder%2Fclip.mp4')
    const [path, init] = fetchMock.mock.calls[1]
    expect(path).toBe('/api/v1/media/extractions')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ id: 'folder/clip.mp4', kind: 'frame', time: 1.25 })
    expect((init.headers as Headers).get('x-csrf-token')).toBe('csrf-token')
  })

  it('starts and polls shared HLS conversion jobs', async () => {
    const job = { key: 'a'.repeat(64), status: 'working', playable: false, mode: 'full', progress: 0, playlistUrl: '/api/v1/media/hls/key/index.m3u8' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(job), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...job, playable: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    setCsrf('csrf-token')

    await api.startHls('folder/legacy clip.wmv')
    await api.hlsStatus(job.key)

    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/v1/media/hls')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ id: 'folder/legacy clip.wmv' })
    expect((init.headers as Headers).get('x-csrf-token')).toBe('csrf-token')
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/v1/media/hls/${job.key}/status`)
  })
})
