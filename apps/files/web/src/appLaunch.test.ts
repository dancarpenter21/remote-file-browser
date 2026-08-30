import { describe, expect, it, vi } from 'vitest'
import { launchInstalledApp } from './appLaunch'

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
