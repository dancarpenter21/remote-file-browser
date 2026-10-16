export type FinderPathEntry = { id: string }

/** Reserve only the space needed to keep the current viewport from being clamped. */
export function columnTrailingSpace(contentWidth: number, scrollLeft: number, viewportWidth: number) {
  return scrollLeft > 0 ? Math.max(0, Math.ceil(scrollLeft + viewportWidth - contentWidth)) : 0
}

/** Ancestor clicks keep even partially visible columns still; keyboard/opening reveals them. */
export function columnScrollLeft(
  scrollLeft: number,
  viewportWidth: number,
  columnLeft: number,
  columnRight: number,
  revealPartial = true,
) {
  if (!revealPartial && columnRight > scrollLeft && columnLeft < scrollLeft + viewportWidth) return scrollLeft
  const visibleWidth = Math.min(columnRight - columnLeft, viewportWidth)
  if (columnLeft < scrollLeft) return Math.max(0, columnLeft)
  return Math.max(scrollLeft, columnLeft + visibleWidth - viewportWidth)
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
