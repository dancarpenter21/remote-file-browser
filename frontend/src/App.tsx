import { useEffect, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import Hls from 'hls.js'
import {
  ChevronRight, Columns3, Copy, Download, Edit3, Eye, File, FileImage, FileText,
  Film, Folder, FolderOpen, Grid2X2, LogOut, Maximize2, Menu, MoreHorizontal,
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
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [primary, setPrimary] = useState<Entry | null>(null)
  const [columnPath, setColumnPath] = useState<Entry[]>([])
  const [currentDir, setCurrentDir] = useState('')
  const [view, setView] = useState<ViewMode>(() => (localStorage.getItem('rfb-view') as ViewMode) || 'details')
  const [hidden, setHidden] = useState(() => localStorage.getItem('rfb-hidden') === 'true')
  const [filter, setFilter] = useState('')
  const [clipboard, setClipboard] = useState<Clipboard>(null)
  const [editor, setEditor] = useState<DocumentFile | null>(null)
  const [viewer, setViewer] = useState<{ entry: Entry; type: 'image' | 'video' } | null>(null)
  const [trash, setTrash] = useState<TrashEntry[] | null>(null)
  const [error, setError] = useState('')
  const [showPreview, setShowPreview] = useState(() => localStorage.getItem('rfb-column-preview') !== 'false')
  const [columnWidth, setColumnWidth] = useState(() => Math.min(480, Math.max(180, Number(localStorage.getItem('rfb-column-width')) || 240)))
  const inputRef = useRef<HTMLInputElement>(null)

  const loadRoot = async () => { try { setRoot(await api.list('', hidden)); setExpanded({}); setSelected(new Set()); setPrimary(null); setColumnPath([]); setCurrentDir('') } catch (e) { setError(messageOf(e)) } }
  useEffect(() => { loadRoot() }, [hidden])
  useEffect(() => { localStorage.setItem('rfb-view', view) }, [view])
  useEffect(() => { localStorage.setItem('rfb-hidden', String(hidden)) }, [hidden])
  useEffect(() => { localStorage.setItem('rfb-column-preview', String(showPreview)) }, [showPreview])
  useEffect(() => { localStorage.setItem('rfb-column-width', String(columnWidth)) }, [columnWidth])

  const refresh = async (id = currentDir) => {
    try {
      const page = await api.list(id, hidden)
      if (id === '') setRoot(page); else setExpanded(previous => ({ ...previous, [id]: page }))
    } catch (e) { setError(messageOf(e)) }
  }
  const navigateGrid = async (entry: Entry) => {
    setSelected(new Set()); setPrimary(null); setCurrentDir(entry.id)
    setColumnPath(previous => {
      const parentIndex = previous.findIndex(item => item.id === entry.parentId)
      const parentPath = entry.parentId === '' ? [] : parentIndex >= 0 ? previous.slice(0, parentIndex + 1) : previous
      return [...parentPath, entry]
    })
    if (!expanded[entry.id]) {
      try { const page = await api.list(entry.id, hidden); setExpanded(previous => ({ ...previous, [entry.id]: page })) }
      catch (e) { setError(messageOf(e)) }
    }
  }
  const navigateColumn = async (entry: Entry, columnIndex: number) => {
    setSelected(new Set([entry.id])); setPrimary(entry); setCurrentDir(entry.id)
    setColumnPath(previous => [...previous.slice(0, columnIndex), entry])
    if (!expanded[entry.id]) {
      try { const page = await api.list(entry.id, hidden); setExpanded(previous => ({ ...previous, [entry.id]: page })) }
      catch (e) { setError(messageOf(e)) }
    }
  }
  const selectColumnItems = (ids: Set<string>, entry: Entry | null, columnIndex: number, directoryId: string) => {
    setSelected(ids); setPrimary(entry); setCurrentDir(directoryId)
    setColumnPath(previous => previous.slice(0, columnIndex))
  }
  const selectParentColumn = (columnIndex: number) => {
    const parent = columnPath[columnIndex - 1]
    if (!parent) { setSelected(new Set()); setPrimary(null); setColumnPath([]); setCurrentDir(''); return }
    setSelected(new Set([parent.id])); setPrimary(parent); setColumnPath(previous => previous.slice(0, columnIndex)); setCurrentDir(parent.id)
  }
  const activate = async (entry: Entry) => {
    if (entry.kind === 'directory') return navigateGrid(entry)
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
  const rename = async () => {
    const entry = findEntry(first(selected), root, expanded); if (!entry) return
    const name = prompt('Rename item', entry.name); if (!name || name === entry.name) return
    const perform = (replace = false) => api.operate('rename', [entry.id], entry.parentId, name, replace)
    setError('')
    let renamed: Entry
    try { [renamed] = await perform() } catch (e) {
      if (!(e instanceof ApiFailure) || e.code !== 'already_exists' || !confirm(`${e.message}. Replace it and move the old item to Trash?`)) { setError(messageOf(e)); return }
      try { [renamed] = await perform(true) } catch (retryError) { setError(messageOf(retryError)); return }
    }
    await refresh(entry.parentId)
    const pathIndex = columnPath.findIndex(item => item.id === entry.id)
    if (entry.kind === 'directory' && pathIndex >= 0) {
      try {
        const page = await api.list(renamed.id, hidden)
        setExpanded(previous => { const next = { ...previous }; delete next[entry.id]; next[renamed.id] = page; return next })
        setColumnPath(previous => [...previous.slice(0, pathIndex), renamed]); setCurrentDir(renamed.id)
      } catch (e) { setError(messageOf(e)); setColumnPath(previous => previous.slice(0, pathIndex)); setCurrentDir(entry.parentId) }
    } else setCurrentDir(renamed.parentId)
    setSelected(new Set([renamed.id])); setPrimary(renamed)
  }
  const deleteSelected = async () => {
    if (!selected.size || !confirm(`Move ${selected.size} selected item${selected.size === 1 ? '' : 's'} to Trash?`)) return
    const parents = new Set(Array.from(selected).map(id => findEntry(id, root, expanded)?.parentId ?? ''))
    try { await api.trash(Array.from(selected)); const pathIndex = columnPath.findIndex(entry => selected.has(entry.id)); if (pathIndex >= 0) { setColumnPath(previous => previous.slice(0, pathIndex)); setCurrentDir(columnPath[pathIndex]?.parentId ?? '') } setSelected(new Set()); setPrimary(null); await Promise.all(Array.from(parents).map(refresh)) } catch (e) { setError(messageOf(e)) }
  }
  const deleteEntry = async (entry: Entry) => {
    await api.trash([entry.id])
    const pathIndex = columnPath.findIndex(item => item.id === entry.id)
    if (pathIndex >= 0) { setColumnPath(previous => previous.slice(0, pathIndex)); setCurrentDir(entry.parentId) }
    setSelected(new Set()); setPrimary(null); await refresh(entry.parentId)
  }
  const paste = () => {
    if (!clipboard) return
    mutate(async () => { await api.operate(clipboard.operation, clipboard.ids, currentDir); if (clipboard.operation === 'move') setClipboard(null) }, currentDir, async () => { await api.operate(clipboard.operation, clipboard.ids, currentDir, undefined, true); if (clipboard.operation === 'move') setClipboard(null) })
  }
  const moveByDrag = async (ids: string[], destinationId: string) => {
    const movableIds = ids.filter(id => findEntry(id, root, expanded)?.parentId !== destinationId)
    if (!movableIds.length) return
    const destination = findEntry(destinationId, root, expanded)
    if (destination && movableIds.some(id => {
      const source = findEntry(id, root, expanded)
      return source?.kind === 'directory' && destination.path.startsWith(`${source.path}/`)
    })) { setError('A directory cannot be moved inside itself.'); return }
    const sourceParents = new Set(movableIds.map(id => findEntry(id, root, expanded)?.parentId ?? ''))
    const perform = (replace = false) => api.operate('move', movableIds, destinationId, undefined, replace)
    setError('')
    try {
      await perform()
    } catch (e) {
      if (!(e instanceof ApiFailure) || e.code !== 'already_exists' ||
          !confirm(`${e.message}. Replace it and move the old item to Trash?`)) {
        setError(messageOf(e)); return
      }
      try { await perform(true) } catch (retryError) { setError(messageOf(retryError)); return }
    }
    const pathIndex = columnPath.findIndex(entry => movableIds.includes(entry.id))
    if (pathIndex >= 0) { setColumnPath(previous => previous.slice(0, pathIndex)); setCurrentDir(columnPath[pathIndex]?.parentId ?? '') }
    setSelected(new Set()); setPrimary(null)
    await Promise.all(Array.from(new Set([...sourceParents, destinationId])).map(id => refresh(id)))
  }
  const openTrash = async () => { try { setTrash(await api.listTrash()) } catch (e) { setError(messageOf(e)) } }
  const logout = async () => { try { await api.logout() } finally { onLogout() } }

  const activePage = currentDir === '' ? root : expanded[currentDir]
  const gridRows = (activePage?.entries ?? []).filter(entry => entry.name.toLowerCase().includes(filter.toLowerCase())).map(entry => ({ entry, depth: 0 }))
  const visibleCount = gridRows.length
  const previewEntries = Array.from(selected).map(id => findEntry(id, root, expanded)).filter((entry): entry is Entry => Boolean(entry))
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
      <main className={`browser ${view === 'details' ? 'column-view' : ''}`}>
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
          <button className={`icon-button ${showPreview ? 'active' : ''}`} title={`${showPreview ? 'Hide' : 'Show'} preview`} aria-pressed={showPreview} onClick={() => setShowPreview(value => !value)}><Eye size={16} /></button>
          <ViewSelector view={view} setView={setView} />
        </div>
        <div className="location"><nav className="breadcrumbs" aria-label="Current directory"><button onClick={() => { setCurrentDir(''); setSelected(new Set()); setPrimary(null); setColumnPath([]) }}>fs-root</button>{columnPath.map((entry, index) => <span key={entry.id}><ChevronRight /><button onClick={() => { setCurrentDir(entry.id); setSelected(new Set()); setPrimary(null); setColumnPath(previous => previous.slice(0, index + 1)) }}>{entry.name}</button></span>)}</nav><span>{visibleCount} visible</span></div>
        {error && <div className="banner error"><span>{error}</span><button onClick={() => setError('')}><X size={15} /></button></div>}
        <div className="browser-body"><div className="browser-view">
          {!root ? <div className="center"><span className="spinner" /></div> : view === 'details' ?
            <ColumnBrowser root={root} path={columnPath} pages={expanded} filter={filter} selected={selected} primary={primary} columnWidth={columnWidth} setColumnWidth={setColumnWidth} navigate={navigateColumn} selectItems={selectColumnItems} selectParent={selectParentColumn} activate={activate} moveEntries={moveByDrag} deleteEntry={deleteEntry} setError={setError} /> :
            !activePage ? <div className="center"><span className="spinner" /></div> : gridRows.length === 0 ? <Empty /> : <FileList rows={gridRows} view={view} selected={selected} setSelected={setSelected} setPrimary={setPrimary} activate={activate} moveEntries={moveByDrag} deleteEntry={deleteEntry} setError={setError} />}
        </div>{showPreview && <ColumnPreview entries={previewEntries} primary={primary} />}</div>
      </main>
    </div>
    {editor && <EditorWindow document={editor} onClose={() => setEditor(null)} onSaved={setEditor} />}
    {viewer && <ViewerWindow {...viewer} onClose={() => setViewer(null)} />}
    {trash && <TrashWindow items={trash} onClose={() => setTrash(null)} onChanged={async () => setTrash(await api.listTrash())} onRestored={entry => refresh(entry.parentId)} setError={setError} />}
  </div>
}

type BrowserColumn = { directoryId: string; page?: EntryPage; label: string }
function ColumnBrowser({ root, path, pages, filter, selected, primary, columnWidth, setColumnWidth, navigate, selectItems, selectParent, activate, moveEntries, deleteEntry, setError }: {
  root: EntryPage; path: Entry[]; pages: Record<string, EntryPage>; filter: string; selected: Set<string>; primary: Entry | null
  columnWidth: number; setColumnWidth: (width: number) => void
  navigate: (entry: Entry, columnIndex: number) => Promise<void>; selectItems: (ids: Set<string>, primary: Entry | null, columnIndex: number, directoryId: string) => void
  selectParent: (columnIndex: number) => void; activate: (entry: Entry) => void; moveEntries: (ids: string[], destinationId: string) => Promise<void>
  deleteEntry: (entry: Entry) => Promise<void>; setError: (message: string) => void
}) {
  const columns: BrowserColumn[] = [{ directoryId: '', page: root, label: 'fs-root' }, ...path.map(entry => ({ directoryId: entry.id, page: pages[entry.id], label: entry.name }))]
  const [activeColumn, setActiveColumn] = useState(0)
  const [menu, setMenu] = useState<{ entry: Entry; columnIndex: number; x: number; y: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const anchor = useRef<{ column: number; index: number } | null>(null)
  const draggedIds = useRef<string[]>([])
  const scroller = useRef<HTMLDivElement>(null)
  const columnRefs = useRef<Array<HTMLDivElement | null>>([])
  useEffect(() => {
    setActiveColumn(Math.min(path.length, columns.length - 1))
    requestAnimationFrame(() => scroller.current?.scrollTo({ left: scroller.current.scrollWidth, behavior: 'smooth' }))
  }, [path.length])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    addEventListener('pointerdown', close); addEventListener('keydown', escape)
    return () => { removeEventListener('pointerdown', close); removeEventListener('keydown', escape) }
  }, [menu])
  const visibleEntries = (column: BrowserColumn) => (column.page?.entries ?? []).filter(entry => entry.name.toLowerCase().includes(filter.toLowerCase()))
  const choose = (entry: Entry, columnIndex: number, entryIndex: number, event?: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => {
    const entries = visibleEntries(columns[columnIndex])
    setActiveColumn(columnIndex)
    if (event?.shiftKey && anchor.current?.column === columnIndex) {
      const start = Math.min(anchor.current.index, entryIndex), end = Math.max(anchor.current.index, entryIndex)
      selectItems(new Set(entries.slice(start, end + 1).map(item => item.id)), entry, columnIndex, columns[columnIndex].directoryId)
      return
    }
    if (event?.metaKey || event?.ctrlKey) {
      const next = activeColumn === columnIndex ? new Set(selected) : new Set<string>()
      next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id)
      anchor.current = { column: columnIndex, index: entryIndex }
      selectItems(next, next.has(entry.id) ? entry : null, columnIndex, columns[columnIndex].directoryId)
      return
    }
    anchor.current = { column: columnIndex, index: entryIndex }
    selectItems(new Set([entry.id]), entry, columnIndex, columns[columnIndex].directoryId)
  }
  const keyboard = (event: React.KeyboardEvent, columnIndex: number) => {
    const entries = visibleEntries(columns[columnIndex])
    if (!entries.length) return
    let index = primary ? entries.findIndex(entry => entry.id === primary.id) : -1
    const current = index >= 0 ? entries[index] : null
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); index = event.key === 'ArrowDown' ? Math.min(entries.length - 1, index + 1) : Math.max(0, index < 0 ? entries.length - 1 : index - 1)
      choose(entries[index], columnIndex, index)
    } else if (event.key === 'ArrowRight' && current?.kind === 'directory') {
      event.preventDefault(); void navigate(current, columnIndex).then(() => setTimeout(() => columnRefs.current[columnIndex + 1]?.focus()))
    } else if (event.key === 'ArrowLeft' && columnIndex > 0) {
      event.preventDefault(); selectParent(columnIndex); setTimeout(() => columnRefs.current[columnIndex - 1]?.focus())
    } else if (event.key === 'Enter' && current) { event.preventDefault(); current.kind === 'directory' ? void navigate(current, columnIndex) : activate(current) }
  }
  const startResize = (event: React.PointerEvent) => {
    event.preventDefault(); const startX = event.clientX, startWidth = columnWidth
    const move = (pointer: PointerEvent) => setColumnWidth(Math.min(480, Math.max(180, startWidth + pointer.clientX - startX)))
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up) }
    addEventListener('pointermove', move); addEventListener('pointerup', up)
  }
  const startDrag = (event: React.DragEvent, entry: Entry, columnIndex: number) => {
    const ids = selected.has(entry.id) ? Array.from(selected) : [entry.id]
    draggedIds.current = ids
    if (!selected.has(entry.id)) selectItems(new Set([entry.id]), entry, columnIndex, entry.parentId)
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-remote-file-browser', ids.join(',')); event.dataTransfer.setData('text/plain', entry.name)
  }
  const acceptDrop = (event: React.DragEvent, id: string) => {
    if (!draggedIds.current.length || draggedIds.current.includes(id)) return false
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropTarget(id || '__root__'); return true
  }
  const drop = (event: React.DragEvent, id: string) => {
    if (!acceptDrop(event, id)) return
    const ids = draggedIds.current; draggedIds.current = []; setDropTarget(null); void moveEntries(ids, id)
  }
  return <div className="column-browser" ref={scroller} style={{ '--column-width': `${columnWidth}px` } as React.CSSProperties}>
    {columns.map((column, columnIndex) => {
      const entries = visibleEntries(column), targetKey = column.directoryId || '__root__'
      return <div className={`finder-column ${activeColumn === columnIndex ? 'active' : ''} ${dropTarget === targetKey ? 'drop-target' : ''}`} key={column.directoryId || '__root__'} ref={node => { columnRefs.current[columnIndex] = node }} tabIndex={0} role="listbox" aria-label={column.label} aria-multiselectable="true" onFocus={() => setActiveColumn(columnIndex)} onKeyDown={event => keyboard(event, columnIndex)} onDragOver={event => acceptDrop(event, column.directoryId)} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) }} onDrop={event => drop(event, column.directoryId)}>
        {!column.page ? <div className="column-state"><span className="spinner" /></div> : entries.length === 0 ? <div className="column-state">{filter ? 'No matches' : 'Empty folder'}</div> : entries.map((entry, entryIndex) => <div className={`column-row ${selected.has(entry.id) ? 'selected' : ''} ${dropTarget === entry.id ? 'drop-target' : ''}`} key={entry.id} role="option" aria-selected={selected.has(entry.id)} draggable onDragStart={event => startDrag(event, entry, columnIndex)} onDragEnd={() => { draggedIds.current = []; setDropTarget(null) }} onClick={event => choose(entry, columnIndex, entryIndex, event)} onDoubleClick={() => entry.kind === 'directory' ? void navigate(entry, columnIndex) : activate(entry)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu({ entry, columnIndex, x: Math.min(event.clientX, innerWidth - 198), y: Math.min(event.clientY, innerHeight - 140) }) }} onDragOver={event => { if (entry.kind === 'directory') acceptDrop(event, entry.id) }} onDrop={event => { if (entry.kind === 'directory') drop(event, entry.id) }}>
          <FileGlyph entry={entry} /><span title={entry.name}>{entry.name}</span>{entry.kind === 'directory' && <ChevronRight className="column-arrow" />}
        </div>)}
        <div className="column-resizer" role="separator" aria-orientation="vertical" title="Resize columns" onPointerDown={startResize} />
      </div>
    })}
    {menu && <ContextMenu entry={menu.entry} x={menu.x} y={menu.y} close={() => setMenu(null)} open={() => menu.entry.kind === 'directory' ? void navigate(menu.entry, menu.columnIndex) : activate(menu.entry)} deleteEntry={deleteEntry} setError={setError} />}
  </div>
}

