import { describe, expect, it } from 'vitest'
import { isAdjacentColumnMove, moveConfirmationMessage, springLoadedPath } from './columnDrag'

describe('adjacent column drag moves', () => {
  it('recognizes a direct child of the current directory', () => {
    expect(isAdjacentColumnMove('child', 'current', 'current', 'parent')).toBe(true)
  })

  it('recognizes the parent of the current directory', () => {
    expect(isAdjacentColumnMove('parent', 'grandparent', 'current', 'parent')).toBe(true)
  })

  it('does not recognize an unrelated destination', () => {
    expect(isAdjacentColumnMove('other', 'somewhere-else', 'current', 'parent')).toBe(false)
  })
})

describe('spring-loaded column drag navigation', () => {
  const path = [{ id: 'documents' }, { id: 'projects' }, { id: 'current' }]

  it('opens a child from the rightmost column', () => {
    expect(springLoadedPath(path, { id: 'assets' }, 3)).toEqual([
      ...path,
      { id: 'assets' },
    ])
  })

  it('replaces the later path when traversing into another subtree', () => {
    expect(springLoadedPath(path, { id: 'archive' }, 1)).toEqual([
      { id: 'documents' },
      { id: 'archive' },
    ])
  })
})

describe('column drag move confirmation', () => {
  it('names one item and its full destination path', () => {
    expect(moveConfirmationMessage(['clip.mp4'], '/fs-root/archive')).toBe(
      'Move this item to “/fs-root/archive”?\n\n• clip.mp4',
    )
  })

  it('names every selected item', () => {
    expect(moveConfirmationMessage(['first.jpg', 'second.mov'], '/fs-root')).toBe(
      'Move these 2 items to “/fs-root”?\n\n• first.jpg\n• second.mov',
    )
  })
})
