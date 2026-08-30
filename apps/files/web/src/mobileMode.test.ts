import { describe, expect, it, vi } from 'vitest'
import { MOBILE_MEDIA_QUERY, observeMobileMode } from './mobileMode'

describe('observeMobileMode', () => {
  it('reports the initial value, follows changes, and unsubscribes', () => {
    let listener: (() => void) | undefined
    const media = {
      matches: true,
      addEventListener: vi.fn((_type: string, next: () => void) => { listener = next }),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList
    const matchMedia = vi.fn(() => media)
    const changed = vi.fn()

    const stop = observeMobileMode(matchMedia, changed)
    expect(matchMedia).toHaveBeenCalledWith(MOBILE_MEDIA_QUERY)
    expect(changed).toHaveBeenLastCalledWith(true)

    Object.defineProperty(media, 'matches', { value: false })
    listener?.()
    expect(changed).toHaveBeenLastCalledWith(false)

    stop()
    expect(media.removeEventListener).toHaveBeenCalledWith('change', listener)
  })
})
