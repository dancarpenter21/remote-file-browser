import { describe, expect, it } from 'vitest'
import { markdownUrlTransform, resolveMarkdownImageSource } from './markdownPreview'

const id = (path: string) => Buffer.from(path).toString('base64url')

describe('Markdown preview images', () => {
  it('resolves image paths relative to the Markdown document', () => {
    expect(resolveMarkdownImageSource(id('notes/readme.md'), 'images/chart.png')).toBe(
      `/api/v1/media/file?id=${id('notes/images/chart.png')}`,
    )
    expect(resolveMarkdownImageSource(id('notes/drafts/readme.md'), '../chart image.png')).toBe(
      `/api/v1/media/file?id=${id('notes/chart image.png')}`,
    )
  })

  it('resolves root paths and preserves image fragments', () => {
    expect(resolveMarkdownImageSource(id('notes/readme.md'), '/shared/chart.png#preview')).toBe(
      `/api/v1/media/file?id=${id('shared/chart.png')}#preview`,
    )
  })

  it('leaves remote and inline image sources unchanged', () => {
    expect(resolveMarkdownImageSource(id('notes/readme.md'), 'https://example.com/chart.png')).toBe('https://example.com/chart.png')
    expect(resolveMarkdownImageSource(id('notes/readme.md'), 'data:image/png;base64,aGVsbG8=')).toBe('data:image/png;base64,aGVsbG8=')
  })

  it('allows inline raster images but rejects other data URLs', () => {
    expect(markdownUrlTransform('data:image/png;base64,aGVsbG8=', 'src')).toBe('data:image/png;base64,aGVsbG8=')
    expect(markdownUrlTransform('data:image/svg+xml;base64,aGVsbG8=', 'src')).toBe('')
    expect(markdownUrlTransform('data:text/html;base64,aGVsbG8=', 'src')).toBe('')
  })
})
