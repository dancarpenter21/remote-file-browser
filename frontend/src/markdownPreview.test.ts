import { describe, expect, it } from 'vitest'
import { isMarkdownLocalTarget, isMarkdownMp4Source, markdownUrlTransform, resolveMarkdownFileId, resolveMarkdownMediaSource } from './markdownPreview'

const id = (path: string) => Buffer.from(path).toString('base64url')

describe('Markdown preview images', () => {
  it('resolves image paths relative to the Markdown document', () => {
    expect(resolveMarkdownMediaSource(id('notes/readme.md'), 'images/chart.png')).toBe(
      `/api/v1/media/file?id=${id('notes/images/chart.png')}`,
    )
    expect(resolveMarkdownMediaSource(id('notes/drafts/readme.md'), '../chart image.png')).toBe(
      `/api/v1/media/file?id=${id('notes/chart image.png')}`,
    )
  })

  it('resolves root paths and preserves image fragments', () => {
    expect(resolveMarkdownMediaSource(id('notes/readme.md'), '/shared/chart.png#preview')).toBe(
      `/api/v1/media/file?id=${id('shared/chart.png')}#preview`,
    )
  })

  it('leaves remote and inline image sources unchanged', () => {
    expect(resolveMarkdownMediaSource(id('notes/readme.md'), 'https://example.com/chart.png')).toBe('https://example.com/chart.png')
    expect(resolveMarkdownMediaSource(id('notes/readme.md'), 'data:image/png;base64,aGVsbG8=')).toBe('data:image/png;base64,aGVsbG8=')
  })

  it('does not request malformed or escaping local media paths', () => {
    expect(resolveMarkdownMediaSource(id('notes/readme.md'), '../../outside.png')).toBe('')
    expect(resolveMarkdownMediaSource(id('notes/readme.md'), '%E0%A4%A')).toBe('')
  })

  it('allows inline raster images but rejects other data URLs', () => {
    expect(markdownUrlTransform('data:image/png;base64,aGVsbG8=', 'src')).toBe('data:image/png;base64,aGVsbG8=')
    expect(markdownUrlTransform('data:image/svg+xml;base64,aGVsbG8=', 'src')).toBe('')
    expect(markdownUrlTransform('data:text/html;base64,aGVsbG8=', 'src')).toBe('')
  })
})

describe('Markdown preview file links', () => {
  it('resolves relative, parent, root, and encoded paths to file ids', () => {
    expect(resolveMarkdownFileId(id('notes/readme.md'), 'next.md')).toBe(id('notes/next.md'))
    expect(resolveMarkdownFileId(id('notes/drafts/readme.md'), '../next.md#section')).toBe(id('notes/next.md'))
    expect(resolveMarkdownFileId(id('notes/readme.md'), '/shared/caf%C3%A9%20notes.md?view=preview')).toBe(id('shared/café notes.md'))
  })

  it('does not treat external, document-only, malformed, or escaping targets as files', () => {
    expect(resolveMarkdownFileId(id('notes/readme.md'), 'https://example.com/next.md')).toBeUndefined()
    expect(resolveMarkdownFileId(id('notes/readme.md'), '//example.com/next.md')).toBeUndefined()
    expect(resolveMarkdownFileId(id('notes/readme.md'), '#section')).toBeUndefined()
    expect(resolveMarkdownFileId(id('notes/readme.md'), '?view=preview')).toBeUndefined()
    expect(resolveMarkdownFileId(id('notes/readme.md'), '../../outside.md')).toBeUndefined()
    expect(resolveMarkdownFileId(id('notes/readme.md'), '%E0%A4%A')).toBeUndefined()
  })

  it('distinguishes local-looking links from links handled by the browser', () => {
    expect(isMarkdownLocalTarget('../next.md')).toBe(true)
    expect(isMarkdownLocalTarget('../../outside.md')).toBe(true)
    expect(isMarkdownLocalTarget('#section')).toBe(false)
    expect(isMarkdownLocalTarget('mailto:admin@example.com')).toBe(false)
    expect(isMarkdownLocalTarget('https://example.com')).toBe(false)
  })
})

describe('Markdown preview videos', () => {
  it('recognizes MP4 image targets regardless of case or URL suffixes', () => {
    expect(isMarkdownMp4Source('clips/demo.mp4')).toBe(true)
    expect(isMarkdownMp4Source('clips/DEMO.MP4?download=0#t=12')).toBe(true)
    expect(isMarkdownMp4Source('clips/demo%2Emp4')).toBe(true)
    expect(isMarkdownMp4Source('clips/demo.webm')).toBe(false)
    expect(isMarkdownMp4Source('clips/demo.mp4.png')).toBe(false)
  })
})
