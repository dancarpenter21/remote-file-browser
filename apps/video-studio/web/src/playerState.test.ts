import { describe, expect, it } from 'vitest'
import { createPlaybackFallbackGate, formatMediaTime, hlsRecoveryAction, stepFrameTime } from './playerState.js'

describe('video player state', () => {
  it('claims compatibility fallback only once until reset', () => {
    const gate = createPlaybackFallbackGate()
    expect(gate.started).toBe(false)
    expect(gate.claim()).toBe(true)
    expect(gate.claim()).toBe(false)
    expect(gate.started).toBe(true)
    gate.reset()
    expect(gate.claim()).toBe(true)
  })

  it('allows one recovery for each fatal HLS failure type', () => {
    expect(hlsRecoveryAction('networkError', 0, 0)).toBe('retry-network')
    expect(hlsRecoveryAction('networkError', 1, 0)).toBe('fail')
    expect(hlsRecoveryAction('mediaError', 0, 0)).toBe('recover-media')
    expect(hlsRecoveryAction('mediaError', 0, 1)).toBe('fail')
    expect(hlsRecoveryAction('otherError', 0, 0)).toBe('fail')
  })

  it('formats playback time and steps on the nominal frame grid', () => {
    expect(formatMediaTime(3661.2344)).toBe('01:01:01.234')
    expect(formatMediaTime(Number.NaN)).toBe('00:00:00.000')
    expect(stepFrameTime(1, 1, 25, 10)).toBeCloseTo(1.04)
    expect(stepFrameTime(1, -1, 25, 10)).toBeCloseTo(0.96)
    expect(stepFrameTime(0, -1, 25, 10)).toBe(0)
    expect(stepFrameTime(10, 1, 25, 10)).toBeCloseTo(9.96)
  })
})
