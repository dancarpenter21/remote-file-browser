import { describe, expect, it } from 'vitest'
import type { Entry } from './api'
import { activeViewer, focusViewer, minimizeViewer, navigateViewer, openOrFocusViewer, removeViewer, requestViewerClose, type FileViewer } from './viewerState'

const entry = (id: string, mime = 'text/plain') => ({ id, name: id, mime, kind: 'file' } as Entry)
const viewer = (key: string, id = key, mime = 'text/plain'): FileViewer => ({ key, entry: entry(id, mime), kind: mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'text', minimized: false, closeRequest: 0 })

describe('embedded viewer state', () => {
  it('opens unlimited mixed viewers and focuses an existing file without duplicating it', () => {
    let state: FileViewer[] = []
    state = openOrFocusViewer(state, { key: 'a', entry: entry('a'), kind: 'text' })
    state = openOrFocusViewer(state, { key: 'b', entry: entry('b', 'image/png'), kind: 'image' })
    state = openOrFocusViewer(state, { key: 'c', entry: entry('c', 'video/mp4'), kind: 'video' })
    state = openOrFocusViewer(state, { key: 'unused', entry: entry('a'), kind: 'text' })
    expect(state.map(item => item.key)).toEqual(['b', 'c', 'a'])
  })

  it('tracks focus, minimization, close requests, and active fallbacks', () => {
    let state = [viewer('a'), viewer('b'), viewer('c')]
    state = focusViewer(state, 'a')
    expect(activeViewer(state)?.key).toBe('a')
    state = minimizeViewer(state, 'a')
    expect(activeViewer(state)?.key).toBe('c')
    state = requestViewerClose(state, 'b')
    expect(state.find(item => item.key === 'b')?.closeRequest).toBe(1)
    state = removeViewer(state, 'c')
    expect(activeViewer(state)?.key).toBe('b')
  })

  it('navigates within a viewer or focuses an already-open destination', () => {
    const first = viewer('gallery', 'one', 'image/png')
    const second = viewer('other', 'two', 'image/png')
    expect(navigateViewer([first], 'gallery', entry('two', 'image/png'), 'image')[0].entry.id).toBe('two')
    expect(navigateViewer([first, second], 'gallery', entry('two', 'image/png'), 'image').map(item => item.key)).toEqual(['gallery', 'other'])
  })
})
