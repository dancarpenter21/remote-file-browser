export type TerminalControl =
  | { type: 'ready' }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; message: string }

export function parseTerminalControl(value: string): TerminalControl | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return null
    if (parsed.type === 'ready') return { type: 'ready' }
    if (parsed.type === 'exit' && ('code' in parsed) && (parsed.code === null || typeof parsed.code === 'number')) {
      return { type: 'exit', code: parsed.code }
    }
    if (parsed.type === 'error' && ('message' in parsed) && typeof parsed.message === 'string') {
      return { type: 'error', message: parsed.message }
    }
  } catch { /* ignored */ }
  return null
}

export function clampTerminalHeight(height: number, availableHeight: number) {
  return Math.round(Math.min(Math.max(180, height), Math.max(180, availableHeight * .7)))
}
