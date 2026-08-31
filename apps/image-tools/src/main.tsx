import React, { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChevronLeft, ChevronRight, Download, Eraser, Pencil, RotateCw, Ruler, Save, Undo2, ZoomIn, ZoomOut } from 'lucide-react'
import { exchange, contentUrl, publishMarkup, type Capability, type DelegatedFile } from './api'
import { canvasPng, drawMarkupStroke, markupPoint, markupStrokeWidth, type MarkupStroke } from './imageMarkup'
import { measurementMetrics, measurementPoint, type MeasurementPoint, type PixelMeasurement } from './imageMeasurement'
import { fitImageWindow } from './windowSizing'
import './styles.css'

const channel = new BroadcastChannel('remote-workspace:image-tools')
const ticketFromHash = () => new URLSearchParams(location.hash.slice(1)).get('ticket')

function App() {
  const [capability, setCapability] = useState<Capability>()
  const [activeIndex, setActiveIndex] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [rotate, setRotate] = useState(0)
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>()
  const [marking, setMarking] = useState(false)
  const [measuring, setMeasuring] = useState(false)
  const [measurement, setMeasurement] = useState<PixelMeasurement | null>(null)
  const [strokes, setStrokes] = useState<MarkupStroke[]>([])
  const [markupReady, setMarkupReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(Boolean(ticketFromHash()))
  const markupCanvas = useRef<HTMLCanvasElement>(null)
  const dirtyRef = useRef(false)
  const openingTickets = useRef(new Set<string>())
  dirtyRef.current = strokes.length > 0

  const resetTools = useCallback(() => {
    setZoom(1); setRotate(0); setDimensions(undefined); setMarking(false); setMeasuring(false); setMeasurement(null); setStrokes([]); setMarkupReady(false); setSaving(false); setMessage('')
  }, [])
  const openTicket = useCallback(async (ticket: string) => {
    if (!ticket || openingTickets.current.has(ticket)) return
    if (dirtyRef.current && !window.confirm('Discard unsaved markup and open the newly selected image?')) return
    openingTickets.current.add(ticket)
    setLoading(true); setMessage('')
    try {
      const next = await exchange(ticket)
      if (next.files.some(file => !file.mime.startsWith('image/'))) throw new Error('Image Tools received a non-image file.')
      resetTools(); setCapability(next); setActiveIndex(0)
      history.replaceState(null, '', `${location.pathname}${location.search}`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not open the image.') }
    finally { openingTickets.current.delete(ticket); setLoading(false) }
  }, [resetTools])

  useEffect(() => {
    const initial = ticketFromHash(); if (initial) void openTicket(initial)
    const receive = (event: MessageEvent) => {
      const request = event.data as { type?: string; requestId?: string; ticket?: string }
      if (request.type === 'ping') channel.postMessage({ type: 'ready', requestId: request.requestId })
      if (request.type === 'launch' && request.ticket) void openTicket(request.ticket)
    }
    channel.addEventListener('message', receive); channel.postMessage({ type: 'ready' })
    return () => channel.removeEventListener('message', receive)
  }, [openTicket])
  useEffect(() => {
    if (!strokes.length) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    addEventListener('beforeunload', warn); return () => removeEventListener('beforeunload', warn)
  }, [strokes.length])

  const files = capability?.files ?? []
  const file = files[activeIndex]
  const discard = useCallback(() => {
    if (saving) { setMessage('Wait for the markup to finish saving.'); return false }
    if (strokes.length && !window.confirm('Discard unsaved markup?')) return false
    setMarking(false); setMeasuring(false); setMeasurement(null); setStrokes([]); setMarkupReady(false); setMessage('')
    return true
  }, [saving, strokes.length])
  const navigate = useCallback((direction: -1 | 1) => {
    if (files.length < 2 || !discard()) return
    setActiveIndex(index => (index + direction + files.length) % files.length)
    setZoom(1); setRotate(0); setDimensions(undefined)
  }, [discard, files.length])
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (marking && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); setStrokes(current => current.slice(0, -1)); return }
      if (measuring && event.key === 'Escape') { event.preventDefault(); setMeasuring(false); setMeasurement(null); return }
      if (!marking && !measuring && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); navigate(event.key === 'ArrowLeft' ? -1 : 1) }
    }
    addEventListener('keydown', keyboard); return () => removeEventListener('keydown', keyboard)
  }, [marking, measuring, navigate])
  useEffect(() => {
    if (!dimensions || !window.opener) return
    const fitted = fitImageWindow(dimensions.width, dimensions.height, Math.min(1400, screen.availWidth - 40), Math.min(1000, screen.availHeight - 40), 148)
    if (fitted) window.resizeTo(fitted.width, fitted.height)
  }, [dimensions])

  if (!file || !capability) return <main className="empty"><h1>Image Tools</h1><p>{loading ? 'Opening image…' : message || 'Open an image from Files.'}</p></main>
  const metrics = measurement ? measurementMetrics(measurement) : null
  const toggleMarkup = () => {
    if (marking) { void discard(); return }
    setRotate(0); setMeasuring(false); setMeasurement(null); setStrokes([]); setMessage(''); setMarking(true)
  }
  const toggleMeasurement = () => {
    if (measuring) { setMeasuring(false); setMeasurement(null); return }
    if (marking && !discard()) return
    setRotate(0); setMeasurement(null); setMessage(''); setMeasuring(true)
  }
  const save = async () => {
    if (!markupCanvas.current || !strokes.length) return
    setSaving(true); setMessage('')
    try { const result = await publishMarkup(capability, file, await canvasPng(markupCanvas.current)); setStrokes([]); setMarking(false); setMessage(`Created ${result.name}`) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save markup.') }
    finally { setSaving(false) }
  }
  const source = contentUrl(capability, file)
  return <main className={`app ${marking ? 'marking' : measuring ? 'measuring' : ''}`}>
    <header><div><strong>Image Tools</strong><span title={file.path}>{file.name}</span></div><small>{activeIndex + 1} of {files.length}</small></header>
    <nav className="toolbar">
      <button onClick={() => setZoom(value => Math.max(.25, value - .25))}><ZoomOut /> <span>{Math.round(zoom * 100)}%</span></button>
      <button onClick={() => setZoom(value => Math.min(5, value + .25))}><ZoomIn /></button>
      <button disabled={marking || measuring} onClick={() => setRotate(value => value + 90)}><RotateCw /> Rotate</button>
      <button className={marking ? 'active' : ''} disabled={!dimensions} onClick={toggleMarkup}><Pencil /> Mark up</button>
      <button className={measuring ? 'active' : ''} disabled={!dimensions} onClick={toggleMeasurement}><Ruler /> Measure</button>
      {marking && <><button disabled={!strokes.length || saving} onClick={() => setStrokes(current => current.slice(0, -1))}><Undo2 /> Undo</button><button disabled={!strokes.length || saving} onClick={() => setStrokes([])}><Eraser /> Clear</button><button className="primary" disabled={!strokes.length || !markupReady || saving} onClick={() => void save()}><Save /> {saving ? 'Saving…' : 'Save copy'}</button></>}
      {measuring && <button disabled={!measurement} onClick={() => setMeasurement(null)}><Eraser /> Clear</button>}
      <span className="spacer" /><a className="button" href={source} download={file.name}><Download /> Download</a>
    </nav>
    {(message || measuring) && <div className="status" role="status">{message || (metrics ? `${metrics.distance.toFixed(2)} px · Δx ${metrics.deltaX} · Δy ${metrics.deltaY}` : measurement ? `Start ${measurement.start.x}, ${measurement.start.y} · choose the end point` : 'Choose the start point')}</div>}
    <section className="stage">
      <button className="previous" disabled={marking || files.length < 2} aria-label="Previous image" onClick={() => navigate(-1)}><ChevronLeft /></button>
      {marking ? <MarkupCanvas ref={markupCanvas} source={source} name={file.name} zoom={zoom} strokes={strokes} setStrokes={setStrokes} onDimensions={(width, height) => setDimensions({ width, height })} onReady={setMarkupReady} onError={setMessage} /> : measuring ? <MeasurementCanvas source={source} name={file.name} zoom={zoom} measurement={measurement} setMeasurement={setMeasurement} onDimensions={(width, height) => setDimensions({ width, height })} onError={setMessage} /> : <img src={source} alt={file.name} style={{ transform: `scale(${zoom}) rotate(${rotate}deg)` }} onLoad={event => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />}
      <button className="next" disabled={marking || files.length < 2} aria-label="Next image" onClick={() => navigate(1)}><ChevronRight /></button>
    </section>
  </main>
}

const MarkupCanvas = forwardRef<HTMLCanvasElement, { source: string; name: string; zoom: number; strokes: MarkupStroke[]; setStrokes: React.Dispatch<React.SetStateAction<MarkupStroke[]>>; onDimensions: (width: number, height: number) => void; onReady: (ready: boolean) => void; onError: (message: string) => void }>(function MarkupCanvas({ source, name, zoom, strokes, setStrokes, onDimensions, onReady, onError }, forwardedRef) {
  const canvasRef = useRef<HTMLCanvasElement>(null), sourceImage = useRef<HTMLImageElement | null>(null), activeStroke = useRef<{ pointerId: number; stroke: MarkupStroke } | null>(null)
  const assign = (canvas: HTMLCanvasElement | null) => { canvasRef.current = canvas; if (typeof forwardedRef === 'function') forwardedRef(canvas); else if (forwardedRef) forwardedRef.current = canvas }
  const paint = (current: MarkupStroke[]) => { const canvas = canvasRef.current, image = sourceImage.current, context = canvas?.getContext('2d'); if (!canvas || !image || !context) return; context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0); current.forEach(stroke => drawMarkupStroke(context, stroke, markupStrokeWidth(canvas.width, canvas.height))) }
  useEffect(() => { let cancelled = false; onReady(false); onError(''); const image = new Image(); image.onload = () => { if (cancelled || !canvasRef.current) return; canvasRef.current.width = image.naturalWidth; canvasRef.current.height = image.naturalHeight; sourceImage.current = image; onDimensions(image.naturalWidth, image.naturalHeight); paint(strokes); onReady(true) }; image.onerror = () => onError('The source image could not be loaded.'); image.src = source; return () => { cancelled = true; sourceImage.current = null; activeStroke.current = null } }, [source])
  useEffect(() => paint(strokes), [strokes])
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => markupPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), event.currentTarget.width, event.currentTarget.height)
  const start = (event: React.PointerEvent<HTMLCanvasElement>) => { if (event.button !== 0 || activeStroke.current || !sourceImage.current) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); activeStroke.current = { pointerId: event.pointerId, stroke: { points: [point(event)] } } }
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => { const active = activeStroke.current; if (!active || active.pointerId !== event.pointerId) return; event.preventDefault(); active.stroke.points.push(point(event)); paint([...strokes, active.stroke]) }
  const finish = (event: React.PointerEvent<HTMLCanvasElement>) => { const active = activeStroke.current; if (!active || active.pointerId !== event.pointerId) return; activeStroke.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setStrokes(current => [...current, active.stroke]) }
  return <canvas ref={assign} aria-label={`Mark up ${name}`} style={{ transform: `scale(${zoom})` }} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} />
})

