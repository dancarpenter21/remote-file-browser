import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, mediaUrl, setCsrf, thumbnailUrl } from './api'

afterEach(() => {
  vi.restoreAllMocks()
  setCsrf()
})

describe('preview URLs', () => {
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

  it('constructs an authenticated multipart image-markup request', async () => {
    setCsrf('csrf-token')
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'folder/image-markup.png' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }))
    const png = new Blob(['png bytes'], { type: 'image/png' })

    await api.saveImageMarkup('folder/image & one.jpg', '"etag one"', png)

    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/v1/editor/image-markup?id=folder%2Fimage%20%26%20one.jpg&expectedEtag=%22etag%20one%22')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf-token')
    expect(new Headers(init?.headers).has('content-type')).toBe(false)
    expect(init?.body).toBeInstanceOf(FormData)
    expect((init?.body as FormData).get('file')).toBeInstanceOf(Blob)
  })
})
