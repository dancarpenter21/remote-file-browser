export function formatMediaTime(seconds: number) {
  const millis = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000))
  const hours = Math.floor(millis / 3_600_000)
  const minutes = Math.floor(millis / 60_000) % 60
  const wholeSeconds = Math.floor(millis / 1000) % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(millis % 1000).padStart(3, '0')}`
}

export function stepFrame(current: number, direction: -1 | 1, frameRate: number, duration: number) {
  if (!Number.isFinite(frameRate) || frameRate <= 0 || !Number.isFinite(duration) || duration <= 0) return current
  // Media elements commonly report a seek a fraction of a frame before its target.
  // Treat that as the boundary so repeated forward steps cannot select the same frame.
  const boundaryTolerance = 5e-2
  const frame = direction < 0
    ? Math.ceil(current * frameRate - boundaryTolerance) - 1
    : Math.floor(current * frameRate + boundaryTolerance) + 1
  return Math.min(Math.max(0, duration - 1 / frameRate), Math.max(0, frame / frameRate))
}

export function fitMediaWindow(mediaWidth: number, mediaHeight: number, maxWidth: number, maxHeight: number, chromeHeight: number) {
  if (![mediaWidth, mediaHeight, maxWidth, maxHeight].every(value => Number.isFinite(value) && value > 0)) return undefined
  const availableMediaHeight = Math.max(1, maxHeight - chromeHeight)
  const scale = Math.min(1, maxWidth / mediaWidth, availableMediaHeight / mediaHeight)
  return {
    width: Math.min(maxWidth, Math.max(360, Math.round(mediaWidth * scale))),
    height: Math.min(maxHeight, Math.max(260, Math.round(mediaHeight * scale + chromeHeight))),
  }
}

export function validSegment(markIn?: number, markOut?: number): markIn is number {
  return Number.isFinite(markIn) && Number.isFinite(markOut) && markIn! >= 0 && markOut! > markIn!
}

export function ignoresVideoShortcut(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : document.activeElement
  if (!(element instanceof HTMLElement)) return false
  return element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(element.tagName)
}
