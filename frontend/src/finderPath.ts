export type FinderPathEntry = { id: string }

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
