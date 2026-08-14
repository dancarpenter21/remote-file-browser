import { describe, expect, it } from 'vitest'
import { fitMediaWindow, formatMediaTime, stepFrame, validSegment } from './videoPlayerState'

describe('video player state', () => {
  it('formats media time to milliseconds', () => {
    expect(formatMediaTime(3661.2344)).toBe('01:01:01.234')
    expect(formatMediaTime(-1)).toBe('00:00:00.000')
  })

  it('steps on the nominal frame grid and clamps to media bounds', () => {
    expect(stepFrame(1, 1, 25, 10)).toBeCloseTo(1.04)
    expect(stepFrame(1, -1, 25, 10)).toBeCloseTo(.96)
    expect(stepFrame(0, -1, 25, 10)).toBe(0)
    expect(stepFrame(10, 1, 25, 10)).toBeCloseTo(9.96)
    expect(stepFrame(1.039999, 1, 25, 10)).toBeCloseTo(1.08)
    expect(stepFrame(1.039, 1, 25, 10)).toBeCloseTo(1.08)
  })

  it('fits intrinsic media dimensions without upscaling and caps them to the viewport', () => {
    expect(fitMediaWindow(640, 480, 1200, 900, 100)).toEqual({ width: 640, height: 580 })
    expect(fitMediaWindow(1920, 1080, 1200, 800, 100)).toEqual({ width: 1200, height: 775 })
    expect(fitMediaWindow(0, 480, 1200, 800, 100)).toBeUndefined()
  })

  it('requires ordered in and out markers', () => {
    expect(validSegment(1, 2)).toBe(true)
    expect(validSegment(2, 1)).toBe(false)
    expect(validSegment(undefined, 2)).toBe(false)
  })
})