function ColumnPreview({ entries, primary }: { entries: Entry[]; primary: Entry | null }) {
  if (!entries.length) return <aside className="column-preview"><div className="preview-placeholder"><Eye /><span>Select an item to preview</span></div></aside>
  if (entries.length > 1) return <aside className="column-preview"><div className="preview-hero"><File className="preview-glyph" /><strong>{entries.length} items</strong><span>{formatBytes(entries.reduce((sum, entry) => sum + entry.size, 0))}</span></div></aside>
  const entry = primary && entries.some(item => item.id === primary.id) ? primary : entries[0]
  return <aside className="column-preview">
    <div className="preview-hero">
      {entry.mime.startsWith('image/') ? <img src={thumbnailUrl(entry.id, 'large')} alt="" /> : entry.mime.startsWith('video/') ? <VideoPlayer key={entry.id} entry={entry} autoPlay={false} /> : entry.mime.startsWith('audio/') ? <audio key={entry.id} src={mediaUrl(entry.id)} controls preload="metadata" /> : <FileGlyph entry={entry} />}
      <strong title={entry.name}>{entry.name}</strong><span>{entry.kind === 'directory' ? 'Folder' : entry.mime}</span>
    </div>
    <dl className="preview-metadata"><dt>Size</dt><dd>{formatBytes(entry.size)}</dd><dt>Permissions</dt><dd><code>{entry.permissions} {entry.mode.toString(8)}</code></dd><dt>Owner</dt><dd>{entry.uid}:{entry.gid}</dd><dt>Modified</dt><dd>{formatDate(entry.modifiedAt)}</dd><dt>Created</dt><dd>{formatDate(entry.createdAt)}</dd><dt>Accessed</dt><dd>{formatDate(entry.accessedAt)}</dd></dl>
  </aside>
}

