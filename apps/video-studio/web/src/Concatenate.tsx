import { useState } from 'react'
import type { Capability } from './handoff.js'
import { apiUrl } from './urls.js'

type Job = { key: string; status: 'working' | 'ready' | 'failed'; progress?: number; error?: string; result?: { name: string } }

export function Concatenate({ capability }: { capability: Capability }) {
  const first = capability.files[0]?.name.replace(/\.[^.]+$/, '') || 'videos'
  const [name, setName] = useState(`${first}-concatenated.mp4`), [job, setJob] = useState<Job>(), [error, setError] = useState('')
  const start = async () => {
    setError('')
    try {
      let response = await fetch(apiUrl(`/handoffs/${encodeURIComponent(capability.localId)}/concatenations`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outputName: name }) })
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { message?: string }).message ?? response.statusText)
      let current = await response.json() as Job; setJob(current)
      while (current.status === 'working') { await new Promise(resolve => setTimeout(resolve, 800)); response = await fetch(apiUrl(`/handoffs/${encodeURIComponent(capability.localId)}/jobs/${encodeURIComponent(current.key)}`)); current = await response.json() as Job; setJob(current) }
      if (current.status === 'failed') throw new Error(current.error ?? 'Concatenation failed.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Concatenation failed.') }
  }
  return <main className="library-page"><header className="library-header"><div><span className="brand-mark">VS</span><span>Video Studio</span></div></header><section className="library-hero"><span className="eyebrow">Video utility</span><h1>Concatenate videos</h1><p>Join {capability.files.length} selected videos into one browser-compatible MP4.</p></section><section className="concat-card"><ol>{capability.files.map(file => <li key={file.reference}>{file.name}</li>)}</ol><label>Output filename<input value={name} onChange={event => setName(event.target.value)} /></label><button className="accent-button" disabled={job?.status === 'working' || !name.toLowerCase().endsWith('.mp4')} onClick={() => void start()}>Concatenate</button>{job?.status === 'working' && <progress max={1} value={job.progress ?? 0} />}{job?.status === 'ready' && <p>Created {job.result?.name}</p>}{error && <p className="inline-error">{error}</p>}</section></main>
}
