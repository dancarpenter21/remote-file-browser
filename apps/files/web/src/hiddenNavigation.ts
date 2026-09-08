import type { Entry, EntryPage } from './api'

export function retainActiveHiddenDirectory(
  page: EntryPage,
  directoryId: string,
  path: Entry[],
  showHidden: boolean,
): EntryPage {
  if (showHidden) return page
  const activeChild = path.find(entry => entry.parentId === directoryId)
  if (!activeChild || activeChild.kind !== 'directory' || !activeChild.name.startsWith('.') || page.entries.some(entry => entry.id === activeChild.id)) return page

  const entries = [...page.entries, activeChild].sort((left, right) => {
    const directoryOrder = Number(left.kind !== 'directory') - Number(right.kind !== 'directory')
    if (directoryOrder) return directoryOrder
    const leftName = left.name.toLowerCase(), rightName = right.name.toLowerCase()
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0
  })
  return { ...page, entries, total: page.total + 1 }
}
