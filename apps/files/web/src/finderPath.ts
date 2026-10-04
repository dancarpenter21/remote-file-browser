export type FinderPathEntry = { id: string }

export function columnScrollLeft(
  previousCount: number,
  nextCount: number,
  scrollLeft: number,
  viewportWidth: number,
  scrollWidth: number,
  lastColumnRight: number,
) {
  const maxScroll = Math.max(0, scrollWidth - viewportWidth)
  const current = Math.min(scrollLeft, maxScroll)
  if (nextCount <= previousCount) return current
  return Math.min(maxScroll, Math.max(current, lastColumnRight - viewportWidth))
}

export function updateFinderPathForSelection<T extends FinderPathEntry>(
  path: T[],
  selectedIds: Set<string>,
  columnIndex: number,
  preserveCurrentBranch: boolean,
) {
  const pathEntry = path[columnIndex]
  if (preserveCurrentBranch && pathEntry && selectedIds.size === 1 && selectedIds.has(pathEntry.id)) {
    return path
  }
  return path.slice(0, columnIndex)
}