function MeasurementCanvas({ source, name, zoom, measurement, setMeasurement, onDimensions, onError }: { source: string; name: string; zoom: number; measurement: PixelMeasurement | null; setMeasurement: React.Dispatch<React.SetStateAction<PixelMeasurement | null>>; onDimensions: (width: number, height: number) => void; onError: (message: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null), sourceImage = useRef<HTMLImageElement | null>(null)
  const paint = useCallback((current: PixelMeasurement | null) => { const canvas = canvasRef.current, image = sourceImage.current, context = canvas?.getContext('2d'); if (!canvas || !image || !context) return; context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0); if (!current) return; const width = Math.max(2, Math.min(12, Math.min(canvas.width, canvas.height) * .004)); context.save(); context.strokeStyle = '#50d7ff'; context.fillStyle = '#50d7ff'; context.lineWidth = width; context.lineCap = 'round'; if (current.end) { context.beginPath(); context.moveTo(current.start.x, current.start.y); context.lineTo(current.end.x, current.end.y); context.stroke() } const draw = (point: MeasurementPoint) => { context.beginPath(); context.arc(point.x, point.y, width * 1.8, 0, Math.PI * 2); context.fill() }; draw(current.start); if (current.end) draw(current.end); context.restore() }, [])
  useEffect(() => { let cancelled = false; onError(''); const image = new Image(); image.onload = () => { if (cancelled || !canvasRef.current) return; canvasRef.current.width = image.naturalWidth; canvasRef.current.height = image.naturalHeight; sourceImage.current = image; onDimensions(image.naturalWidth, image.naturalHeight); paint(measurement) }; image.onerror = () => onError('The source image could not be loaded.'); image.src = source; return () => { cancelled = true; sourceImage.current = null } }, [source])
  useEffect(() => paint(measurement), [measurement, paint])
  const choose = (event: React.PointerEvent<HTMLCanvasElement>) => { if (event.button !== 0 || !sourceImage.current) return; const point = measurementPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), event.currentTarget.width, event.currentTarget.height); setMeasurement(current => !current || current.end ? { start: point } : { ...current, end: point }) }
  return <canvas ref={canvasRef} aria-label={`Measure ${name}`} style={{ transform: `scale(${zoom})` }} onPointerDown={choose} />
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
