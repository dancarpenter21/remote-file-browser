import { describe, expect, it } from 'vitest'
import { basicFileKind, isMarkdownFile, isSaveShortcut } from './basicFileView'

describe('basic file views', () => {
  it('routes images, videos, and common UTF-8 document types to local windows', () => {
    expect(basicFileKind({ name: 'photo.png', mime: 'image/png' })).toBe('image')
    expect(basicFileKind({ name: 'clip.mp4', mime: 'video/mp4' })).toBe('video')
    expect(basicFileKind({ name: 'notes.txt', mime: 'text/plain' })).toBe('text')
    expect(basicFileKind({ name: 'settings.json', mime: 'application/json' })).toBe('text')
    expect(basicFileKind({ name: 'script.ts', mime: 'application/octet-stream' })).toBe('text')
    expect(basicFileKind({ name: 'archive.zip', mime: 'application/zip' })).toBeUndefined()
  })

  it('recognizes the standard save shortcut without accepting Alt combinations', () => {
    expect(isSaveShortcut({ key: 's', ctrlKey: true, metaKey: false, altKey: false })).toBe(true)
    expect(isSaveShortcut({ key: 'S', ctrlKey: false, metaKey: true, altKey: false })).toBe(true)
    expect(isSaveShortcut({ key: 's', ctrlKey: true, metaKey: false, altKey: true })).toBe(false)
  })

  it('recognizes Markdown by MIME type or common extension', () => {
    expect(isMarkdownFile({ name: 'README', mime: 'text/markdown' })).toBe(true)
    expect(isMarkdownFile({ name: 'guide.markdown', mime: 'application/octet-stream' })).toBe(true)
    expect(isMarkdownFile({ name: 'notes.txt', mime: 'text/plain' })).toBe(false)
  })
})
