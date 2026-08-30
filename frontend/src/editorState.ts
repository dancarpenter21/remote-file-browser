export type ScrollMetrics = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

type SaveShortcutEvent = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
}

type WheelMetrics = {
  deltaY: number
  deltaMode: number
}

export function proportionalScrollTop(source: ScrollMetrics, target: Omit<ScrollMetrics, 'scrollTop'>) {
  const sourceRange = Math.max(0, source.scrollHeight - source.clientHeight)
  const targetRange = Math.max(0, target.scrollHeight - target.clientHeight)
  if (sourceRange === 0 || targetRange === 0) return 0
  const progress = Math.min(1, Math.max(0, source.scrollTop / sourceRange))
  return progress * targetRange
}

export function wheelDeltaPixels(event: WheelMetrics, lineHeight: number, pageHeight: number) {
  if (event.deltaMode === 1) return event.deltaY * lineHeight
  if (event.deltaMode === 2) return event.deltaY * pageHeight
  return event.deltaY
}

export function editorSaveShortcut(event: SaveShortcutEvent) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !event.repeat && event.key.toLowerCase() === 's'
}

export function shouldApplyDocumentResponse(requestGeneration: number, currentGeneration: number, requestedId: string, responseId: string) {
  return requestGeneration === currentGeneration && requestedId === responseId
}

export function activeTabAfterClose(tabIds: string[], activeId: string | null, closingId: string) {
  if (activeId !== closingId) return activeId
  const closingIndex = tabIds.indexOf(closingId)
  if (closingIndex < 0) return activeId
  return tabIds[closingIndex + 1] ?? tabIds[closingIndex - 1] ?? null
}

export function appendDocumentTab<T extends { document: { id: string } }>(tabs: T[], tab: T) {
  return tabs.some(current => current.document.id === tab.document.id) ? tabs : [...tabs, tab]
}
