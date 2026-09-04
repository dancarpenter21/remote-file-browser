import { describe, expect, it } from 'vitest'
import { progressPercent, upsertJob } from './mediaJobState'

describe('media job state', () => {
  it('upserts, sorts, deduplicates, and limits conversion jobs', () => {
    const original = [
      { key: 'old', startedAt: '2026-01-01T00:00:00Z', status: 'working' },
      { key: 'new', startedAt: '2026-01-02T00:00:00Z', status: 'working' },
    ]
    expect(upsertJob(original, { key: 'old', startedAt: '2026-01-01T00:00:00Z', status: 'ready' }, 2)).toEqual([
      original[1],
      { key: 'old', startedAt: '2026-01-01T00:00:00Z', status: 'ready' },
    ])
  })

  it('clamps progress percentages', () => {
    expect(progressPercent(undefined)).toBe(0)
    expect(progressPercent(0.426)).toBe(43)
    expect(progressPercent(2)).toBe(100)
  })
})
