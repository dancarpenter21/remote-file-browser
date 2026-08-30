export type DelegatedFile = {
  reference: string
  name: string
  path: string
  mime: string
  size: number
  etag: string
}

export type Capability = {
  sessionId: string
  appId: string
  action: string
  csrfToken: string
  files: DelegatedFile[]
  canWriteOriginal: boolean
}

export type Session = { authenticated: boolean; csrfToken?: string }

async function problem(response: Response): Promise<never> {
  const body = await response.json().catch(() => ({ message: response.statusText })) as { message?: string }
  throw new Error(body.message ?? response.statusText)
}

export async function exchange(ticket: string): Promise<Capability> {
  const response = await fetch('/api/v1/launches/exchange', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }),
  })
  if (!response.ok) return problem(response)
  const capability = await response.json() as Capability
  if (capability.appId !== 'text-editor' || capability.action !== 'open' || capability.files.length !== 1 || !capability.canWriteOriginal) {
    throw new Error('This launch is not a writable Text Editor request.')
  }
  return capability
}

export async function readDocument(capability: Capability): Promise<string> {
  const file = capability.files[0]
  const response = await fetch(`/api/v1/delegated/sessions/${encodeURIComponent(capability.sessionId)}/files/${encodeURIComponent(file.reference)}/content`, { credentials: 'same-origin' })
  if (!response.ok) return problem(response)
  return response.text()
}

export async function saveDocument(capability: Capability, content: string): Promise<DelegatedFile> {
  const file = capability.files[0]
  const response = await fetch(`/api/v1/delegated/sessions/${encodeURIComponent(capability.sessionId)}/files/${encodeURIComponent(file.reference)}/content`, {
    method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'text/plain;charset=utf-8', 'x-app-csrf-token': capability.csrfToken }, body: content,
  })
  if (!response.ok) return problem(response)
  return response.json() as Promise<DelegatedFile>
}

export async function launchRelative(fileId: string): Promise<string> {
  const sessionResponse = await fetch('/api/v1/auth/session', { credentials: 'same-origin' })
  if (!sessionResponse.ok) return problem(sessionResponse)
  const session = await sessionResponse.json() as Session
  if (!session.authenticated || !session.csrfToken) throw new Error('The Files session has expired.')
  const response = await fetch('/api/v1/launches', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
    body: JSON.stringify({ appId: 'text-editor', action: 'open', fileIds: [fileId] }),
  })
  if (!response.ok) return problem(response)
  const launch = await response.json() as { launchUrl: string }
  return new URL(launch.launchUrl, location.origin).hash.slice('#ticket='.length)
}
