import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, RefreshCw, SquareTerminal, X } from 'lucide-react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { api, terminalUrl } from './api'
import { clampTerminalHeight, parseTerminalControl } from './terminalState'

type TerminalStatus = 'connecting' | 'connected' | 'exited' | 'error' | 'disconnected'

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The terminal could not be started'
}

export function TerminalDock({ directoryId, hidden, onHide, onClose }: {
  directoryId: string
  hidden: boolean
  onHide: () => void
  onClose: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const dock = useRef<HTMLElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const socket = useRef<WebSocket | null>(null)
  const stopResize = useRef<() => void>(() => {})
  const hiddenRef = useRef(hidden)
  hiddenRef.current = hidden
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<TerminalStatus>('connecting')
  const [height, setHeight] = useState(() => clampTerminalHeight(Number(localStorage.getItem('rfb-terminal-height')) || 320, innerHeight))

  useEffect(() => { localStorage.setItem('rfb-terminal-height', String(height)) }, [height])
  useEffect(() => () => stopResize.current(), [])

  useEffect(() => {
    const container = host.current
    if (!container) return
    let disposed = false
    let ended = false
    setStatus('connecting')
    container.replaceChildren()
    const instance = new Terminal({
      cursorBlink: true,
      fontFamily: '"MesloLGS NF", "DejaVu Sans Mono", monospace',
      fontSize: 14,
      lineHeight: 1.1,
      scrollback: 5000,
      theme: {
        background: '#0b0b0b', foreground: '#dedede', cursor: '#d8d8d8', selectionBackground: '#60706088',
        black: '#202020', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d8d8d8',
      },
    })
    const fitter = new FitAddon()
    instance.loadAddon(fitter)
    instance.open(container)
    terminal.current = instance
    fit.current = fitter
    const fitTerminal = () => {
      if (disposed || hiddenRef.current || !container.clientWidth || !container.clientHeight) return
      try { fitter.fit() } catch { /* the dock may be transitioning */ }
    }
    fitTerminal()
    void document.fonts?.load('14px "MesloLGS NF"').then(fitTerminal)
    const observer = new ResizeObserver(fitTerminal)
    observer.observe(container)
    const input = instance.onData(data => {
      if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'input', data }))
    })
    const resized = instance.onResize(({ cols, rows }) => {
      if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'resize', cols, rows }))
    })

    void api.terminalTicket(directoryId).then(({ ticket }) => {
      if (disposed) return
      const connection = new WebSocket(terminalUrl(ticket))
      connection.binaryType = 'arraybuffer'
      socket.current = connection
      connection.onmessage = event => {
        if (event.data instanceof ArrayBuffer) {
          instance.write(new Uint8Array(event.data))
          return
        }
        if (typeof event.data !== 'string') return
        const control = parseTerminalControl(event.data)
        if (control?.type === 'ready') {
          setStatus('connected'); fitTerminal()
          connection.send(JSON.stringify({ type: 'resize', cols: instance.cols, rows: instance.rows }))
          if (!hiddenRef.current) instance.focus()
        } else if (control?.type === 'exit') {
          ended = true; setStatus('exited')
          instance.writeln(`\r\n[Process exited${control.code === null ? '' : ` with code ${control.code}`}]`)
        } else if (control?.type === 'error') {
          ended = true; setStatus('error'); instance.writeln(`\r\n[${control.message}]`)
        }
      }
      connection.onclose = () => {
        if (!disposed && !ended) { setStatus('disconnected'); instance.writeln('\r\n[Terminal disconnected]') }
      }
      connection.onerror = () => connection.close()
    }).catch(error => {
      if (disposed) return
      ended = true; setStatus('error'); instance.writeln(`\r\n[${errorMessage(error)}]`)
    })

    return () => {
      disposed = true
      observer.disconnect(); input.dispose(); resized.dispose()
      socket.current?.close(); socket.current = null
      terminal.current = null; fit.current = null; instance.dispose()
    }
  }, [attempt, directoryId])

  useLayoutEffect(() => {
    if (hidden) return
    const frame = requestAnimationFrame(() => {
      try { fit.current?.fit() } catch { /* terminal is still mounting */ }
      terminal.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [hidden, height])

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault()
    stopResize.current()
    const startY = event.clientY, startHeight = height
    const available = dock.current?.parentElement?.clientHeight ?? innerHeight
    const move = (pointer: PointerEvent) => setHeight(clampTerminalHeight(startHeight + startY - pointer.clientY, available))
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up)
      stopResize.current = () => {}
    }
    stopResize.current = up
    addEventListener('pointermove', move); addEventListener('pointerup', up)
  }

  const retryable = status === 'error' || status === 'disconnected' || status === 'exited'
  return <section ref={dock} className={`terminal-dock ${hidden ? 'hidden' : ''}`} style={{ height }} aria-label="Integrated terminal" aria-hidden={hidden}>
    <div className="terminal-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize terminal" onPointerDown={startResize} />
    <header className="terminal-heading">
      <span><SquareTerminal /> Terminal</span>
      <small className={`terminal-status ${status}`}>{status}</small>
      <span className="toolbar-spacer" />
      {retryable && <button type="button" title="Start a new terminal" onClick={() => setAttempt(value => value + 1)}><RefreshCw /> Restart</button>}
      <button type="button" className="icon-button" title="Hide terminal" aria-label="Hide terminal" onClick={onHide}><ChevronDown /></button>
      <button type="button" className="icon-button" title="Close terminal" aria-label="Close terminal" onClick={onClose}><X /></button>
    </header>
    <div ref={host} className="terminal-host" />
  </section>
}
