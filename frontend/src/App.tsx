import { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import Hls from 'hls.js'
import {
  ChevronDown, ChevronRight, Copy, Download, Edit3, Eye, File, FileImage, FileText,
  Film, Folder, FolderOpen, Grid2X2, Image, List, LogOut, Maximize2, Menu, MoreHorizontal,
  Move, Plus, RefreshCw, RotateCw, Save, Search, Trash2, Upload, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import { api, ApiFailure, contentUrl, DocumentFile, Entry, EntryPage, mediaUrl, Session, setCsrf, thumbnailUrl, TrashEntry } from './api'

type ViewMode = 'details' | 'small' | 'medium' | 'large'
type Clipboard = { operation: 'copy' | 'move'; ids: string[] } | null

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  useEffect(() => { api.session().then(s => { setCsrf(s.csrfToken); setSession(s) }) }, [])
  if (!session) return <div className="center"><span className="spinner" /></div>
  if (!session.authenticated) return <Login onLogin={s => { setCsrf(s.csrfToken); setSession(s) }} />
  return <FileManager session={session} onLogout={() => { setCsrf(); setSession({ authenticated: false }) }} />
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { onLogin(await api.login(username, password)) } catch (e) { setError(messageOf(e)) } finally { setBusy(false) }
  }
  return <main className="login-shell">
    <form className="login-card" onSubmit={submit}>
      <div className="brand-mark"><FolderOpen size={24} /></div>
      <h1>Remote Files</h1><p>Sign in to explore this server.</p>
      <label>Username<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} autoFocus /></label>
      {error && <div className="error" role="alert">{error}</div>}
      <button className="primary" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  </main>
}

