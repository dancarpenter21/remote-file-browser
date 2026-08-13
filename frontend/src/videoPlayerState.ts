export function formatMediaTime(seconds: number) {
  const millis = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000))
  const hours = Math.floor(millis / 3_600_000)
  const minutes = Math.floor(millis / 60_000) % 60
  const wholeSeconds = Math.floor(millis / 1000) % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(millis % 1000).padStart(3, '0')}`
}

export function stepFrame(current: number, direction: -1 | 1, frameRate: number, duration: number) {
  if (!Number.isFinite(frameRate) || frameRate <= 0 || !Number.isFinite(duration) || duration <= 0) return current
  const frame = direction < 0
    ? Math.ceil(current * frameRate - 1e-6) - 1
    : Math.floor(current * frameRate + 1e-6) + 1
  return Math.min(Math.max(0, duration - 1 / frameRate), Math.max(0, frame / frameRate))
}

export function validSegment(markIn?: number, markOut?: number): markIn is number {
  return Number.isFinite(markIn) && Number.isFinite(markOut) && markIn! >= 0 && markOut! > markIn!
}

export function ignoresVideoShortcut(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : document.activeElement
  if (!(element instanceof HTMLElement)) return false
  return element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(element.tagName)
}
