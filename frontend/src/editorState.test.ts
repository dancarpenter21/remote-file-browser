import { describe, expect, it } from 'vitest'
import { editorSaveShortcut, proportionalScrollTop, shouldApplyDocumentResponse, wheelDeltaPixels } from './editorState'

describe('editor preview scrolling', () => {
  it('maps editor progress into the preview scroll range', () => {
    expect(proportionalScrollTop(
      { scrollTop: 300, scrollHeight: 1000, clientHeight: 400 },
      { scrollHeight: 1800, clientHeight: 600 },
    )).toBe(600)
  })

  it('clamps progress and handles panes without a scroll range', () => {
    expect(proportionalScrollTop(
      { scrollTop: 900, scrollHeight: 1000, clientHeight: 400 },
      { scrollHeight: 1800, clientHeight: 600 },
    )).toBe(1200)
    expect(proportionalScrollTop(
      { scrollTop: 0, scrollHeight: 400, clientHeight: 400 },
      { scrollHeight: 1800, clientHeight: 600 },
    )).toBe(0)
  })

  it('normalizes pixel, line, and page wheel deltas', () => {
    expect(wheelDeltaPixels({ deltaY: 12, deltaMode: 0 }, 18, 500)).toBe(12)
    expect(wheelDeltaPixels({ deltaY: 3, deltaMode: 1 }, 18, 500)).toBe(54)
    expect(wheelDeltaPixels({ deltaY: -1, deltaMode: 2 }, 18, 500)).toBe(-500)
  })
})

describe('editor request safety', () => {
  it('recognizes the conventional save shortcut', () => {
    const event = { key: 'S', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }
    expect(editorSaveShortcut(event)).toBe(true)
    expect(editorSaveShortcut({ ...event, ctrlKey: false, metaKey: true })).toBe(true)
    expect(editorSaveShortcut({ ...event, shiftKey: true })).toBe(false)
    expect(editorSaveShortcut({ ...event, repeat: true })).toBe(false)
  })

  it('rejects stale or mismatched document responses', () => {
    expect(shouldApplyDocumentResponse(3, 3, 'second', 'second')).toBe(true)
    expect(shouldApplyDocumentResponse(2, 3, 'first', 'first')).toBe(false)
    expect(shouldApplyDocumentResponse(3, 3, 'second', 'first')).toBe(false)
  })
})
