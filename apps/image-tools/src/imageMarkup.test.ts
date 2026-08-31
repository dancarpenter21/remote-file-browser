import { describe, expect, it } from 'vitest'
import { markupPoint, markupStrokeWidth } from './imageMarkup'

describe('image markup', () => {
  it('uses source-image coordinates and clamps to the image', () => {
    expect(markupPoint(60, 45, { left: 10, top: 20, width: 100, height: 50 }, 1000, 500)).toEqual({ x: 500, y: 250 })
    expect(markupPoint(-10, 200, { left: 10, top: 20, width: 100, height: 50 }, 1000, 500)).toEqual({ x: 0, y: 500 })
  })
  it('scales and bounds stroke width', () => {
    expect(markupStrokeWidth(100, 100)).toBe(4)
    expect(markupStrokeWidth(2000, 1000)).toBe(6)
    expect(markupStrokeWidth(10000, 10000)).toBe(24)
  })
})
