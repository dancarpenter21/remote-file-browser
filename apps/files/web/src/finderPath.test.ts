import { describe, expect, it } from 'vitest'
import { columnScrollLeft, updateFinderPathForSelection } from './finderPath'

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
  it('reveals a newly opened column with only the needed scroll', () => {
    expect(columnScrollLeft(3, 4, 150, 500, 960, 960)).toBe(460)
  })

  it('keeps the current position when a new column is already visible', () => {
    expect(columnScrollLeft(2, 3, 100, 500, 720, 480)).toBe(100)
  })

  it('only clamps the position when earlier navigation removes columns', () => {
    expect(columnScrollLeft(6, 3, 960, 500, 720, 720)).toBe(220)
    expect(columnScrollLeft(3, 1, 220, 500, 240, 240)).toBe(0)
  })

  it('reveals the new column when the viewport is narrower than it', () => {
    expect(columnScrollLeft(1, 2, 0, 120, 480, 480)).toBe(360)
  })
})
