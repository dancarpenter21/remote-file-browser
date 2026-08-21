import { describe, expect, it } from 'vitest'
import { mediaUrl, thumbnailUrl } from './api'

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
})
