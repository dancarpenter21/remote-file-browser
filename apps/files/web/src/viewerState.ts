import type { Entry } from './api'
import type { BasicFileKind } from './basicFileView'

export type VideoPlaybackState = { playing: boolean; muted: boolean }
export type VideoCommand = { sequence: number; action: 'toggle-playback' | 'toggle-muted' | 'pause' }

export type FileViewer = {
  key: string
  entry: Entry
  kind: BasicFileKind
  minimized: boolean
  previewing?: boolean
  fragment?: string
  closeRequest: number
  playback?: VideoPlaybackState
  videoCommand?: VideoCommand
}

export type ViewerOpen = Pick<FileViewer, 'key' | 'entry' | 'kind'> & Partial<Pick<FileViewer, 'previewing' | 'fragment'>>

export function openOrFocusViewer(viewers: FileViewer[], requested: ViewerOpen): FileViewer[] {
  const existing = viewers.find(viewer => viewer.entry.id === requested.entry.id)
  if (existing) {
    return [...viewers.filter(viewer => viewer.key !== existing.key), {
      ...existing,
      minimized: false,
      previewing: requested.previewing ?? existing.previewing,
      fragment: requested.fragment ?? existing.fragment,
    }]
  }
  return [...viewers, { ...requested, minimized: false, closeRequest: 0 }]
}

export function focusViewer(viewers: FileViewer[], key: string, restore = true): FileViewer[] {
  const existing = viewers.find(viewer => viewer.key === key)
  if (!existing) return viewers
  return [...viewers.filter(viewer => viewer.key !== key), { ...existing, minimized: restore ? false : existing.minimized }]
}

export function minimizeViewer(viewers: FileViewer[], key: string): FileViewer[] {
  return viewers.map(viewer => viewer.key === key ? { ...viewer, minimized: true } : viewer)
}

export function removeViewer(viewers: FileViewer[], key: string): FileViewer[] {
  return viewers.filter(viewer => viewer.key !== key)
}

export function requestViewerClose(viewers: FileViewer[], key: string): FileViewer[] {
  return viewers.map(viewer => viewer.key === key ? { ...viewer, closeRequest: viewer.closeRequest + 1 } : viewer)
}

export function navigateViewer(viewers: FileViewer[], key: string, entry: Entry, kind: BasicFileKind): FileViewer[] {
  const duplicate = viewers.find(viewer => viewer.key !== key && viewer.entry.id === entry.id)
  if (duplicate) return focusViewer(viewers, duplicate.key)
  return viewers.map(viewer => viewer.key === key ? {
    ...viewer,
    entry,
    kind,
    previewing: kind === 'text' && viewer.previewing,
    fragment: undefined,
    playback: undefined,
    videoCommand: undefined,
  } : viewer)
}

export function activeViewer(viewers: FileViewer[]): FileViewer | undefined {
  for (let index = viewers.length - 1; index >= 0; index -= 1) {
    if (!viewers[index].minimized) return viewers[index]
  }
  return undefined
}
