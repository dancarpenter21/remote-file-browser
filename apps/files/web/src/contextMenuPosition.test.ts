import { describe, expect, it } from 'vitest'
import { fitContextMenuToViewport } from './contextMenuPosition'

describe('fitContextMenuToViewport', () => {
  it('keeps a context menu at the requested position when it fits', () => {
    expect(fitContextMenuToViewport(
      { x: 200, y: 150 },
      { width: 190, height: 240 },
      { width: 1024, height: 768 },
    )).toEqual({ x: 200, y: 150 })
  })

  it('offsets a context menu upward when it would cross the viewport bottom', () => {
    expect(fitContextMenuToViewport(
      { x: 200, y: 700 },
      { width: 190, height: 240 },
      { width: 1024, height: 768 },
    )).toEqual({ x: 200, y: 520 })
  })

  it('keeps the menu margin visible at every viewport edge', () => {
    expect(fitContextMenuToViewport(
      { x: -20, y: -10 },
      { width: 190, height: 240 },
      { width: 160, height: 180 },
    )).toEqual({ x: 8, y: 8 })
  })
})
