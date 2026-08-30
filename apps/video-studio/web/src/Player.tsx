import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { delegatedBase, type Capability } from './handoff.js'
import { apiUrl } from './urls.js'

type MediaInfo = { durationSeconds: number; frameRate: number | null }
type Job = { key: string; status: 'working' | 'ready' | 'failed'; playable?: boolean; playlistUrl?: string; error?: string; result?: { name: string } }

const time = (seconds: number) => {
  const milliseconds = Math.max(0, Math.round(seconds * 1000)), hours = Math.floor(milliseconds / 3_600_000), minutes = Math.floor(milliseconds / 60_000) % 60, secs = Math.floor(milliseconds / 1000) % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`
}

export function Player({ capability, onEdit }: { capability: Capability; onEdit: () => Promise<void> }) {
  const file = capability.files[0]!, base = delegatedBase(capability), video = useRef<HTMLVideoElement>(null), hls = useRef<Hls | undefined>(undefined)
  const [info, setInfo] = useState<MediaInfo>(), [current, setCurrent] = useState(0), [markIn, setMarkIn] = useState<number>(), [markOut, setMarkOut] = useState<number>(), [status, setStatus] = useState(''), [busy, setBusy] = useState(false)
  const attachHls = (url: string) => {
    const element = video.current; if (!element) return
    if (Hls.isSupported()) { hls.current?.destroy(); const instance = new Hls(); hls.current = instance; instance.loadSource(url); instance.attachMedia(element); instance.on(Hls.Events.MANIFEST_PARSED, () => void element.play()) }
    else { element.src = url; element.load(); void element.play() }
  }
  const fallback = async () => {
    setStatus('Preparing a browser-compatible stream…')
    const started = await fetch(`${base}/hls`, { method: 'POST' })
    if (!started.ok) throw new Error((await started.json().catch(() => ({})) as { message?: string }).message ?? started.statusText)
    let job = await started.json() as Job
    while (job.status === 'working') { if (job.playable && job.playlistUrl) { attachHls(job.playlistUrl); setStatus(''); return } await new Promise(resolve => setTimeout(resolve, 800)); const response = await fetch(apiUrl(`/handoffs/${encodeURIComponent(capability.localId)}/jobs/${encodeURIComponent(job.key)}`)); job = await response.json() as Job }
    if (job.status !== 'ready' || !job.playlistUrl) throw new Error(job.error ?? 'Video conversion failed.'); attachHls(job.playlistUrl); setStatus('')
  }
  useEffect(() => {
    fetch(`${base}/media-info`).then(response => response.ok ? response.json() : Promise.reject(new Error(response.statusText))).then(setInfo).catch(error => setStatus(error.message))
    return () => hls.current?.destroy()
  }, [base])
  const step = (direction: -1 | 1) => { const element = video.current, fps = info?.frameRate; if (!element || !fps || !info) return; element.pause(); const frame = direction < 0 ? Math.ceil(element.currentTime * fps - .05) - 1 : Math.floor(element.currentTime * fps + .05) + 1; element.currentTime = Math.min(Math.max(0, info.durationSeconds - 1 / fps), Math.max(0, frame / fps)) }
  const extract = async (body: object) => { setBusy(true); setStatus('Processing…'); try { const response = await fetch(`${base}/extractions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(response.statusText); let job = await response.json() as Job; while (job.status === 'working') { await new Promise(resolve => setTimeout(resolve, 700)); job = await (await fetch(apiUrl(`/handoffs/${encodeURIComponent(capability.localId)}/jobs/${encodeURIComponent(job.key)}`))).json() as Job } if (job.status !== 'ready') throw new Error(job.error ?? 'Processing failed.'); setStatus(`Created ${job.result?.name ?? 'output'}`) } catch (error) { setStatus(error instanceof Error ? error.message : 'Processing failed.') } finally { setBusy(false) } }
  return <main className="player-page"><header className="player-header"><div><span className="eyebrow">Video Studio · Player</span><h1>{file.name}</h1><small>{file.path}</small></div><button className="primary-action" disabled={busy} onClick={() => { setBusy(true); setStatus('Creating editing project…'); void onEdit().catch(error => { setStatus(error.message); setBusy(false) }) }}>Edit</button></header><section className="player-stage"><video ref={video} controls autoPlay playsInline src={`${base}/content`} onError={() => { if (!hls.current) void fallback().catch(error => setStatus(error.message)) }} onTimeUpdate={event => setCurrent(event.currentTarget.currentTime)} /></section><footer className="player-tools"><div><button disabled={!info?.frameRate} onClick={() => step(-1)}>◀</button><code>{time(current)}</code><button disabled={!info?.frameRate} onClick={() => step(1)}>▶</button><small>{info?.frameRate ? `${info.frameRate.toFixed(3)} fps` : 'FPS unavailable'}</small></div><div><button onClick={() => setMarkIn(current)}>In</button><code>{markIn === undefined ? '--:--:--.---' : time(markIn)}</code><button onClick={() => setMarkOut(current)}>Out</button><code>{markOut === undefined ? '--:--:--.---' : time(markOut)}</code></div><div><button disabled={busy || !info} onClick={() => void extract({ kind: 'frame', time: current })}>Extract frame</button><button disabled={busy || markIn === undefined || markOut === undefined || markOut <= markIn} onClick={() => void extract({ kind: 'segment', startTime: markIn, endTime: markOut })}>Extract segment</button></div>{status && <span>{status}</span>}</footer></main>
}
