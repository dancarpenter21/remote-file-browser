export type DelegatedFile = {
  reference: string
  id: string
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
  canCreateSibling: boolean
}

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
  if (capability.appId !== 'image-tools' || capability.action !== 'open' || !capability.files.length || !capability.canCreateSibling) {
    throw new Error('This launch is not an Image Tools request.')
  }
  return capability
}

export function contentUrl(capability: Capability, file: DelegatedFile) {
  return `/api/v1/delegated/sessions/${encodeURIComponent(capability.sessionId)}/files/${encodeURIComponent(file.reference)}/content?v=${encodeURIComponent(file.etag)}`
}

export async function publishMarkup(capability: Capability, file: DelegatedFile, png: Blob): Promise<{ id: string; name: string }> {
  const stem = file.name.replace(/\.[^.]+$/, '') || 'image'
  const body = new FormData()
  body.append('file', png, `${stem}-markup.png`)
  const response = await fetch(`/api/v1/delegated/sessions/${encodeURIComponent(capability.sessionId)}/outputs?sourceRef=${encodeURIComponent(file.reference)}&name=${encodeURIComponent(`${stem}-markup.png`)}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'x-app-csrf-token': capability.csrfToken }, body,
  })
  if (!response.ok) return problem(response)
  return response.json() as Promise<{ id: string; name: string }>
}
