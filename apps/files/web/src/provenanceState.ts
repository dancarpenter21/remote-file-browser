import { Entry, EntryPage, ProvenanceChange } from './api'

export function applyProvenanceToEntry(entry: Entry, change: ProvenanceChange): Entry {
  return entry.id === change.id ? { ...entry, hasProvenance: change.urls.length > 0 } : entry
}

export function applyProvenanceToPage(page: EntryPage, change: ProvenanceChange): EntryPage {
  return { ...page, entries: page.entries.map(entry => applyProvenanceToEntry(entry, change)) }
}
