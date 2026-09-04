import { describe, expect, it } from 'vitest'
import { createPlaybackFallbackGate, formatMediaTime, hlsRecoveryAction, shouldAutoLoop, stepFrameTime, validSegment } from './videoPlayerState'

describe('basic video player state', () => {
  it('starts compatibility fallback only once until reset', () => {
    const gate = createPlaybackFallbackGate()
    expect(gate.claim()).toBe(true)
    expect(gate.claim()).toBe(false)
    gate.reset()
    expect(gate.claim()).toBe(true)
  })

  it('bounds HLS network and media recovery attempts', () => {
    expect(hlsRecoveryAction('networkError', 0, 0)).toBe('retry-network')
    expect(hlsRecoveryAction('networkError', 1, 0)).toBe('fail')
    expect(hlsRecoveryAction('mediaError', 0, 0)).toBe('recover-media')
    expect(hlsRecoveryAction('mediaError', 0, 1)).toBe('fail')
  })

  it('formats playback time and steps on the nominal frame grid', () => {
    expect(formatMediaTime(3661.2344)).toBe('01:01:01.234')
    expect(formatMediaTime(Number.NaN)).toBe('00:00:00.000')
    expect(stepFrameTime(1, 1, 25, 10)).toBeCloseTo(1.04)
    expect(stepFrameTime(1, -1, 25, 10)).toBeCloseTo(0.96)
    expect(stepFrameTime(0, -1, 25, 10)).toBe(0)
    expect(stepFrameTime(10, 1, 25, 10)).toBeCloseTo(9.96)
  })

  it('requires ordered in and out markers', () => {
    expect(validSegment(1, 2)).toBe(true)
    expect(validSegment(2, 1)).toBe(false)
    expect(validSegment(undefined, 2)).toBe(false)
  })

  it('auto-loops only positive durations strictly below forty seconds', () => {
    expect(shouldAutoLoop(39.999)).toBe(true)
    expect(shouldAutoLoop(40)).toBe(false)
    expect(shouldAutoLoop(0)).toBe(false)
    expect(shouldAutoLoop(Number.NaN)).toBe(false)
  })
})
