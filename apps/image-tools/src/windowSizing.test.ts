import { describe, expect, it } from 'vitest'
import { fitImageWindow } from './windowSizing'

describe('image window sizing', () => {
  it('keeps native size when it fits and scales down when needed', () => {
    expect(fitImageWindow(640, 480, 1200, 900, 100)).toEqual({ width: 640, height: 580 })
    expect(fitImageWindow(1920, 1080, 1200, 800, 100)).toEqual({ width: 1200, height: 775 })
    expect(fitImageWindow(0, 480, 1200, 800, 100)).toBeUndefined()
  })
})
