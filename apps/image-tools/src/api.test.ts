import { afterEach, describe, expect, it, vi } from 'vitest'
import { contentUrl, exchange, publishMarkup, type Capability } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('Image Tools capability API', () => {
  it('validates exchanged capabilities', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: 's', appId: 'image-tools', action: 'open', csrfToken: 'c', canCreateSibling: true, files: [{ reference: 'r', name: 'a.png', path: '/fs-root/a.png', mime: 'image/png', size: 1, etag: 'e' }] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(exchange('ticket')).resolves.toMatchObject({ appId: 'image-tools', action: 'open' })
  })
  it('builds scoped content and output requests', async () => {
    const capability = { sessionId: 'session', appId: 'image-tools', action: 'open', csrfToken: 'csrf', canCreateSibling: true, files: [{ reference: 'ref', id: 'id', name: 'photo.jpg', path: '/fs-root/photo.jpg', mime: 'image/jpeg', size: 1, etag: 'etag' }] } satisfies Capability
    expect(contentUrl(capability, capability.files[0])).toContain('/delegated/sessions/session/files/ref/content')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'new', name: 'photo-markup.png' }), { status: 201, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await publishMarkup(capability, capability.files[0], new Blob(['png']))
    expect(fetchMock.mock.calls[0][0]).toContain('name=photo-markup.png')
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({ 'x-app-csrf-token': 'csrf' })
  })
})