function FileManager({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [root, setRoot] = useState<EntryPage | null>(null)
  const [expanded, setExpanded] = useState<Record<string, EntryPage>>({})
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [currentDir, setCurrentDir] = useState('')
  const [view, setView] = useState<ViewMode>(() => (localStorage.getItem('rfb-view') as ViewMode) || 'details')
  const [hidden, setHidden] = useState(() => localStorage.getItem('rfb-hidden') === 'true')
  const [filter, setFilter] = useState('')
  const [clipboard, setClipboard] = useState<Clipboard>(null)
  const [editor, setEditor] = useState<DocumentFile | null>(null)
  const [viewer, setViewer] = useState<{ entry: Entry; type: 'image' | 'video' } | null>(null)
  const [trash, setTrash] = useState<TrashEntry[] | null>(null)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const loadRoot = async () => { try { setRoot(await api.list('', hidden)); setExpanded({}); setOpen(new Set()); setSelected(new Set()) } catch (e) { setError(messageOf(e)) } }
  useEffect(() => { loadRoot() }, [hidden])
  useEffect(() => { localStorage.setItem('rfb-view', view) }, [view])
  useEffect(() => { localStorage.setItem('rfb-hidden', String(hidden)) }, [hidden])

  const refresh = async (id = currentDir) => {
    try {
      const page = await api.list(id, hidden)
      if (id === '') setRoot(page); else setExpanded(previous => ({ ...previous, [id]: page }))
    } catch (e) { setError(messageOf(e)) }
  }
  const toggleDirectory = async (entry: Entry) => {
    setCurrentDir(entry.id)
    if (open.has(entry.id)) { setOpen(previous => { const next = new Set(previous); next.delete(entry.id); return next }); return }
    if (!expanded[entry.id]) { try { const page = await api.list(entry.id, hidden); setExpanded(previous => ({ ...previous, [entry.id]: page })) } catch (e) { setError(messageOf(e)); return } }
    setOpen(previous => new Set(previous).add(entry.id))
  }
  const activate = async (entry: Entry) => {
    if (entry.kind === 'directory') return toggleDirectory(entry)
    if (entry.mime.startsWith('image/')) return setViewer({ entry, type: 'image' })
    if (entry.mime.startsWith('video/')) return setViewer({ entry, type: 'video' })
    try { setEditor(await api.readDocument(entry.id)) } catch { window.location.href = contentUrl(entry.id) }
  }
  const mutate = async (action: () => Promise<unknown>, dir = currentDir, replace?: () => Promise<unknown>) => {
    setError(''); try { await action(); await refresh(dir) } catch (e) {
      if (replace && e instanceof ApiFailure && e.code === 'already_exists' && confirm(`${e.message}. Replace it and move the old item to Trash?`)) { try { await replace(); await refresh(dir); return } catch (retryError) { setError(messageOf(retryError)); return } }
      setError(messageOf(e))
    }
  }
  const createItem = (kind: 'file' | 'directory') => {
    const name = prompt(`New ${kind} name`); if (!name) return
    mutate(() => api.create(currentDir, name, kind), currentDir, () => api.create(currentDir, name, kind, true))
  }
  const rename = () => {
    const entry = findEntry(first(selected), root, expanded); if (!entry) return
    const name = prompt('Rename item', entry.name); if (!name || name === entry.name) return
    mutate(() => api.operate('rename', [entry.id], entry.parentId, name), entry.parentId, () => api.operate('rename', [entry.id], entry.parentId, name, true))
  }
  const deleteSelected = async () => {
    if (!selected.size || !confirm(`Move ${selected.size} selected item${selected.size === 1 ? '' : 's'} to Trash?`)) return
    const parents = new Set(Array.from(selected).map(id => findEntry(id, root, expanded)?.parentId ?? ''))
    try { await api.trash(Array.from(selected)); setSelected(new Set()); await Promise.all(Array.from(parents).map(refresh)) } catch (e) { setError(messageOf(e)) }
  }
  const paste = () => {
    if (!clipboard) return
    mutate(async () => { await api.operate(clipboard.operation, clipboard.ids, currentDir); if (clipboard.operation === 'move') setClipboard(null) }, currentDir, async () => { await api.operate(clipboard.operation, clipboard.ids, currentDir, undefined, true); if (clipboard.operation === 'move') setClipboard(null) })
  }
  const openTrash = async () => { try { setTrash(await api.listTrash()) } catch (e) { setError(messageOf(e)) } }
  const logout = async () => { try { await api.logout() } finally { onLogout() } }

  const flat = useMemo(() => flatten(root?.entries ?? [], open, expanded, 0).filter(row => row.entry.name.toLowerCase().includes(filter.toLowerCase())), [root, open, expanded, filter])
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><FolderOpen size={20} /><strong>Remote Files</strong><span>/fs-root</span></div>
      <div className="search"><Search size={16} /><input placeholder="Filter visible files" value={filter} onChange={e => setFilter(e.target.value)} /></div>
      <button className="icon-button" title="Sign out" onClick={logout}><LogOut size={18} /></button>
    </header>
    <div className="workspace">
      <aside>
        <button className="nav-item active"><Folder size={17} /> Files</button>
        <button className="nav-item" onClick={openTrash}><Trash2 size={17} /> Trash</button>
        <div className="aside-note"><span>Signed in as</span><strong>{session.username}</strong></div>
      </aside>
      <main className="browser">
        <div className="toolbar">
          <button onClick={() => createItem('directory')}><Plus size={16} /> Folder</button>
          <button onClick={() => createItem('file')}><File size={16} /> File</button>
          <button onClick={() => inputRef.current?.click()}><Upload size={16} /> Upload</button>
          <input ref={inputRef} type="file" multiple hidden onChange={e => e.target.files && mutate(() => api.upload(currentDir, e.target.files!), currentDir, () => api.upload(currentDir, e.target.files!, true))} />
          <span className="divider" />
          <button disabled={!selected.size} onClick={() => setClipboard({ operation: 'copy', ids: Array.from(selected) })}><Copy size={16} /> Copy</button>
          <button disabled={!selected.size} onClick={() => setClipboard({ operation: 'move', ids: Array.from(selected) })}><Move size={16} /> Move</button>
          <button disabled={!clipboard} onClick={paste}>Paste</button>
          <button disabled={selected.size !== 1} onClick={rename}><Edit3 size={16} /> Rename</button>
          <button disabled={!selected.size} onClick={deleteSelected}><Trash2 size={16} /> Delete</button>
          <div className="toolbar-spacer" />
          <label className="hidden-toggle"><input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} /> Hidden</label>
          <button className="icon-button" title="Refresh" onClick={() => refresh()}><RefreshCw size={16} /></button>
          <ViewSelector view={view} setView={setView} />
        </div>
        <div className="location"><button onClick={() => { setCurrentDir(''); setSelected(new Set()) }}>/ fs-root</button><span>{flat.length} visible</span></div>
        {error && <div className="banner error"><span>{error}</span><button onClick={() => setError('')}><X size={15} /></button></div>}
        {!root ? <div className="center"><span className="spinner" /></div> : flat.length === 0 ? <Empty /> :
          <FileList rows={flat} view={view} open={open} selected={selected} setSelected={setSelected} activate={activate} toggle={toggleDirectory} setCurrentDir={setCurrentDir} deleteEntry={entry => mutate(() => api.trash([entry.id]), entry.parentId)} setError={setError} />}
      </main>
    </div>
    {editor && <EditorWindow document={editor} onClose={() => setEditor(null)} onSaved={setEditor} />}
    {viewer && <ViewerWindow {...viewer} onClose={() => setViewer(null)} />}
    {trash && <TrashWindow items={trash} onClose={() => setTrash(null)} onChanged={async () => setTrash(await api.listTrash())} setError={setError} />}
  </div>
}

