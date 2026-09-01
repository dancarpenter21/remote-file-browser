import { useCallback, useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { delegatedBase, type Capability } from './handoff.js'
import { createPlaybackFallbackGate, DIRECT_PLAYBACK_TIMEOUT_MS, formatMediaTime, hlsRecoveryAction, stepFrameTime } from './playerState.js'
import { apiUrl } from './urls.js'

type MediaInfo = { durationSeconds: number; frameRate: number | null }
type Job = { key: string; status: 'working' | 'ready' | 'failed'; playable?: boolean; playlistUrl?: string; error?: string; result?: { name: string } }

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: string; message?: string }
  return new Error(body.error || body.message || response.statusText || fallback)
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const timer = window.setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => { window.clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

export function Player({ capability, onEdit }: { capability: Capability; onEdit: () => Promise<void> }) {
  const file = capability.files[0]!
  const base = delegatedBase(capability)
  const video = useRef<HTMLVideoElement>(null)
  const hls = useRef<Hls | undefined>(undefined)
  const fallbackGate = useRef(createPlaybackFallbackGate())
  const lifecycle = useRef(new AbortController())
  const readinessTimer = useRef<number | undefined>(undefined)
  const stallTimer = useRef<number | undefined>(undefined)
  const nativeHlsCleanup = useRef<(() => void) | undefined>(undefined)
  const autoplayAttempted = useRef(false)
  const [info, setInfo] = useState<MediaInfo>()
  const [current, setCurrent] = useState(0)
  const [markIn, setMarkIn] = useState<number>()
  const [markOut, setMarkOut] = useState<number>()
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [usingFallback, setUsingFallback] = useState(false)

  const clearDirectTimers = useCallback(() => {
    if (readinessTimer.current !== undefined) window.clearTimeout(readinessTimer.current)
    if (stallTimer.current !== undefined) window.clearTimeout(stallTimer.current)
    readinessTimer.current = undefined
    stallTimer.current = undefined
  }, [])

  const startPlayback = useCallback(() => {
    const element = video.current
    if (!element || lifecycle.current.signal.aborted) return
    void element.play().then(() => setStatus('')).catch(() => {
      if (!lifecycle.current.signal.aborted) setStatus('Stream ready. Press Play to start.')
    })
  }, [])

  const attachHls = useCallback((url: string) => {
    const element = video.current
    if (!element || lifecycle.current.signal.aborted) return
    clearDirectTimers()
    nativeHlsCleanup.current?.()
    nativeHlsCleanup.current = undefined
    hls.current?.destroy()
    hls.current = undefined
    setStatus('Loading browser-compatible stream…')
    if (Hls.isSupported()) {
      const instance = new Hls()
      let networkRecoveries = 0
      let mediaRecoveries = 0
      hls.current = instance
      instance.on(Hls.Events.MEDIA_ATTACHED, () => instance.loadSource(url))
      instance.on(Hls.Events.MANIFEST_PARSED, startPlayback)
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || lifecycle.current.signal.aborted) return
        const action = hlsRecoveryAction(data.type, networkRecoveries, mediaRecoveries)
        if (action === 'retry-network') {
          networkRecoveries += 1
          setStatus('Retrying the video stream…')
          instance.startLoad()
          return
        }
        if (action === 'recover-media') {
          mediaRecoveries += 1
          setStatus('Recovering video playback…')
          instance.recoverMediaError()
          return
        }
        const detail = data.error?.message && data.error.message !== data.details ? `: ${data.error.message}` : ''
        setStatus(`Video playback failed (${data.type}/${data.details})${detail}`)
        instance.destroy()
        if (hls.current === instance) hls.current = undefined
      })
      instance.attachMedia(element)
      return
    }
    if (element.canPlayType('application/vnd.apple.mpegurl')) {
      const ready = () => startPlayback()
      element.addEventListener('canplay', ready, { once: true })
      nativeHlsCleanup.current = () => element.removeEventListener('canplay', ready)
      element.src = url
      element.load()
      return
    }
    setStatus('This browser cannot play the browser-compatible video stream.')
  }, [clearDirectTimers, startPlayback])

  const fallback = useCallback(async () => {
    if (!fallbackGate.current.claim()) return
    clearDirectTimers()
    setUsingFallback(true)
    setStatus('Preparing a browser-compatible stream…')
    const element = video.current
    element?.pause()
    element?.removeAttribute('src')
    element?.load()
    const signal = lifecycle.current.signal
    try {
      const started = await fetch(`${base}/hls`, { method: 'POST', signal })
      if (!started.ok) throw await responseError(started, 'Could not prepare the video stream.')
      let job = await started.json() as Job
      while (job.status === 'working') {
        if (job.playable && job.playlistUrl) { attachHls(job.playlistUrl); return }
        await abortableDelay(800, signal)
        const response = await fetch(apiUrl(`/handoffs/${encodeURIComponent(capability.localId)}/jobs/${encodeURIComponent(job.key)}`), { signal })
        if (!response.ok) throw await responseError(response, 'Could not read video conversion status.')
        job = await response.json() as Job
      }
      if (job.status !== 'ready' || !job.playlistUrl) throw new Error(job.error ?? 'Video conversion failed.')
      attachHls(job.playlistUrl)
    } catch (error) {
      if (!signal.aborted) setStatus(error instanceof Error ? error.message : 'Video conversion failed.')
    }
  }, [attachHls, base, capability.localId, clearDirectTimers])

  const scheduleStallFallback = useCallback(() => {
    if (fallbackGate.current.started || stallTimer.current !== undefined) return
    stallTimer.current = window.setTimeout(() => { stallTimer.current = undefined; void fallback() }, DIRECT_PLAYBACK_TIMEOUT_MS)
  }, [fallback])

  useEffect(() => {
    lifecycle.current = new AbortController()
    fallbackGate.current.reset()
    autoplayAttempted.current = false
    setUsingFallback(false)
    readinessTimer.current = window.setTimeout(() => { readinessTimer.current = undefined; void fallback() }, DIRECT_PLAYBACK_TIMEOUT_MS)
    const signal = lifecycle.current.signal
    void fetch(`${base}/media-info`, { signal }).then(async response => {
      if (!response.ok) throw await responseError(response, 'Could not inspect the video.')
      return response.json() as Promise<MediaInfo>
    }).then(setInfo).catch(error => {
      if (!signal.aborted && !fallbackGate.current.started) setStatus(error instanceof Error ? error.message : 'Could not inspect the video.')
    })
    return () => {
      lifecycle.current.abort()
      clearDirectTimers()
      nativeHlsCleanup.current?.()
      nativeHlsCleanup.current = undefined
      hls.current?.destroy()
      hls.current = undefined
    }
  }, [base, clearDirectTimers, fallback])

  const directCanPlay = () => {
    if (fallbackGate.current.started) return
    clearDirectTimers()
    if (autoplayAttempted.current) return
    autoplayAttempted.current = true
    startPlayback()
  }
  const timeUpdated = (element: HTMLVideoElement) => {
    if (stallTimer.current !== undefined) window.clearTimeout(stallTimer.current)
    stallTimer.current = undefined
    setCurrent(element.currentTime)
  }
  const step = (direction: -1 | 1) => {
    const element = video.current
    const frameRate = info?.frameRate
    if (!element || !frameRate || !info) return
    element.pause()
    const next = stepFrameTime(element.currentTime, direction, frameRate, info.durationSeconds)
    element.currentTime = next
    setCurrent(next)
  }
  const extract = async (body: object) => {
    setBusy(true)
    setStatus('Processing…')
    try {
      const response = await fetch(`${base}/extractions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok) throw await responseError(response, 'Could not start processing.')
      let job = await response.json() as Job
      while (job.status === 'working') {
        await abortableDelay(700, lifecycle.current.signal)
        const next = await fetch(apiUrl(`/handoffs/${encodeURIComponent(capability.localId)}/jobs/${encodeURIComponent(job.key)}`), { signal: lifecycle.current.signal })
        if (!next.ok) throw await responseError(next, 'Could not read processing status.')
        job = await next.json() as Job
      }
      if (job.status !== 'ready') throw new Error(job.error ?? 'Processing failed.')
      setStatus(`Created ${job.result?.name ?? 'output'}`)
    } catch (error) {
      if (!lifecycle.current.signal.aborted) setStatus(error instanceof Error ? error.message : 'Processing failed.')
    } finally {
      if (!lifecycle.current.signal.aborted) setBusy(false)
    }
  }

  return <main className="player-page"><header className="player-header"><div><span className="eyebrow">Video Studio · Player</span><h1>{file.name}</h1><small>{file.path}</small></div><button className="primary-action" disabled={busy} onClick={() => { setBusy(true); setStatus('Creating editing project…'); void onEdit().catch(error => { setStatus(error.message); setBusy(false) }) }}>Edit</button></header><section className="player-stage"><video ref={video} controls playsInline src={usingFallback ? undefined : `${base}/content`} onCanPlay={directCanPlay} onError={() => void fallback()} onStalled={scheduleStallFallback} onWaiting={scheduleStallFallback} onPlaying={() => { if (stallTimer.current !== undefined) window.clearTimeout(stallTimer.current); stallTimer.current = undefined }} onTimeUpdate={event => timeUpdated(event.currentTarget)} /></section><footer className="player-tools"><div><button disabled={!info?.frameRate} onClick={() => step(-1)}>◀</button><code>{formatMediaTime(current)}</code><button disabled={!info?.frameRate} onClick={() => step(1)}>▶</button><small>{info?.frameRate ? `${info.frameRate.toFixed(3)} fps` : 'FPS unavailable'}</small></div><div><button onClick={() => setMarkIn(current)}>In</button><code>{markIn === undefined ? '--:--:--.---' : formatMediaTime(markIn)}</code><button onClick={() => setMarkOut(current)}>Out</button><code>{markOut === undefined ? '--:--:--.---' : formatMediaTime(markOut)}</code></div><div><button disabled={busy || !info} onClick={() => void extract({ kind: 'frame', time: current })}>Extract frame</button><button disabled={busy || markIn === undefined || markOut === undefined || markOut <= markIn} onClick={() => void extract({ kind: 'segment', startTime: markIn, endTime: markOut })}>Extract segment</button></div>{status && <span role="status">{status}</span>}</footer></main>
}
