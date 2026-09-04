export const DIRECT_PLAYBACK_TIMEOUT_MS = 5_000

export interface PlaybackFallbackGate {
  readonly started: boolean
  claim(): boolean
  reset(): void
}

export function createPlaybackFallbackGate(): PlaybackFallbackGate {
  let started = false
  return {
    get started() { return started },
    claim() { if (started) return false; started = true; return true },
    reset() { started = false },
  }
}

export function hlsRecoveryAction(type: string, networkRecoveries: number, mediaRecoveries: number) {
  if (type === 'networkError' && networkRecoveries < 1) return 'retry-network' as const
  if (type === 'mediaError' && mediaRecoveries < 1) return 'recover-media' as const
  return 'fail' as const
}

export function formatMediaTime(seconds: number): string {
  const milliseconds = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds / 60_000) % 60
  const secs = Math.floor(milliseconds / 1000) % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`
}

export function stepFrameTime(current: number, direction: -1 | 1, frameRate: number, duration: number): number {
  if (!Number.isFinite(frameRate) || frameRate <= 0 || !Number.isFinite(duration) || duration <= 0) return current
  const frame = direction < 0
    ? Math.ceil(current * frameRate - 0.05) - 1
    : Math.floor(current * frameRate + 0.05) + 1
  return Math.min(Math.max(0, duration - 1 / frameRate), Math.max(0, frame / frameRate))
}

export function validSegment(markIn?: number, markOut?: number): markIn is number {
  return Number.isFinite(markIn) && Number.isFinite(markOut) && markIn! >= 0 && markOut! > markIn!
}

export function shouldAutoLoop(duration: number): boolean {
  return Number.isFinite(duration) && duration > 0 && duration < 40
}

export function ignoresVideoShortcut(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
}