type Row = { entry: Entry; depth: number }
function flatten(entries: Entry[], open: Set<string>, pages: Record<string, EntryPage>, depth: number): Row[] {
  return entries.flatMap(entry => [{ entry, depth }, ...(entry.kind === 'directory' && open.has(entry.id) ? flatten(pages[entry.id]?.entries ?? [], open, pages, depth + 1) : [])])
}

function FileList({ rows, view, open, selected, setSelected, activate, toggle, setCurrentDir, deleteEntry, setError }: {
  rows: Row[]; view: ViewMode; open: Set<string>; selected: Set<string>; setSelected: (value: Set<string>) => void
  activate: (entry: Entry) => void; toggle: (entry: Entry) => void; setCurrentDir: (id: string) => void
  deleteEntry: (entry: Entry) => Promise<void>; setError: (message: string) => void
}) {
  const [menu, setMenu] = useState<{ entry: Entry; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    addEventListener('pointerdown', close); addEventListener('keydown', escape)
    return () => { removeEventListener('pointerdown', close); removeEventListener('keydown', escape) }
  }, [menu])
  const showMenu = (event: React.MouseEvent, entry: Entry) => {
    event.preventDefault(); event.stopPropagation()
    setMenu({ entry, x: Math.min(event.clientX, innerWidth - 198), y: Math.min(event.clientY, innerHeight - 140) })
  }
  const choose = (entry: Entry, checked: boolean) => { const next = new Set(selected); checked ? next.add(entry.id) : next.delete(entry.id); setSelected(next); if (entry.kind === 'directory') setCurrentDir(entry.id) }
  const contextMenu = menu && <ContextMenu {...menu} close={() => setMenu(null)} open={() => activate(menu.entry)} deleteEntry={deleteEntry} setError={setError} />
  if (view === 'details') return <><div className="details-table" role="treegrid">
    <div className="details-head"><span>Name</span><span>Permissions</span><span>Owner</span><span>Size</span><span>Modified</span></div>
    {rows.map(({ entry, depth }) => <div className={`file-row ${selected.has(entry.id) ? 'selected' : ''}`} key={entry.id} onDoubleClick={() => activate(entry)} onContextMenu={event => showMenu(event, entry)} role="row">
      <div className="name-cell" style={{ paddingLeft: 12 + depth * 22 }}>
        <input type="checkbox" checked={selected.has(entry.id)} onChange={e => choose(entry, e.target.checked)} />
        {entry.kind === 'directory' ? <button className="disclosure" onClick={() => toggle(entry)}>{open.has(entry.id) ? <ChevronDown /> : <ChevronRight />}</button> : <span className="disclosure" />}
        <FileGlyph entry={entry} /><button className="filename" onClick={() => entry.kind === 'directory' ? setCurrentDir(entry.id) : activate(entry)}>{entry.name}</button><button className="row-menu" aria-label={`Actions for ${entry.name}`} onClick={event => showMenu(event, entry)}><MoreHorizontal /></button>
      </div>
      <code>{entry.permissions} <small>{entry.mode.toString(8)}</small></code><span>{entry.uid}:{entry.gid}</span><span>{formatBytes(entry.size)}</span><span>{formatDate(entry.modifiedAt)}</span>
    </div>)}
  </div>{contextMenu}</>
  return <div className={`preview-list ${view}`}>
    {rows.map(({ entry, depth }) => <div className={`preview-card ${selected.has(entry.id) ? 'selected' : ''}`} style={{ marginLeft: depth * 18 }} key={entry.id} onDoubleClick={() => activate(entry)} onContextMenu={event => showMenu(event, entry)}>
      <input type="checkbox" checked={selected.has(entry.id)} onChange={e => choose(entry, e.target.checked)} />
      <button className="card-menu" aria-label={`Actions for ${entry.name}`} onClick={event => showMenu(event, entry)}><MoreHorizontal /></button>
      {entry.kind === 'directory' ? <button className="preview-image folder-preview" onClick={() => toggle(entry)}>{open.has(entry.id) ? <FolderOpen /> : <Folder />}</button> : isPreviewable(entry) ? <button className="preview-image" onClick={() => activate(entry)}><img src={thumbnailUrl(entry.id, view)} loading="lazy" /></button> : <button className="preview-image" onClick={() => activate(entry)}><FileGlyph entry={entry} /></button>}
      <button className="filename" onClick={() => activate(entry)} title={entry.name}>{entry.name}</button>
      <small>{formatBytes(entry.size)}</small>
    </div>)}
    {contextMenu}
  </div>
}

