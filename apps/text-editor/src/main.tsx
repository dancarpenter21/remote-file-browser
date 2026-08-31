import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { exchange, launchRelative, readDocument, saveDocument, type Capability } from './api'
import { isLocalTarget, isVideo, markdownSanitizeSchema, markdownUrlTransform, resolveFileId, resolveMedia } from './markdown'
import './styles.css'

type Tab = { capability: Capability; content: string; saved: string; saving: boolean; error?: string }
const channel = new BroadcastChannel('remote-workspace:text-editor')

function ticketFromHash() { return new URLSearchParams(location.hash.slice(1)).get('ticket') }

function App() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState('')
  const [wrap, setWrap] = useState(() => localStorage.getItem('remote-workspace:text-wrap') === 'true')
  const opening = useRef(new Set<string>())
  const openTicket = useCallback(async (ticket: string) => {
    if (!ticket || opening.current.has(ticket)) return
    opening.current.add(ticket)
    try {
      const capability = await exchange(ticket)
      const existing = tabs.find(tab => tab.capability.files[0].path === capability.files[0].path)
      if (existing) { setActive(existing.capability.sessionId); return }
      const content = await readDocument(capability)
      setTabs(current => [...current, { capability, content, saved: content, saving: false }])
      setActive(capability.sessionId)
      history.replaceState(null, '', location.pathname)
    } catch (error) {
      const sessionId = `error-${Date.now()}`
      setTabs(current => [...current, { capability: { sessionId, appId: 'text-editor', action: 'open', csrfToken: '', files: [{ reference: '', name: 'Launch failed', path: '', mime: 'text/plain', size: 0, etag: '' }], canWriteOriginal: false }, content: '', saved: '', saving: false, error: error instanceof Error ? error.message : 'Could not open the document.' }])
      setActive(sessionId)
    } finally { opening.current.delete(ticket) }
  }, [tabs])

  useEffect(() => {
    const initial = ticketFromHash(); if (initial) void openTicket(initial)
    const receive = (event: MessageEvent) => {
      const message = event.data as { type?: string; requestId?: string; ticket?: string }
      if (message.type === 'ping') channel.postMessage({ type: 'ready', requestId: message.requestId })
      if (message.type === 'launch' && message.ticket) void openTicket(message.ticket)
    }
    channel.addEventListener('message', receive)
    channel.postMessage({ type: 'ready' })
    return () => channel.removeEventListener('message', receive)
  }, [openTicket])

  useEffect(() => { localStorage.setItem('remote-workspace:text-wrap', String(wrap)) }, [wrap])
  useEffect(() => {
    if (!tabs.some(tab => tab.content !== tab.saved)) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    addEventListener('beforeunload', warn); return () => removeEventListener('beforeunload', warn)
  }, [tabs])

  const update = (id: string, patch: Partial<Tab>) => setTabs(current => current.map(tab => tab.capability.sessionId === id ? { ...tab, ...patch } : tab))
  const save = async (tab: Tab) => {
    const id = tab.capability.sessionId; update(id, { saving: true, error: undefined })
    try { const file = await saveDocument(tab.capability, tab.content); update(id, { saved: tab.content, saving: false, capability: { ...tab.capability, files: [file] } }) }
    catch (error) { update(id, { saving: false, error: error instanceof Error ? error.message : 'Save failed.' }) }
  }
  const closeTab = (tab: Tab) => {
    if (tab.content !== tab.saved && !confirm(`Discard unsaved changes to ${tab.capability.files[0].name}?`)) return
    setTabs(current => current.filter(item => item !== tab))
    if (active === tab.capability.sessionId) setActive(tabs.find(item => item !== tab)?.capability.sessionId ?? '')
  }
  const openLink = async (tab: Tab, target?: string) => {
    const id = resolveFileId(tab.capability.files[0].path, target); if (!id) return
    try { await openTicket(await launchRelative(id)) } catch (error) { update(tab.capability.sessionId, { error: error instanceof Error ? error.message : 'Could not open link.' }) }
  }

  if (!tabs.length) return <main className="empty"><h1>Text Editor</h1><p>Open a UTF-8 document from Files.</p></main>
  return <main className="app"><header><strong>Text Editor</strong><span>Remote Workspace</span></header><nav role="tablist">{tabs.map(tab => {
    const file = tab.capability.files[0], selected = tab.capability.sessionId === active
    return <div className={selected ? 'selected' : ''} key={tab.capability.sessionId}><button role="tab" aria-selected={selected} onClick={() => setActive(tab.capability.sessionId)}>{file.name}{tab.content !== tab.saved ? ' ●' : ''}</button><button aria-label={`Close ${file.name}`} onClick={() => closeTab(tab)}>×</button></div>
  })}</nav>{tabs.map(tab => {
    const file = tab.capability.files[0], selected = tab.capability.sessionId === active, markdownFile = file.mime.includes('markdown') || file.name.toLowerCase().endsWith('.md')
    if (!selected) return null
    return <section className="workspace" key={tab.capability.sessionId}><div className="toolbar"><button disabled={tab.saving || tab.content === tab.saved} onClick={() => void save(tab)}>{tab.saving ? 'Saving…' : 'Save'}</button><button onClick={() => setWrap(value => !value)} className={wrap ? 'active' : ''}>Word wrap</button><code>{file.path}</code></div>{tab.error && <div className="error">{tab.error}</div>}<div className={markdownFile ? 'panes' : 'panes single'}><CodeMirror value={tab.content} height="100%" theme="dark" extensions={[...(markdownFile ? [markdown()] : []), ...(wrap ? [EditorView.lineWrapping] : [])]} onChange={content => update(tab.capability.sessionId, { content, error: undefined })} />{markdownFile && <article><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, markdownSanitizeSchema]]} urlTransform={markdownUrlTransform} components={{ a: ({ href, ...props }) => <a {...props} href={href} onClick={event => { if (isLocalTarget(href)) { event.preventDefault(); void openLink(tab, href) } }} />, img: ({ src, alt, title, ...props }) => isVideo(src) ? <video controls src={resolveMedia(file.path, src)} aria-label={alt || title || 'Embedded video'} /> : <img {...props} src={resolveMedia(file.path, src)} alt={alt} title={title} /> }}>{tab.content}</ReactMarkdown></article>}</div></section>
  })}</main>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
