import { describe, expect, it } from 'vitest'
import { clampTerminalHeight, parseTerminalControl } from './terminalState'

describe('terminal controls', () => {
  it('parses ready, exit, and error messages', () => {
    expect(parseTerminalControl('{"type":"ready"}')).toEqual({ type: 'ready' })
    expect(parseTerminalControl('{"type":"exit","code":0}')).toEqual({ type: 'exit', code: 0 })
    expect(parseTerminalControl('{"type":"error","message":"failed"}')).toEqual({ type: 'error', message: 'failed' })
  })

  it('rejects malformed and unknown messages', () => {
    expect(parseTerminalControl('nope')).toBeNull()
    expect(parseTerminalControl('{"type":"other"}')).toBeNull()
    expect(parseTerminalControl('{"type":"error","message":4}')).toBeNull()
  })
})

describe('terminal dock height', () => {
  it('keeps the panel between its minimum and 70 percent of available space', () => {
    expect(clampTerminalHeight(100, 1000)).toBe(180)
    expect(clampTerminalHeight(400, 1000)).toBe(400)
    expect(clampTerminalHeight(900, 1000)).toBe(700)
  })
})