function ContextMenu({ entry, x, y, close, open, deleteEntry, setError }: { entry: Entry; x: number; y: number; close: () => void; open: () => void; deleteEntry: (entry: Entry) => Promise<void>; setError: (message: string) => void }) {
  const copyPath = async () => {
    try { await navigator.clipboard.writeText(entry.path) } catch { setError('The browser denied clipboard access.') }
    close()
  }
  const remove = async () => {
    close(); if (!confirm(`Move ${entry.name} to Trash?`)) return
    try { await deleteEntry(entry) } catch (error) { setError(messageOf(error)) }
  }
  return <div className="context-menu" style={{ left: x, top: y }} role="menu" onPointerDown={event => event.stopPropagation()}>
    <button role="menuitem" autoFocus onClick={() => { close(); open() }}><FolderOpen /> Open</button>
    <button role="menuitem" onClick={copyPath}><Copy /> Copy path</button>
    <span className="context-divider" />
    <button role="menuitem" className="danger" onClick={remove}><Trash2 /> Delete</button>
  </div>
}

function ViewSelector({ view, setView }: { view: ViewMode; setView: (view: ViewMode) => void }) {
  return <div className="view-selector" aria-label="View mode">
    {(['details', 'small', 'medium', 'large'] as ViewMode[]).map(mode => <button className={view === mode ? 'active' : ''} title={mode} key={mode} onClick={() => setView(mode)}>{mode === 'details' ? <List /> : mode === 'small' ? <Menu /> : mode === 'medium' ? <Grid2X2 /> : <Maximize2 />}</button>)}
  </div>
}

function EditorWindow({ document, onClose, onSaved }: { document: DocumentFile; onClose: () => void; onSaved: (doc: DocumentFile) => void }) {
  const [content, setContent] = useState(document.content)
  const [preview, setPreview] = useState(document.mime.includes('markdown') || document.id.endsWith('bWQ'))
  const [error, setError] = useState('')
  const save = async () => { try { onSaved(await api.saveDocument({ ...document, content })); setError('') } catch (e) { setError(messageOf(e)) } }
  return <FloatingWindow title="Text editor" onClose={() => { if (content === document.content || confirm('Discard unsaved changes?')) onClose() }} className="editor-window">
    <div className="window-toolbar"><button className="primary compact" onClick={save}><Save size={15} /> Save</button><button className={preview ? 'active' : ''} onClick={() => setPreview(!preview)}><Eye size={15} /> Markdown preview</button><span className="toolbar-spacer" /><code>{document.mime}</code></div>
    {error && <div className="banner error">{error}</div>}
    <div className={`editor-body ${preview ? 'split' : ''}`}><CodeMirror value={content} height="100%" theme="dark" extensions={[markdown()]} onChange={setContent} />{preview && <article className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{content}</ReactMarkdown></article>}</div>
  </FloatingWindow>
}

function ViewerWindow({ entry, type, onClose }: { entry: Entry; type: 'image' | 'video'; onClose: () => void }) {
  const [zoom, setZoom] = useState(1)
  const [rotate, setRotate] = useState(0)
  return <FloatingWindow title={entry.name} onClose={onClose} className="viewer-window">
    {type === 'image' ? <>
      <div className="window-toolbar"><button onClick={() => setZoom(z => Math.max(.25, z - .25))}><ZoomOut /></button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(z => Math.min(5, z + .25))}><ZoomIn /></button><button onClick={() => setRotate(r => r + 90)}><RotateCw /></button><a className="button" href={contentUrl(entry.id)}><Download /> Download</a></div>
      <div className="image-stage"><img src={mediaUrl(entry.id)} style={{ transform: `scale(${zoom}) rotate(${rotate}deg)` }} /></div>
    </> : <VideoPlayer entry={entry} />}
  </FloatingWindow>
}

