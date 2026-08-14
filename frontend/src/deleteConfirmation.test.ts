import { describe, expect, it } from 'vitest'
import { deleteConfirmationMessage } from './deleteConfirmation'

describe('delete confirmation', () => {
  it('names a single item', () => {
    expect(deleteConfirmationMessage(['clip.mp4'])).toBe('Move this item to Trash?\n\n• clip.mp4')
  })

  it('lists every selected item', () => {
    expect(deleteConfirmationMessage(['first.jpg', 'second.mov'])).toBe('Move these 2 items to Trash?\n\n• first.jpg\n• second.mov')
  })
})
