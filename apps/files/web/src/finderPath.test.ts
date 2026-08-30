import { describe, expect, it } from 'vitest'
import { updateFinderPathForSelection } from './finderPath'

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
