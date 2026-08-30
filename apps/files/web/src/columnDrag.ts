export type ColumnDragPathEntry = { id: string }

export function isAdjacentColumnMove(
  destinationId: string,
  destinationParentId: string | undefined,
  currentDirectoryId: string,
  currentDirectoryParentId: string | undefined,
) {
  return destinationParentId === currentDirectoryId || destinationId === currentDirectoryParentId
}

export function springLoadedPath<T extends ColumnDragPathEntry>(path: T[], entry: T, columnIndex: number) {
  return [...path.slice(0, columnIndex), entry]
}

export function moveConfirmationMessage(names: string[], destinationPath: string) {
  const subject = names.length === 1 ? 'this item' : `these ${names.length} items`
  return `Move ${subject} to “${destinationPath}”?\n\n${names.map(name => `• ${name}`).join('\n')}`
}
