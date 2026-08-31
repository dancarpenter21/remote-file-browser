import { describe, expect, it, vi } from 'vitest'
import { launchInstalledApp, launchReusableImageTools } from './appLaunch'

describe('launchInstalledApp', () => {
  it('opens synchronously and replaces the placeholder with the scoped launch URL', async () => {
    const replace = vi.fn(), close = vi.fn()
    const open = vi.fn(() => ({ close, location: { replace } }))
    await launchInstalledApp('/apps/video/?handoff=1', open, async () => ({ launchUrl: '/apps/video/#ticket=one', expiresAt: '' }))
    expect(open).toHaveBeenCalledWith('/apps/video/?handoff=1', '_blank')
    expect(replace).toHaveBeenCalledWith('/apps/video/#ticket=one')
    expect(close).not.toHaveBeenCalled()
  })

  it('closes the placeholder when launch creation fails', async () => {
    const close = vi.fn()
    await expect(launchInstalledApp('/apps/video/?handoff=1', () => ({ close, location: { replace: vi.fn() } }), async () => { throw new Error('failed') })).rejects.toThrow('failed')
    expect(close).toHaveBeenCalled()
  })
})

describe('launchReusableImageTools', () => {
  it('uses a stable window and relays the single-use ticket after readiness', async () => {
    const messages: unknown[] = []
    class Channel {
      onmessage?: (event: MessageEvent) => void
      postMessage(message: unknown) {
        messages.push(message)
        const request = message as { type?: string; requestId?: string }
        if (request.type === 'ping') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready', requestId: request.requestId } } as MessageEvent))
      }
      close() {}
    }
    vi.stubGlobal('BroadcastChannel', Channel)
    vi.stubGlobal('location', { origin: 'https://files.test' })
    const focus = vi.fn(), open = vi.fn(() => ({ focus }) as unknown as Window)
    await launchReusableImageTools('/apps/images/', async () => ({ launchUrl: '/apps/images/#ticket=gallery', expiresAt: '' }), open)
    expect(open).toHaveBeenCalledWith('/apps/images/', 'remote-workspace-image-tools')
    expect(messages).toContainEqual({ type: 'launch', ticket: 'gallery' })
    expect(focus).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
