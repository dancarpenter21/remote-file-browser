export type Entry = {
  id: string
  parentId: string
  path: string
  name: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mode: number
  permissions: string
  uid: number
  gid: number
  modifiedAt?: string
  accessedAt?: string
  createdAt?: string
  mime: string
  symlinkTarget?: string
  etag: string
  hasProvenance: boolean
  childFileCount?: number
  childDirectoryCount?: number
}

export type EntryPage = { entries: Entry[]; total: number; nextOffset?: number }
export type Session = { authenticated: boolean; username?: string; csrfToken?: string; terminalEnabled: boolean; videoStudioEnabled: boolean }
export type InstalledAppAction = { id: string; label: string; accepts: string[]; minFiles: number; maxFiles: number }
export type InstalledApp = { id: string; name: string; launchUrl: string; actions: InstalledAppAction[] }
export type AppLaunch = { launchUrl: string; expiresAt: string }
export type DocumentFile = { id: string; content: string; etag: string; mime: string }
export type TrashEntry = {
  info: { id: string; originalId: string; originalName: string; deletedAt: string }
  kind: string
  size: number
}
export type Provenance = { urls: string[] }
export type ProvenanceChange = { id: string; path?: string; urls: string[] }
export type LiveEvent =
  | { type: 'resync' }
  | { type: 'filesystem'; directoryIds: string[] }
  | { type: 'provenance'; change: ProvenanceChange }

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

let csrf = ''
export const setCsrf = (value?: string) => { csrf = value ?? '' }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData)) headers.set('content-type', 'application/json')
  if (init.method && !['GET', 'HEAD'].includes(init.method)) headers.set('x-csrf-token', csrf)
  const response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' })
  if (!response.ok) {
    const problem = await response.json().catch(() => ({ code: 'request_failed', message: response.statusText }))
    throw new ApiFailure(response.status, problem.code, problem.message)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const api = {
  session: () => request<Session>('/auth/session'),
  login: (username: string, password: string) => request<Session>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  apps: () => request<InstalledApp[]>('/apps'),
  launchApp: (appId: string, action: string, fileIds: string[]) => request<AppLaunch>('/launches', { method: 'POST', body: JSON.stringify({ appId, action, fileIds }) }),
  list: (id = '', hidden = false) => request<EntryPage>(`/fs/entries?id=${encodeURIComponent(id)}&hidden=${hidden}&limit=1000`),
  metadata: (id: string) => request<Entry>(`/fs/metadata?id=${encodeURIComponent(id)}`),
  create: (parentId: string, name: string, kind: 'file' | 'directory', replace = false) => request<Entry>('/fs/items', { method: 'POST', body: JSON.stringify({ parentId, name, kind, replace }) }),
  upload: async (parentId: string, files: FileList, replace = false) => {
    const body = new FormData(); Array.from(files).forEach(file => body.append('files', file, file.name))
    return request<Entry[]>(`/fs/uploads?id=${encodeURIComponent(parentId)}&replace=${replace}`, { method: 'POST', body })
  },
  operate: (operation: 'copy' | 'move' | 'rename', sources: string[], destinationId: string, name?: string, replace = false, merge = false) => request<Entry[]>('/fs/operations', { method: 'POST', body: JSON.stringify({ operation, sources, destinationId, name, replace, merge }) }),
  provenance: (id: string) => request<Provenance>(`/fs/provenance?id=${encodeURIComponent(id)}`),
  setProvenance: (id: string, urls: string[]) => request<Provenance>(`/fs/provenance?id=${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ urls }) }),
  readDocument: (id: string) => request<DocumentFile>(`/editor/document?id=${encodeURIComponent(id)}`),
  saveDocument: (document: DocumentFile) => request<DocumentFile>('/editor/document', { method: 'PUT', body: JSON.stringify({ id: document.id, content: document.content, expectedEtag: document.etag }) }),
  trash: (ids: string[]) => request<void>('/fs/trash', { method: 'POST', body: JSON.stringify({ ids }) }),
  listTrash: () => request<TrashEntry[]>('/trash'),
  restore: (id: string, destinationId?: string, replace = false) => request<Entry>(`/trash/${id}/restore`, { method: 'POST', body: JSON.stringify({ destinationId, replace }) }),
  purge: (id: string) => request<void>(`/trash/${id}`, { method: 'DELETE' }),
  emptyTrash: () => request<void>('/trash', { method: 'DELETE' }),
  terminalTicket: (directoryId: string) => request<{ ticket: string }>('/terminal/tickets', { method: 'POST', body: JSON.stringify({ directoryId }) }),
}

export const contentUrl = (id: string) => `/api/v1/fs/content?id=${encodeURIComponent(id)}`
export const mediaUrl = (id: string, version: string) => `/api/v1/media/file?id=${encodeURIComponent(id)}&v=${encodeURIComponent(version)}`
export const thumbnailUrl = (id: string, size: string, version: string) => `/api/v1/previews/thumbnail?id=${encodeURIComponent(id)}&size=${size}&v=${encodeURIComponent(version)}`
export const liveEventsUrl = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/events`
export const liveFilesystemWatchMessage = (directoryIds: string[]) => JSON.stringify({
  type: 'watchFilesystem',
  directoryIds: [...new Set(directoryIds)],
})
export const terminalUrl = (ticket: string) => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/terminal/ws?ticket=${encodeURIComponent(ticket)}`
