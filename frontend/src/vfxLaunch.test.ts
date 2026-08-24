import { describe, expect, it, vi } from 'vitest'
import { launchVfxEditor } from './vfxLaunch'

describe('VFX Editor launch', () => {
  it('opens a loading tab before importing and navigates it to the project', async () => {
    const replace = vi.fn()
    const openWindow = vi.fn(() => ({ close: vi.fn(), location: { replace } }))
    const importProject = vi.fn(async () => ({ projectId: 'project id', reused: false }))
    await expect(launchVfxEditor('video-id', openWindow, importProject)).resolves.toEqual({ projectId: 'project id', reused: false })
    expect(openWindow).toHaveBeenCalledWith('/vfx/?handoff=1', '_blank')
    expect(importProject).toHaveBeenCalledWith('video-id')
    expect(replace).toHaveBeenCalledWith('/vfx/?project=project%20id&source=video-id')
  })

  it('does not import when the popup is blocked', async () => {
    const importProject = vi.fn()
    await expect(launchVfxEditor('video-id', () => null, importProject)).rejects.toThrow('Allow popups')
    expect(importProject).not.toHaveBeenCalled()
  })

  it('closes the loading tab when import fails', async () => {
    const close = vi.fn()
    await expect(launchVfxEditor('video-id', () => ({ close, location: { replace: vi.fn() } }), async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(close).toHaveBeenCalled()
  })
})