function VideoPlayer({ entry }: { entry: Entry }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [message, setMessage] = useState('')
  const fallback = async () => {
    if (message) return
    setMessage('Preparing a browser-compatible stream…')
    try {
      const job = await api.startHls(entry.id)
      let current = job
      while (current.status === 'working') { await new Promise(r => setTimeout(r, 1500)); current = await api.hlsStatus(job.key) }
      if (current.status !== 'ready') throw new Error('Transcoding failed')
      const video = videoRef.current!;
      if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = current.playlistUrl
      else if (Hls.isSupported()) { const hls = new Hls(); hls.loadSource(current.playlistUrl); hls.attachMedia(video) }
      setMessage('')
    } catch (e) { setMessage(messageOf(e)) }
  }
  return <div className="video-stage"><video ref={videoRef} src={mediaUrl(entry.id)} controls autoPlay onError={fallback} /><div className="video-message">{message}</div></div>
}

function TrashWindow({ items, onClose, onChanged, setError }: { items: TrashEntry[]; onClose: () => void; onChanged: () => Promise<void>; setError: (s: string) => void }) {
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await onChanged() } catch (e) { setError(messageOf(e)) } }
  return <FloatingWindow title="Trash" onClose={onClose} className="trash-window">
    <div className="window-toolbar"><span>{items.length} item{items.length === 1 ? '' : 's'}</span><span className="toolbar-spacer" /><button disabled={!items.length} onClick={() => confirm('Permanently delete everything in Trash? This cannot be undone.') && act(api.emptyTrash)}><Trash2 /> Empty Trash</button></div>
    <div className="trash-list">{items.length === 0 ? <Empty label="Trash is empty" /> : items.map(item => <div className="trash-row" key={item.info.id}><FileGlyph entry={{ kind: item.kind } as Entry} /><div><strong>{item.info.originalName}</strong><small>Deleted {formatDate(item.info.deletedAt)}</small></div><span>{formatBytes(item.size)}</span><button onClick={() => act(() => api.restore(item.info.id))}>Restore</button><button className="danger" onClick={() => confirm(`Permanently delete ${item.info.originalName}?`) && act(() => api.purge(item.info.id))}><Trash2 /></button></div>)}</div>
  </FloatingWindow>
}

function FloatingWindow({ title, onClose, className = '', children }: { title: string; onClose: () => void; className?: string; children: React.ReactNode }) {
  const [position, setPosition] = useState({ x: Math.max(20, innerWidth * .12), y: 90 })
  const drag = useRef<{ x: number; y: number } | null>(null)
  return <div className={`floating ${className}`} style={{ left: position.x, top: position.y }}>
    <div className="window-title" onPointerDown={e => { drag.current = { x: e.clientX - position.x, y: e.clientY - position.y }; e.currentTarget.setPointerCapture(e.pointerId) }} onPointerMove={e => { if (drag.current) setPosition({ x: Math.max(0, e.clientX - drag.current.x), y: Math.max(0, e.clientY - drag.current.y) }) }} onPointerUp={() => { drag.current = null }}><span>{title}</span><button onClick={onClose}><X /></button></div>
    {children}
  </div>
}

function FileGlyph({ entry }: { entry: Pick<Entry, 'kind'> & Partial<Entry> }) {
  if (entry.kind === 'directory') return <Folder className="glyph folder" />
  if (entry.mime?.startsWith('image/')) return <FileImage className="glyph" />
  if (entry.mime?.startsWith('video/')) return <Film className="glyph" />
  if (entry.mime?.startsWith('text/')) return <FileText className="glyph" />
  return <File className="glyph" />
}
function isPreviewable(entry: Entry) { return entry.mime.startsWith('image/') || entry.mime.startsWith('video/') }
function first<T>(set: Set<T>) { return set.values().next().value }
function findEntry(id: string | undefined, root: EntryPage | null, pages: Record<string, EntryPage>) { if (id === undefined) return; return [...(root?.entries ?? []), ...Object.values(pages).flatMap(p => p.entries)].find(entry => entry.id === id) }
function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} B`; const units = ['KB', 'MB', 'GB', 'TB']; let value = bytes / 1024, unit = 0; while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ } return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}` }
function formatDate(value?: string) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—' }
function messageOf(error: unknown) { return error instanceof Error ? error.message : 'The operation failed' }
function Empty({ label = 'This folder is empty' }: { label?: string }) { return <div className="empty"><FolderOpen /><strong>{label}</strong><span>Nothing to show here.</span></div> }