type Row = { entry: Entry; depth: number }

function FileList({ rows, view, selected, setSelected, setPrimary, activate, moveEntries, deleteEntry, setError }: {
  rows: Row[]; view: ViewMode; selected: Set<string>; setSelected: (value: Set<string>) => void; setPrimary: (entry: Entry | null) => void
  activate: (entry: Entry) => void
  moveEntries: (ids: string[], destinationId: string) => Promise<void>
  deleteEntry: (entry: Entry) => Promise<void>; setError: (message: string) => void
}) {
  const [menu, setMenu] = useState<{ entry: Entry; x: number; y: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const draggedIds = useRef<string[]>([])
  const anchor = useRef<number | null>(null)
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
  const choose = (entry: Entry, checked: boolean) => { const next = new Set(selected); checked ? next.add(entry.id) : next.delete(entry.id); setSelected(next); setPrimary(checked ? entry : null) }
  const selectEntry = (entry: Entry, index: number, event: React.MouseEvent) => {
    if (event.shiftKey && anchor.current !== null) {
      const start = Math.min(anchor.current, index), end = Math.max(anchor.current, index)
      setSelected(new Set(rows.slice(start, end + 1).map(row => row.entry.id))); setPrimary(entry); return
    }
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(selected); next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id)
      setSelected(next); setPrimary(next.has(entry.id) ? entry : null); anchor.current = index; return
    }
    setSelected(new Set([entry.id])); setPrimary(entry); anchor.current = index
  }
  const dragProps = (entry: Entry) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      const ids = selected.has(entry.id) ? Array.from(selected) : [entry.id]
      draggedIds.current = ids
      if (!selected.has(entry.id)) { setSelected(new Set([entry.id])); setPrimary(entry) }
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('application/x-remote-file-browser', ids.join(','))
      event.dataTransfer.setData('text/plain', entry.name)
    },
    onDragEnd: () => { draggedIds.current = []; setDropTarget(null) },
    onDragOver: (event: React.DragEvent) => {
      if (entry.kind !== 'directory' || !draggedIds.current.length || draggedIds.current.includes(entry.id)) return
      event.preventDefault(); event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'; setDropTarget(entry.id)
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(current => current === entry.id ? null : current)
    },
    onDrop: (event: React.DragEvent) => {
      if (entry.kind !== 'directory' || !draggedIds.current.length || draggedIds.current.includes(entry.id)) return
      event.preventDefault(); event.stopPropagation()
      const ids = draggedIds.current; draggedIds.current = []; setDropTarget(null)
      void moveEntries(ids, entry.id)
    },
  })
  const contextMenu = menu && <ContextMenu {...menu} close={() => setMenu(null)} open={() => activate(menu.entry)} deleteEntry={deleteEntry} setError={setError} />
  return <div className={`preview-list ${view}`}>
    {rows.map(({ entry, depth }, index) => <div className={`preview-card ${selected.has(entry.id) ? 'selected' : ''} ${dropTarget === entry.id ? 'drop-target' : ''}`} style={{ marginLeft: depth * 18 }} key={entry.id} onClick={event => selectEntry(entry, index, event)} onDoubleClick={() => activate(entry)} onContextMenu={event => showMenu(event, entry)} {...dragProps(entry)}>
      <input type="checkbox" checked={selected.has(entry.id)} onClick={event => event.stopPropagation()} onChange={e => choose(entry, e.target.checked)} />
      <button className="card-menu" aria-label={`Actions for ${entry.name}`} onClick={event => showMenu(event, entry)}><MoreHorizontal /></button>
      {entry.kind === 'directory' ? <button className="preview-image folder-preview" tabIndex={-1}><Folder /></button> : isPreviewable(entry) ? <button className="preview-image" tabIndex={-1}><img src={thumbnailUrl(entry.id, view)} loading="lazy" /></button> : <button className="preview-image" tabIndex={-1}><FileGlyph entry={entry} /></button>}
      <button className="filename" tabIndex={-1} title={entry.name}>{entry.name}</button>
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
    {(['details', 'small', 'medium', 'large'] as ViewMode[]).map(mode => <button className={view === mode ? 'active' : ''} title={mode === 'details' ? 'columns' : mode} key={mode} onClick={() => setView(mode)}>{mode === 'details' ? <Columns3 /> : mode === 'small' ? <Menu /> : mode === 'medium' ? <Grid2X2 /> : <Maximize2 />}</button>)}
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

function VideoPlayer({ entry, autoPlay = true }: { entry: Entry; autoPlay?: boolean }) {
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
  return <div className="video-stage"><video ref={videoRef} src={mediaUrl(entry.id)} controls autoPlay={autoPlay} preload={autoPlay ? 'auto' : 'metadata'} onError={fallback} />{message && <div className="video-message">{message}</div>}</div>
}

function TrashWindow({ items, onClose, onChanged, onRestored, setError }: { items: TrashEntry[]; onClose: () => void; onChanged: () => Promise<void>; onRestored: (entry: Entry) => Promise<void>; setError: (s: string) => void }) {
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await onChanged() } catch (e) { setError(messageOf(e)) } }
  const restore = async (item: TrashEntry) => {
    try {
      let entry: Entry
      try {
        entry = await api.restore(item.info.id)
      } catch (e) {
        if (!(e instanceof ApiFailure) || e.code !== 'already_exists' || !confirm(`${e.message}. Replace it and move the old item to Trash?`)) throw e
        entry = await api.restore(item.info.id, undefined, true)
      }
      await Promise.all([onChanged(), onRestored(entry)])
    } catch (e) { setError(messageOf(e)) }
  }
  return <FloatingWindow title="Trash" onClose={onClose} className="trash-window">
    <div className="window-toolbar"><span>{items.length} item{items.length === 1 ? '' : 's'}</span><span className="toolbar-spacer" /><button disabled={!items.length} onClick={() => confirm('Permanently delete everything in Trash? This cannot be undone.') && act(api.emptyTrash)}><Trash2 /> Empty Trash</button></div>
    <div className="trash-list">{items.length === 0 ? <Empty label="Trash is empty" /> : items.map(item => <div className="trash-row" key={item.info.id}><FileGlyph entry={{ kind: item.kind } as Entry} /><div><strong>{item.info.originalName}</strong><small>Deleted {formatDate(item.info.deletedAt)}</small></div><span>{formatBytes(item.size)}</span><button onClick={() => restore(item)}>Restore</button><button className="danger" onClick={() => confirm(`Permanently delete ${item.info.originalName}?`) && act(() => api.purge(item.info.id))}><Trash2 /></button></div>)}</div>
  </FloatingWindow>
}

function FloatingWindow({ title, onClose, className = '', children }: { title: string; onClose: () => void; className?: string; children: React.ReactNode }) {
  const [position, setPosition] = useState({ x: Math.max(20, innerWidth * .12), y: 90 })
  const drag = useRef<{ x: number; y: number } | null>(null)
  return <div className={`floating ${className}`} style={{ left: position.x, top: position.y }}>
    <div className="window-title" onPointerDown={e => { drag.current = { x: e.clientX - position.x, y: e.clientY - position.y }; e.currentTarget.setPointerCapture(e.pointerId) }} onPointerMove={e => { if (drag.current) setPosition({ x: Math.max(0, e.clientX - drag.current.x), y: Math.max(0, e.clientY - drag.current.y) }) }} onPointerUp={() => { drag.current = null }}><span>{title}</span><button aria-label={`Close ${title}`} onPointerDown={e => e.stopPropagation()} onClick={onClose}><X /></button></div>
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
