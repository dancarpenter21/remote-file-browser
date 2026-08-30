import { describe, expect, it } from 'vitest'
import { clipboardIdsForEntry, clipboardShortcut, movableClipboardIds, pasteProblem, shouldHandleClipboardShortcut } from './fileClipboard'

const shortcut = (key: string, overrides: Partial<Parameters<typeof clipboardShortcut>[0]> = {}) => clipboardShortcut({
  key,
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
})

describe('remote clipboard shortcuts', () => {
  it('recognizes copy, cut, and paste with either platform modifier', () => {
    expect(shortcut('c')).toBe('copy')
    expect(shortcut('X')).toBe('move')
    expect(shortcut('v', { ctrlKey: false, metaKey: true })).toBe('paste')
  })

  it('ignores modified, repeated, and unrelated key presses', () => {
    expect(shortcut('x', { altKey: true })).toBeNull()
    expect(shortcut('v', { shiftKey: true })).toBeNull()
    expect(shortcut('c', { repeat: true })).toBeNull()
    expect(shortcut('a')).toBeNull()
    expect(shortcut('x', { ctrlKey: false })).toBeNull()
  })

  it('preserves native clipboard behavior for selected text and blocked UI contexts', () => {
    expect(shouldHandleClipboardShortcut(true, false)).toBe(false)
    expect(shouldHandleClipboardShortcut(false, true)).toBe(false)
    expect(shouldHandleClipboardShortcut(false, false)).toBe(true)
  })
})

describe('remote clipboard selection', () => {
  it('uses the full selection when the context entry is selected', () => {
    expect(clipboardIdsForEntry('second', new Set(['first', 'second']))).toEqual(['first', 'second'])
  })

  it('uses only an unselected context entry', () => {
    expect(clipboardIdsForEntry('other', new Set(['first', 'second']))).toEqual(['other'])
  })
})

describe('remote clipboard destinations', () => {
  const file = { id: 'file', parentId: 'source', path: '/fs-root/source/file.txt', kind: 'file' }
  const folder = { id: 'folder', parentId: 'source', path: '/fs-root/source/folder', kind: 'directory' }

  it('rejects recursive directory destinations', () => {
    expect(pasteProblem('move', [folder], 'child', '/fs-root/source/folder/child')).toContain('inside itself')
    expect(pasteProblem('copy', [folder], 'folder', '/fs-root/source/folder')).toContain('inside itself')
  })

  it('rejects copies onto their existing path', () => {
    expect(pasteProblem('copy', [file], 'source', '/fs-root/source')).toContain('copied onto itself')
  })

  it('filters same-directory items from a move', () => {
    expect(movableClipboardIds(['file', 'unknown'], [file], 'source')).toEqual(['unknown'])
    expect(movableClipboardIds(['file'], [file], 'destination')).toEqual(['file'])
  })
})
