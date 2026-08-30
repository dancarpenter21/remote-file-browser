export type ClipboardOperation = 'copy' | 'move'
export type RemoteClipboard = { operation: ClipboardOperation; ids: string[] } | null
export type ClipboardShortcut = ClipboardOperation | 'paste'

type ShortcutEvent = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
}

export type ClipboardEntry = {
  id: string
  parentId: string
  path: string
  kind: string
}

export function clipboardShortcut(event: ShortcutEvent): ClipboardShortcut | null {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey || event.repeat) return null
  switch (event.key.toLowerCase()) {
    case 'c': return 'copy'
    case 'x': return 'move'
    case 'v': return 'paste'
    default: return null
  }
}

export function clipboardIdsForEntry(entryId: string, selected: ReadonlySet<string>) {
  return selected.has(entryId) ? Array.from(selected) : [entryId]
}

export function shouldHandleClipboardShortcut(hasNativeSelection: boolean, blockedContext: boolean) {
  return !hasNativeSelection && !blockedContext
}

export function pasteProblem(operation: ClipboardOperation, sources: ClipboardEntry[], destinationId: string, destinationPath: string) {
  if (sources.some(source => source.kind === 'directory' && (source.id === destinationId || destinationPath.startsWith(`${source.path}/`)))) {
    return 'A directory cannot be copied or moved inside itself.'
  }
  if (operation === 'copy' && sources.some(source => source.parentId === destinationId)) {
    return 'An item cannot be copied onto itself. Choose a different destination.'
  }
  return null
}

export function movableClipboardIds(ids: string[], sources: ClipboardEntry[], destinationId: string) {
  const known = new Map(sources.map(source => [source.id, source]))
  return ids.filter(id => known.get(id)?.parentId !== destinationId)
}
