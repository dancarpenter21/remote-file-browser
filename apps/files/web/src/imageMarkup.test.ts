import { describe, expect, it } from 'vitest'
import { markupPoint, markupStrokeWidth } from './imageMarkup'

describe('image markup geometry', () => {
  it('maps displayed pointer positions into native image coordinates', () => {
    expect(markupPoint(300, 175, { left: 100, top: 50, width: 400, height: 250 }, 1600, 1000)).toEqual({ x: 800, y: 500 })
  })

  it('clamps points to the image bounds', () => {
    expect(markupPoint(0, 500, { left: 100, top: 100, width: 200, height: 200 }, 800, 600)).toEqual({ x: 0, y: 600 })
  })

  it('uses a proportional stroke width with practical limits', () => {
    expect(markupStrokeWidth(100, 100)).toBe(4)
    expect(markupStrokeWidth(1920, 1080)).toBeCloseTo(6.48)
    expect(markupStrokeWidth(10000, 8000)).toBe(24)
  })
})
