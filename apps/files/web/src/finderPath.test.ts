import { describe, expect, it } from 'vitest'
import { columnScrollLeft, columnTrailingSpace, updateFinderPathForSelection } from './finderPath'

const path = [{ id: 'documents' }, { id: 'projects' }, { id: 'current' }]

describe('updateFinderPathForSelection', () => {
  it('preserves later columns when a pointer selects the existing path entry', () => {
    expect(updateFinderPathForSelection(path, new Set(['projects']), 1, true)).toBe(path)
  })

  it('collapses later columns when a pointer selects a sibling', () => {
    expect(updateFinderPathForSelection(path, new Set(['archive']), 1, true)).toEqual([{ id: 'documents' }])
  })

  it('collapses later columns for a mixed multi-selection', () => {
    expect(updateFinderPathForSelection(path, new Set(['projects', 'archive']), 1, true)).toEqual([{ id: 'documents' }])
  })

  it('keeps keyboard selection navigation behavior unchanged', () => {
    expect(updateFinderPathForSelection(path, new Set(['projects']), 1, false)).toEqual([{ id: 'documents' }])
  })

  it('does not alter the path when selecting in the rightmost column', () => {
    expect(updateFinderPathForSelection(path, new Set(['child']), path.length, true)).toEqual(path)
  })
})

describe('columnScrollLeft', () => {
  it('reveals an opened column with only the needed scroll', () => {
    expect(columnScrollLeft(150, 500, 720, 960)).toBe(460)
  })

  it('keeps already visible destinations stationary', () => {
    expect(columnScrollLeft(100, 500, 240, 480)).toBe(100)
  })

  it('keeps a partially visible ancestor stationary for pointer navigation', () => {
    expect(columnScrollLeft(590, 850, 480, 720, false)).toBe(590)
    expect(columnScrollLeft(590, 850, 720, 960, false)).toBe(590)
  })

  it('reveals an ancestor that is entirely offscreen, including root', () => {
    expect(columnScrollLeft(590, 850, 240, 480, false)).toBe(240)
    expect(columnScrollLeft(590, 850, 0, 240, false)).toBe(0)
  })

  it('reveals root explicitly while keeping a pointer-selected root column steady', () => {
    expect(columnScrollLeft(210, 850, 0, 240)).toBe(0)
    expect(columnScrollLeft(210, 850, 0, 240, false)).toBe(210)
  })

  it('fully reveals the keyboard destination even when partially visible', () => {
    expect(columnScrollLeft(590, 850, 480, 720)).toBe(480)
  })

  it('handles a replacement at the same depth and unequal column widths', () => {
    expect(columnScrollLeft(150, 500, 540, 1020)).toBe(520)
  })

  it('keeps the beginning readable when the column is wider than the viewport', () => {
    expect(columnScrollLeft(0, 120, 240, 480)).toBe(240)
  })
})

describe('columnTrailingSpace', () => {
  it('prevents ancestor collapse from clamping the viewport', () => {
    expect(columnTrailingSpace(960, 590, 850)).toBe(480)
    expect(columnTrailingSpace(720, 590, 850)).toBe(720)
  })

  it('reclaims space while scrolling back and when opening new columns', () => {
    expect(columnTrailingSpace(960, 350, 850)).toBe(240)
    expect(columnTrailingSpace(960, 0, 850)).toBe(0)
    expect(columnTrailingSpace(1440, 590, 850)).toBe(0)
  })

  it('accounts for viewport resizing, unequal widths, and fractional scrolling', () => {
    expect(columnTrailingSpace(1020, 520, 700)).toBe(200)
    expect(columnTrailingSpace(1020, 520.5, 700)).toBe(201)
  })

  it('does not add blank space when all columns fit', () => {
    expect(columnTrailingSpace(240, 0, 850)).toBe(0)
  })
})
