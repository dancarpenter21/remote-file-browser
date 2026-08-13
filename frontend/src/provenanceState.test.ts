import { describe, expect, it } from 'vitest'
import { Entry, ProvenanceChange } from './api'
import { applyProvenanceToEntry, applyProvenanceToPage } from './provenanceState'

const entry = (id: string, hasProvenance = false) => ({ id, hasProvenance } as Entry)

describe('live provenance state', () => {
  it('marks only the changed entry when URLs arrive', () => {
    const change: ProvenanceChange = { id: 'target', urls: ['https://example.com/source'] }
    const page = applyProvenanceToPage({ entries: [entry('other'), entry('target')], total: 2 }, change)
    expect(page.entries.map(item => item.hasProvenance)).toEqual([false, true])
  })

  it('removes the marker when the final URL is removed', () => {
    const updated = applyProvenanceToEntry(entry('target', true), { id: 'target', urls: [] })
    expect(updated.hasProvenance).toBe(false)
  })
})
