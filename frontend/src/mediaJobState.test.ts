import { describe, expect, it } from 'vitest'
import { jobsFromSnapshot, progressPercent, upsertJob } from './mediaJobState'

describe('media job state', () => {
  it('replaces job updates and keeps newest jobs first', () => {
    const jobs = [
      { key: 'old', startedAt: '2026-01-01T00:00:00Z', progress: 0 },
      { key: 'new', startedAt: '2026-01-02T00:00:00Z', progress: 0 },
    ]
    expect(upsertJob(jobs, { key: 'old', startedAt: '2026-01-01T00:00:00Z', progress: .5 }))
      .toEqual([jobs[1], { key: 'old', startedAt: '2026-01-01T00:00:00Z', progress: .5 }])
  })

  it('formats bounded progress percentages', () => {
    expect(progressPercent(null)).toBe(0)
    expect(progressPercent(.426)).toBe(43)
    expect(progressPercent(2)).toBe(100)
  })

  it('accepts snapshots from backends without newer job collections', () => {
    expect(jobsFromSnapshot(undefined)).toEqual([])
    expect(jobsFromSnapshot([{ key: 'concat' }])).toEqual([{ key: 'concat' }])
  })
})
