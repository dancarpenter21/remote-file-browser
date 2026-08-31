import { afterEach, describe, expect, it, vi } from 'vitest'
import { exchange, readDocument, saveDocument, type Capability } from './api'

afterEach(() => vi.unstubAllGlobals())

const capability = { sessionId: 'session', appId: 'text-editor', action: 'open', csrfToken: 'csrf', canWriteOriginal: true, files: [{ reference: 'ref', name: 'readme.md', path: '/fs-root/readme.md', mime: 'text/markdown', size: 4, etag: 'etag' }] } satisfies Capability

describe('Text Editor capability API', () => {
  it('exchanges only writable text-editor launches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(capability), { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(exchange('ticket')).resolves.toEqual(capability)
  })
  it('reads and writes only through the delegated reference', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('text', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(capability.files[0]), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(readDocument(capability)).resolves.toBe('text')
    await saveDocument(capability, 'updated')
    expect(fetchMock.mock.calls[1][0]).toContain('/sessions/session/files/ref/content')
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({ 'x-app-csrf-token': 'csrf' })
  })
})
