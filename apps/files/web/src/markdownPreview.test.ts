import { describe, expect, it } from 'vitest'
import { markdownHeadingElementId, markdownUrlTransform, resolveMarkdownImageSource, resolveMarkdownLinkTarget } from './markdownPreview'

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

describe('Markdown preview links', () => {
  it('resolves relative and root-relative files with fragments', () => {
    expect(resolveMarkdownLinkTarget(id('notes/drafts/readme.md'), '../guide.md#Setup')).toEqual({
      kind: 'local', id: id('notes/guide.md'), fragment: 'Setup',
    })
    expect(resolveMarkdownLinkTarget(id('notes/readme.md'), '/shared/guide%20one.md?view=preview#first%20steps')).toEqual({
      kind: 'local', id: id('shared/guide one.md'), fragment: 'first steps',
    })
  })

  it('distinguishes same-document fragments and external destinations', () => {
    expect(resolveMarkdownLinkTarget(id('notes/readme.md'), '#quick-start')).toEqual({ kind: 'fragment', fragment: 'quick-start' })
    expect(resolveMarkdownLinkTarget(id('notes/readme.md'), 'https://example.com/guide')).toEqual({ kind: 'external', href: 'https://example.com/guide' })
    expect(resolveMarkdownLinkTarget(id('notes/readme.md'), 'mailto:hello@example.com')).toEqual({ kind: 'external', href: 'mailto:hello@example.com' })
  })

  it('rejects local paths that escape the filesystem root', () => {
    expect(resolveMarkdownLinkTarget(id('readme.md'), '../outside.md')).toBeUndefined()
  })

  it('maps fragments to the sanitized heading id prefix', () => {
    expect(markdownHeadingElementId('#first%20steps')).toBe('user-content-first steps')
  })
})
