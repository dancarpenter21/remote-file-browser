import { describe, expect, it } from 'vitest'
import { isLocalTarget, isVideo, markdownUrlTransform, resolveFileId, resolveMedia } from './markdown'

describe('Markdown links and media', () => {
  it('accepts only local relative targets', () => {
    expect(isLocalTarget('../image.png')).toBe(true)
    expect(isLocalTarget('#heading')).toBe(false)
    expect(isLocalTarget('https://example.com')).toBe(false)
    expect(isLocalTarget('//example.com/image.png')).toBe(false)
  })
  it('resolves sibling paths without escaping the root', () => {
    expect(resolveFileId('/fs-root/docs/readme.md', '../image.png')).toBe('aW1hZ2UucG5n')
    expect(resolveFileId('/fs-root/readme.md', '../escape.png')).toBeUndefined()
    expect(resolveMedia('/fs-root/docs/readme.md', 'clip.mp4#t=2')).toContain('/api/v1/media/file?id=')
    expect(resolveMedia('/fs-root/docs/readme.md', 'clip.mp4#t=2')?.endsWith('#t=2')).toBe(true)
  })
  it('recognizes video embeds and permits only safe data images', () => {
    expect(isVideo('clip.MP4?t=1')).toBe(true)
    expect(isVideo('image.png')).toBe(false)
    expect(markdownUrlTransform('data:image/png;base64,AAAA', 'src')).toBe('data:image/png;base64,AAAA')
    expect(markdownUrlTransform('data:text/html;base64,AAAA', 'src')).toBe('')
  })
})
