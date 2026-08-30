import { apiUrl } from './urls.js'

export type DelegatedFile = { reference: string; id: string; name: string; path: string; mime: string; size: number; etag: string; integrationKey: string }
export type Capability = { localId: string; sessionId: string; appId: string; action: 'play' | 'edit' | 'concatenate'; csrfToken: string; files: DelegatedFile[]; canCreateSibling: boolean }

export function ticketFromHash(hash = location.hash) {
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('ticket')
}

export async function exchangeHandoff(ticket: string): Promise<Capability> {
  const response = await fetch(apiUrl('/handoffs/exchange'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText })) as { message?: string }
    throw new Error(body.message ?? response.statusText)
  }
  const capability = await response.json() as Capability
  if (capability.appId !== 'video-studio' || !['play', 'edit', 'concatenate'].includes(capability.action)) throw new Error('This launch is not a Video Studio request.')
  return capability
}

export const delegatedBase = (capability: Capability, file = capability.files[0]) => {
  if (!file) throw new Error('The Video Studio handoff contains no files.')
  return apiUrl(`/handoffs/${encodeURIComponent(capability.localId)}/files/${encodeURIComponent(file.reference)}`)
}
