import { createContext, forwardRef, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import Hls from 'hls.js'
import {
  Camera, Check, ChevronLeft, ChevronRight, ClipboardPaste, Columns3, Copy, Download, Edit3, Eraser, Eye, File, FileImage, FileText,
  Film, Folder, FolderOpen, Grid2X2, Info, LogOut, Maximize2, Menu, MoreHorizontal, Pencil, Play,
  ExternalLink, Link2, Minus, Plus, RefreshCw, RotateCw, Save, Scissors, Search, SquareTerminal, Trash2, Undo2, Upload, WrapText, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import { api, ApiFailure, CacheCleanupReport, ConcatenationJob, contentUrl, ConversionJob, DocumentFile, Entry, EntryPage, ExtractionJob, LiveEvent, liveEventsUrl, liveFilesystemWatchMessage, mediaUrl, ProvenanceChange, Session, setCsrf, thumbnailUrl, TrashEntry } from './api'
import { deleteConfirmationMessage } from './deleteConfirmation'
import { updateFinderPathForSelection } from './finderPath'
import { applyProvenanceToEntry, applyProvenanceToPage } from './provenanceState'
import { fitMediaWindow, formatMediaTime, ignoresVideoShortcut, shouldAutoLoop, stepFrame, validSegment } from './videoPlayerState'
import { jobsFromSnapshot, progressPercent, upsertJob } from './mediaJobState'
import { fitContextMenuToViewport } from './contextMenuPosition'
import { isAdjacentColumnMove, moveConfirmationMessage, springLoadedPath } from './columnDrag'
import { directoryContentsLabel, propertyTypeLabel } from './propertiesState'
import { TerminalDock } from './TerminalDock'
import { ClipboardOperation, RemoteClipboard, clipboardIdsForEntry, clipboardShortcut, movableClipboardIds, pasteProblem, shouldHandleClipboardShortcut } from './fileClipboard'
import { isMarkdownLocalTarget, isMarkdownMp4Source, markdownSanitizeSchema, markdownUrlTransform, resolveMarkdownFileId, resolveMarkdownMediaSource } from './markdownPreview'
import { launchVfxEditor } from './vfxLaunch'
import { canvasPng, drawMarkupStroke, MarkupStroke, markupPoint, markupStrokeWidth } from './imageMarkup'
import { editorSaveShortcut, proportionalScrollTop, shouldApplyDocumentResponse, wheelDeltaPixels } from './editorState'
import { MOBILE_MEDIA_QUERY, observeMobileMode } from './mobileMode'

type ViewMode = 'details' | 'small' | 'medium' | 'large'
type EditorMode = 'edit' | 'split' | 'preview'
type OpenEditor = { document: DocumentFile; entry: Pick<Entry, 'id' | 'name' | 'path'> }
type ConfirmOptions = { title?: string; confirmLabel?: string; danger?: boolean }
type ConfirmRequest = ConfirmOptions & { message: string; resolve: (answer: boolean) => void }
const ConfirmContext = createContext<(message: string, options?: ConfirmOptions) => Promise<boolean>>(async () => false)
type MergeChoice = 'cancel' | 'replace' | 'merge'
type MergeRequest = { message: string; resolve: (choice: MergeChoice) => void }
const MergeContext = createContext<(message: string) => Promise<MergeChoice>>(async () => 'cancel')
type PromptOptions = { title: string; label?: string; initialValue?: string; submitLabel?: string; placeholder?: string }
type PromptRequest = PromptOptions & { resolve: (answer: string | null) => void }
const PromptContext = createContext<(options: PromptOptions) => Promise<string | null>>(async () => null)
const VfxEditorContext = createContext(false)

function useMobileMode() {
  const [mobile, setMobile] = useState(() => matchMedia(MOBILE_MEDIA_QUERY).matches)
  useEffect(() => observeMobileMode(window.matchMedia.bind(window), setMobile), [])
  return mobile
}

function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const confirmAction = useCallback((message: string, options: ConfirmOptions = {}) => new Promise<boolean>(resolve => setRequest({ message, resolve, ...options })), [])
  const answer = (value: boolean) => { request?.resolve(value); setRequest(null) }
  useEffect(() => {
    if (!request) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') answer(false) }
    addEventListener('keydown', escape); return () => removeEventListener('keydown', escape)
  }, [request])
  return <ConfirmContext.Provider value={confirmAction}>{children}{request && <div className="modal-backdrop" role="presentation" onPointerDown={() => answer(false)}><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message" onPointerDown={event => event.stopPropagation()}><div className={`confirm-mark ${request.danger ? 'danger' : ''}`}>{request.danger ? <Trash2 /> : <FolderOpen />}</div><h2 id="confirm-title">{request.title ?? 'Confirm action'}</h2><p id="confirm-message" className="confirm-message">{request.message}</p><div className="confirm-actions"><button autoFocus onClick={() => answer(false)}>Cancel</button><button className={request.danger ? 'danger-confirm' : 'primary'} onClick={() => answer(true)}>{request.confirmLabel ?? 'Continue'}</button></div></section></div>}</ConfirmContext.Provider>
}
function useConfirm() { return useContext(ConfirmContext) }

function MergeProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<MergeRequest | null>(null)
  const chooseMerge = useCallback((message: string) => new Promise<MergeChoice>(resolve => setRequest({ message, resolve })), [])
  const answer = (choice: MergeChoice) => { request?.resolve(choice); setRequest(null) }
  useEffect(() => {
    if (!request) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') answer('cancel') }
    addEventListener('keydown', escape); return () => removeEventListener('keydown', escape)
  }, [request])
  return <MergeContext.Provider value={chooseMerge}>{children}{request && <div className="modal-backdrop" role="presentation" onPointerDown={() => answer('cancel')}><section className="confirm-dialog merge-dialog" role="alertdialog" aria-modal="true" aria-labelledby="merge-title" aria-describedby="merge-message" onPointerDown={event => event.stopPropagation()}><div className="confirm-mark danger"><FolderOpen /></div><h2 id="merge-title">Folder already exists</h2><p id="merge-message">{request.message}</p><p className="merge-detail">Replace moves the entire destination folder to Trash. Merge combines both trees, but nested same-name files are replaced and moved to Trash.</p><div className="confirm-actions merge-actions"><button autoFocus onClick={() => answer('cancel')}>Cancel</button><button className="danger-confirm" onClick={() => answer('replace')}>Destructively replace</button><button className="primary" onClick={() => answer('merge')}>Merge</button></div></section></div>}</MergeContext.Provider>
}
function useMergeChoice() { return useContext(MergeContext) }

function PromptProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<PromptRequest | null>(null)
  const [value, setValue] = useState('')
  const promptAction = useCallback((options: PromptOptions) => new Promise<string | null>(resolve => { setValue(options.initialValue ?? ''); setRequest({ ...options, resolve }) }), [])
  const answer = (result: string | null) => { request?.resolve(result); setRequest(null) }
  useEffect(() => {
    if (!request) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') answer(null) }
    addEventListener('keydown', escape); return () => removeEventListener('keydown', escape)
  }, [request])
  const submit = (event: React.FormEvent) => { event.preventDefault(); const name = value.trim(); if (name) answer(name) }
  return <PromptContext.Provider value={promptAction}>{children}{request && <div className="modal-backdrop" role="presentation" onPointerDown={() => answer(null)}><form className="confirm-dialog prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-title" onSubmit={submit} onPointerDown={event => event.stopPropagation()}><div className="confirm-mark"><Edit3 /></div><h2 id="prompt-title">{request.title}</h2><label>{request.label ?? 'Name'}<input value={value} onChange={event => setValue(event.target.value)} onFocus={event => event.target.select()} placeholder={request.placeholder} autoFocus /></label><div className="confirm-actions"><button type="button" onClick={() => answer(null)}>Cancel</button><button className="primary" disabled={!value.trim()}>{request.submitLabel ?? 'Create'}</button></div></form></div>}</PromptContext.Provider>
}
function usePrompt() { return useContext(PromptContext) }

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  useEffect(() => { api.session().then(s => { setCsrf(s.csrfToken); setSession(s) }) }, [])
  if (!session) return <div className="center"><span className="spinner" /></div>
  if (!session.authenticated) return <Login onLogin={s => { setCsrf(s.csrfToken); setSession(s) }} />
  return <ConfirmProvider><MergeProvider><PromptProvider><VfxEditorContext.Provider value={session.vfxEditorEnabled}><FileManager session={session} onLogout={() => { setCsrf(); setSession({ authenticated: false, terminalEnabled: false, vfxEditorEnabled: false }) }} /></VfxEditorContext.Provider></PromptProvider></MergeProvider></ConfirmProvider>
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
  const confirmAction = useConfirm()
  const chooseMerge = useMergeChoice()
  const promptAction = usePrompt()
  const [root, setRoot] = useState<EntryPage | null>(null)
  const [expanded, setExpanded] = useState<Record<string, EntryPage>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [primary, setPrimary] = useState<Entry | null>(null)
  const [columnPath, setColumnPath] = useState<Entry[]>([])
  const [currentDir, setCurrentDir] = useState('')
  const [view, setView] = useState<ViewMode>(() => (localStorage.getItem('rfb-view') as ViewMode) || 'details')
  const [hidden, setHidden] = useState(() => localStorage.getItem('rfb-hidden') === 'true')
  const [filter, setFilter] = useState('')
  const [clipboard, setClipboard] = useState<RemoteClipboard>(null)
  const [editor, setEditor] = useState<OpenEditor | null>(null)
  const [editorDirty, setEditorDirty] = useState(false)
  const [viewer, setViewer] = useState<{ entry: Entry; type: 'image' | 'video' } | null>(null)
  const [trash, setTrash] = useState<TrashEntry[] | null>(null)
  const [error, setError] = useState('')
  const [folderMenu, setFolderMenu] = useState<{ directoryId: string; path: string; x: number; y: number } | null>(null)
  const [properties, setProperties] = useState<{ id: string; initial?: Entry } | null>(null)
  const [terminal, setTerminal] = useState<{ directoryId: string; hidden: boolean } | null>(null)
  const isMobile = useMobileMode()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [mobileSelecting, setMobileSelecting] = useState(false)
  const [mobileSelectionMenu, setMobileSelectionMenu] = useState(false)
  const [showPreview, setShowPreview] = useState(() => localStorage.getItem('rfb-column-preview') !== 'false')
  const [defaultColumnWidth] = useState(() => Math.min(480, Math.max(180, Number(localStorage.getItem('rfb-column-width')) || 240)))
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem('rfb-column-widths') || '{}')
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
      return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])))
    }
    catch { return {} }
  })
  const inputRef = useRef<HTMLInputElement>(null)
  const documentRequest = useRef(0)
  const liveEventsSocket = useRef<WebSocket | null>(null)
  const liveState = useRef({ root, expanded })
  liveState.current = { root, expanded }
  const liveDirectorySubscription = Object.keys(expanded).sort().join(',')

  const loadRoot = async () => { try { setRoot(await api.list('', hidden)); setExpanded({}); setSelected(new Set()); setPrimary(null); setColumnPath([]); setCurrentDir('') } catch (e) { setError(messageOf(e)) } }
  useEffect(() => { loadRoot() }, [hidden])
  useEffect(() => { localStorage.setItem('rfb-view', view) }, [view])
  useEffect(() => { localStorage.setItem('rfb-hidden', String(hidden)) }, [hidden])
  useEffect(() => { localStorage.setItem('rfb-column-preview', String(showPreview)) }, [showPreview])
  useEffect(() => { localStorage.setItem('rfb-column-widths', JSON.stringify(columnWidths)) }, [columnWidths])
  useEffect(() => {
    const changed = (event: Event) => {
      const { id, urls } = (event as CustomEvent<ProvenanceChange>).detail
      const apply = () => {
        const change = { id, urls }
        setRoot(page => page && applyProvenanceToPage(page, change))
        setExpanded(pages => Object.fromEntries(Object.entries(pages).map(([key, page]) => [key, applyProvenanceToPage(page, change)])))
        setPrimary(entry => entry && applyProvenanceToEntry(entry, change))
        setColumnPath(path => path.map(entry => applyProvenanceToEntry(entry, change)))
      }
      apply()
    }
    addEventListener('rfb:provenance-changed', changed)
    return () => removeEventListener('rfb:provenance-changed', changed)
  }, [])
  useEffect(() => {
    const socket = liveEventsSocket.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(liveFilesystemWatchMessage(['', ...Object.keys(liveState.current.expanded)]))
    }
  }, [liveDirectorySubscription])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let socket: WebSocket | undefined
    let stopped = false
    let retry = 1000
    const pending = new Set<string>()
    const refreshDirectories = async (ids?: string[]) => {
      const loaded = new Set(['', ...Object.keys(liveState.current.expanded)])
      const directoryIds = ids ? ids.filter(id => loaded.has(id)) : [...loaded]
      await Promise.all(directoryIds.map(async id => {
        try {
          const previousPage = id === '' ? liveState.current.root : liveState.current.expanded[id]
          const page = await api.list(id, hidden)
          if (id === '') setRoot(page); else setExpanded(previous => ({ ...previous, [id]: page }))
          if (previousPage) {
            const updatedEntry = (entry: Entry) => {
              if (entry.parentId !== id) return entry
              return page.entries.find(candidate => candidate.id === entry.id)
                ?? page.entries.find(candidate => candidate.etag === entry.etag)
                ?? entry
            }
            setPrimary(entry => entry && updatedEntry(entry))
            setColumnPath(path => path.map(updatedEntry))
            setViewer(open => open && ({ ...open, entry: updatedEntry(open.entry) }))
            setSelected(ids => new Set([...ids].map(selectedId => {
              const oldEntry = previousPage.entries.find(entry => entry.id === selectedId)
              return oldEntry ? updatedEntry(oldEntry).id : selectedId
            })))
          }
        } catch {
          if (id !== '') setExpanded(previous => {
            const next = { ...previous }; delete next[id]; return next
          })
        }
      }))
    }
    const schedule = (ids: string[]) => {
      ids.forEach(id => pending.add(id))
      clearTimeout(timer)
      timer = setTimeout(() => {
        const ids = [...pending]; pending.clear(); void refreshDirectories(ids)
      }, 100)
    }
    const resync = () => {
      void refreshDirectories()
      dispatchEvent(new Event('rfb:provenance-resync'))
      dispatchEvent(new Event('rfb:media-resync'))
    }
    const connect = () => {
      const connection = new WebSocket(liveEventsUrl())
      socket = connection
      liveEventsSocket.current = connection
      connection.onopen = () => {
        retry = 1000
        connection.send(liveFilesystemWatchMessage(['', ...Object.keys(liveState.current.expanded)]))
      }
      connection.onmessage = message => {
        try {
          const event = JSON.parse(message.data) as LiveEvent
          if (event.type === 'resync') resync()
          else if (event.type === 'filesystem') schedule(event.directoryIds)
          else if (event.type === 'provenance') dispatchEvent(new CustomEvent<ProvenanceChange>('rfb:provenance-changed', { detail: event.change }))
          else dispatchEvent(new CustomEvent<LiveEvent>('rfb:media-live', { detail: event }))
        } catch { resync() }
      }
      connection.onclose = () => {
        if (liveEventsSocket.current === connection) liveEventsSocket.current = null
        if (stopped) return
        reconnectTimer = setTimeout(connect, retry)
        retry = Math.min(30000, retry * 2)
      }
    }
    const videoReady = () => void refreshDirectories()
    addEventListener('rfb:video-ready', videoReady)
    connect()
    return () => {
      stopped = true; clearTimeout(timer); clearTimeout(reconnectTimer); socket?.close()
      if (liveEventsSocket.current === socket) liveEventsSocket.current = null
      removeEventListener('rfb:video-ready', videoReady)
    }
  }, [hidden])

  const refresh = async (id = currentDir) => {
    try {
      const page = await api.list(id, hidden)
      if (id === '') setRoot(page); else setExpanded(previous => ({ ...previous, [id]: page }))
    } catch (e) { setError(messageOf(e)) }
  }
  const loadDirectory = async (entry: Entry) => {
    if (liveState.current.expanded[entry.id]) return true
    try {
      const page = await api.list(entry.id, hidden)
      setExpanded(previous => ({ ...previous, [entry.id]: page }))
      return true
    } catch (e) { setError(messageOf(e)); return false }
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
  const selectColumnItems = (ids: Set<string>, entry: Entry | null, columnIndex: number, directoryId: string, preserveCurrentBranch = false) => {
    setSelected(ids); setPrimary(entry); setCurrentDir(directoryId)
    setColumnPath(previous => updateFinderPathForSelection(previous, ids, columnIndex, preserveCurrentBranch))
  }
  const selectParentColumn = (columnIndex: number) => {
    const parent = columnPath[columnIndex - 1]
    if (!parent) { setSelected(new Set()); setPrimary(null); setColumnPath([]); setCurrentDir(''); return }
    setSelected(new Set([parent.id])); setPrimary(parent); setColumnPath(previous => previous.slice(0, columnIndex)); setCurrentDir(parent.id)
  }
  const activate = async (entry: Entry) => {
    if (entry.kind === 'directory') { documentRequest.current++; return navigateGrid(entry) }
    if (entry.mime.startsWith('image/')) { documentRequest.current++; return setViewer({ entry, type: 'image' }) }
    if (entry.mime.startsWith('video/')) { documentRequest.current++; return setViewer({ entry, type: 'video' }) }
    if (editor?.document.id === entry.id) { documentRequest.current++; return }
    if (editor && editorDirty && !await confirmAction('Your unsaved edits will be lost.', { title: 'Discard unsaved changes?', confirmLabel: 'Discard', danger: true })) return
    const requestGeneration = ++documentRequest.current
    try {
      const document = await api.readDocument(entry.id)
      if (!shouldApplyDocumentResponse(requestGeneration, documentRequest.current, entry.id, document.id)) return
      setEditor({ document, entry: { id: entry.id, name: entry.name, path: entry.path } }); setEditorDirty(false)
    } catch {
      if (requestGeneration === documentRequest.current) window.location.href = contentUrl(entry.id)
    }
  }
  const activateMarkdownLink = async (id: string) => activate(await api.metadata(id))
  const mutate = async (action: () => Promise<unknown>, dir = currentDir, replace?: () => Promise<unknown>) => {
    setError(''); try { await action(); await refresh(dir) } catch (e) {
      if (replace && e instanceof ApiFailure && e.code === 'already_exists' && await confirmAction(`${e.message}. Replace it and move the old item to Trash?`, { title: 'Replace existing item?', confirmLabel: 'Replace', danger: true })) { try { await replace(); await refresh(dir); return } catch (retryError) { setError(messageOf(retryError)); return } }
      setError(messageOf(e))
    }
  }
  const createItem = async (kind: 'file' | 'directory', directoryId = currentDir) => {
    const name = await promptAction({ title: kind === 'directory' ? 'New Folder' : 'New File', label: 'Name', submitLabel: 'Create' }); if (!name) return
    await mutate(() => api.create(directoryId, name, kind), directoryId, () => api.create(directoryId, name, kind, true))
  }
  const showFolderMenu = (event: React.MouseEvent, directoryId: string, path: string) => {
    event.preventDefault(); event.stopPropagation(); setFolderMenu({ directoryId, path, x: event.clientX, y: event.clientY })
  }
  const showProperties = (id: string, initial?: Entry) => setProperties({ id, initial })
  const rename = async (target?: Entry) => {
    const entry = target ?? findEntry(first(selected), root, expanded); if (!entry) return
    const name = await promptAction({ title: 'Rename Item', label: 'Name', initialValue: entry.name, submitLabel: 'Rename' }); if (!name || name === entry.name) return
    const perform = (replace = false) => api.operate('rename', [entry.id], entry.parentId, name, replace)
    setError('')
    let renamed: Entry
    try { [renamed] = await perform() } catch (e) {
      if (!(e instanceof ApiFailure) || e.code !== 'already_exists' || !await confirmAction(`${e.message}. Replace it and move the old item to Trash?`, { title: 'Replace existing item?', confirmLabel: 'Replace', danger: true })) { setError(messageOf(e)); return }
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
  const deleteItems = async (ids: string[]) => {
    const names = ids.map(id => findEntry(id, root, expanded)?.name ?? id)
    if (!ids.length || !await confirmAction(deleteConfirmationMessage(names), { title: ids.length === 1 ? 'Delete item?' : 'Delete selected items?', confirmLabel: 'Move to Trash', danger: true })) return
    const idSet = new Set(ids)
    const parents = new Set(ids.map(id => findEntry(id, root, expanded)?.parentId ?? ''))
    try {
      await api.trash(ids)
      const pathIndex = columnPath.findIndex(entry => idSet.has(entry.id))
      if (pathIndex >= 0) { setColumnPath(previous => previous.slice(0, pathIndex)); setCurrentDir(columnPath[pathIndex]?.parentId ?? '') }
      setSelected(new Set()); setPrimary(null); await Promise.all(Array.from(parents).map(refresh))
    } catch (e) { setError(messageOf(e)) }
  }
  const deleteSelected = () => deleteItems(Array.from(selected))
  const deleteEntry = (entry: Entry) => deleteItems(selected.has(entry.id) ? Array.from(selected) : [entry.id])
  const concatenateVideos = async (entries: Entry[]) => {
    const first = entries[0]
    if (!first) return
    const stem = first.name.replace(/\.[^.]+$/, '') || 'videos'
    const outputName = await promptAction({ title: 'Concatenate videos', label: 'Output filename', initialValue: `${stem}-concatenated.mp4`, submitLabel: 'Concatenate' })
    if (!outputName) return
    try { await api.startConcatenation(entries.map(entry => entry.id), outputName); setError('') }
    catch (error) { setError(messageOf(error)) }
  }
  const stageClipboard = (operation: ClipboardOperation, target?: Entry) => {
    const ids = target ? clipboardIdsForEntry(target.id, selected) : Array.from(selected)
    if (!ids.length) return
    setError(''); setClipboard({ operation, ids })
  }
  const paste = async (destinationId = currentDir, destinationPath = destinationId ? findEntry(destinationId, root, expanded)?.path ?? '/fs-root' : '/fs-root') => {
    if (!clipboard) return
    const sources = clipboard.ids.map(id => findEntry(id, root, expanded)).filter((entry): entry is Entry => Boolean(entry))
    const problem = pasteProblem(clipboard.operation, sources, destinationId, destinationPath)
    if (problem) { setError(problem); return }
    const operationIds = clipboard.operation === 'move' ? movableClipboardIds(clipboard.ids, sources, destinationId) : clipboard.ids
    if (!operationIds.length) { setError(''); setClipboard(null); return }
    const sourceParents = new Set(sources.filter(source => operationIds.includes(source.id)).map(source => source.parentId))
    setError('')
    try {
      await api.operate(clipboard.operation, operationIds, destinationId)
    } catch (e) {
      if (clipboard.operation === 'move' && e instanceof ApiFailure && e.code === 'folder_merge_conflict') {
        const choice = await chooseMerge(e.message)
        if (choice === 'cancel') return
        try { await api.operate('move', operationIds, destinationId, undefined, choice === 'replace', choice === 'merge') } catch (retryError) { setError(messageOf(retryError)); return }
      } else if (e instanceof ApiFailure && e.code === 'already_exists' && await confirmAction(`${e.message}. Replace it and move the old item to Trash?`, { title: 'Replace existing item?', confirmLabel: 'Replace', danger: true })) {
        try { await api.operate(clipboard.operation, operationIds, destinationId, undefined, true) } catch (retryError) { setError(messageOf(retryError)); return }
      } else { setError(messageOf(e)); return }
    }
    if (clipboard.operation === 'move') {
      const moved = new Set(operationIds)
      setClipboard(null)
      setSelected(ids => new Set(Array.from(ids).filter(id => !moved.has(id))))
      setPrimary(entry => entry && moved.has(entry.id) ? null : entry)
    }
    await Promise.all(Array.from(new Set([...sourceParents, destinationId])).map(id => refresh(id)))
  }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const action = clipboardShortcut(event)
      if (!action || ignoresFileClipboardShortcut(event.target) || editor || viewer || trash || properties) return
      if (action === 'paste') {
        if (!clipboard) return
        event.preventDefault(); void paste()
      } else {
        if (!selected.size) return
        event.preventDefault(); stageClipboard(action)
      }
    }
    addEventListener('keydown', keyboard)
    return () => removeEventListener('keydown', keyboard)
  }, [clipboard, currentDir, editor, expanded, properties, root, selected, trash, viewer])
  const moveByDrag = async (ids: string[], destinationId: string, requireConfirmation = false) => {
    const movableIds = ids.filter(id => findEntry(id, root, expanded)?.parentId !== destinationId)
    if (!movableIds.length) return false
    const destination = findEntry(destinationId, root, expanded)
    if (destination && movableIds.some(id => {
      const source = findEntry(id, root, expanded)
      return source?.kind === 'directory' && destination.path.startsWith(`${source.path}/`)
    })) { setError('A directory cannot be moved inside itself.'); return false }
    const currentDirectory = currentDir ? findEntry(currentDir, root, expanded) : undefined
    const confirmMove = requireConfirmation && !isAdjacentColumnMove(
      destinationId,
      destination?.parentId,
      currentDir,
      currentDirectory?.parentId,
    )
    if (confirmMove) {
      const names = movableIds.map(id => findEntry(id, root, expanded)?.name ?? id)
      const confirmed = await confirmAction(moveConfirmationMessage(names, destination?.path ?? '/fs-root'), {
        title: movableIds.length === 1 ? 'Move item?' : 'Move selected items?',
        confirmLabel: 'Move',
      })
      if (!confirmed) return false
    }
    const sourceParents = new Set(movableIds.map(id => findEntry(id, root, expanded)?.parentId ?? ''))
    const perform = (replace = false, merge = false) => api.operate('move', movableIds, destinationId, undefined, replace, merge)
    setError('')
    try {
      await perform()
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'folder_merge_conflict') {
        const choice = await chooseMerge(e.message)
        if (choice === 'cancel') return false
        try { await perform(choice === 'replace', choice === 'merge') } catch (retryError) { setError(messageOf(retryError)); return false }
      } else {
        if (!(e instanceof ApiFailure) || e.code !== 'already_exists' ||
            !await confirmAction(`${e.message}. Replace it and move the old item to Trash?`, { title: 'Replace existing item?', confirmLabel: 'Replace', danger: true })) {
          setError(messageOf(e)); return false
        }
        try { await perform(true) } catch (retryError) { setError(messageOf(retryError)); return false }
      }
    }
    const pathIndex = columnPath.findIndex(entry => movableIds.includes(entry.id))
    if (pathIndex >= 0) { setColumnPath(previous => previous.slice(0, pathIndex)); setCurrentDir(columnPath[pathIndex]?.parentId ?? '') }
    setSelected(new Set()); setPrimary(null)
    await Promise.all(Array.from(new Set([...sourceParents, destinationId])).map(id => refresh(id)))
    return true
  }
  const openTrash = async () => { try { setTrash(await api.listTrash()) } catch (e) { setError(messageOf(e)) } }
  const logout = async () => { try { await api.logout() } finally { onLogout() } }

  useEffect(() => {
    if (!drawerOpen) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrawerOpen(false) }
    addEventListener('keydown', escape)
    return () => removeEventListener('keydown', escape)
  }, [drawerOpen])
  useEffect(() => { if (!isMobile) { setDrawerOpen(false); setMobileSelecting(false) } }, [isMobile])
  useEffect(() => { if (!isMobile || !selected.size) setMobileSelectionMenu(false) }, [isMobile, selected.size])

  const activePage = currentDir === '' ? root : expanded[currentDir]
  const gridRows = (activePage?.entries ?? []).filter(entry => entry.name.toLowerCase().includes(filter.toLowerCase())).map(entry => ({ entry, depth: 0 }))
  const visibleCount = gridRows.length
  const cutIds = new Set(clipboard?.operation === 'move' ? clipboard.ids : [])
  const previewEntries = Array.from(selected).map(id => findEntry(id, root, expanded)).filter((entry): entry is Entry => Boolean(entry))
  const viewerImages = viewer?.type === 'image'
    ? ((viewer.entry.parentId === '' ? root : expanded[viewer.entry.parentId])?.entries.filter(entry => entry.mime.startsWith('image/')) ?? [viewer.entry])
    : []
  const toggleTerminal = () => setTerminal(current => current ? { ...current, hidden: !current.hidden } : { directoryId: currentDir, hidden: false })
  const goToRoot = () => { setCurrentDir(''); setSelected(new Set()); setPrimary(null); setColumnPath([]); setMobileSelecting(false) }
  const goToParent = () => {
    const parentPath = columnPath.slice(0, -1)
    const parent = parentPath.at(-1)
    setCurrentDir(parent?.id ?? ''); setSelected(new Set()); setPrimary(null); setColumnPath(parentPath); setMobileSelecting(false)
  }
  const openCurrentFolderMenu = () => setFolderMenu({ directoryId: currentDir, path: columnPath.at(-1)?.path ?? '/fs-root', x: innerWidth - 12, y: 80 })
  const mobileSelectionEntry = primary && selected.has(primary.id) ? primary : previewEntries[0]
  return <div className={`app-shell ${isMobile ? 'mobile-mode' : ''}`}>
    <header className="topbar">
      {isMobile && <button className="icon-button mobile-menu-button" title="Open navigation" aria-label="Open navigation" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}><Menu size={20} /></button>}
      <div className="brand"><FolderOpen size={20} /><strong>Remote Files</strong><span>/fs-root</span></div>
      <div className="search"><Search size={16} /><input placeholder="Filter visible files" value={filter} onChange={e => setFilter(e.target.value)} />{filter && <button type="button" className="search-clear" title="Clear file filter" aria-label="Clear file filter" onClick={() => setFilter('')}><X /></button>}</div>
      {!isMobile && session.terminalEnabled && <button className={`icon-button ${terminal && !terminal.hidden ? 'active' : ''}`} title={terminal && !terminal.hidden ? 'Hide terminal' : 'Show terminal'} aria-label={terminal && !terminal.hidden ? 'Hide terminal' : 'Show terminal'} aria-pressed={Boolean(terminal && !terminal.hidden)} onClick={toggleTerminal}><SquareTerminal size={18} /></button>}
      {!isMobile && <button className="icon-button" title="Sign out" onClick={logout}><LogOut size={18} /></button>}
    </header>
    <div className="workspace">
      {isMobile && drawerOpen && <div className="drawer-backdrop" role="presentation" onPointerDown={() => setDrawerOpen(false)} />}
      <aside className={`navigation-sidebar ${drawerOpen ? 'open' : ''}`} role={isMobile ? 'dialog' : undefined} aria-modal={isMobile && drawerOpen ? true : undefined} aria-hidden={isMobile && !drawerOpen ? true : undefined} aria-label="Navigation">
        <div className="drawer-heading"><strong>Remote Files</strong><button key={drawerOpen ? 'drawer-open' : 'drawer-closed'} className="icon-button" aria-label="Close navigation" autoFocus={isMobile && drawerOpen} onClick={() => setDrawerOpen(false)}><X /></button></div>
        <button className="nav-item active" onClick={() => { goToRoot(); setDrawerOpen(false) }}><Folder size={17} /> Files</button>
        <button className="nav-item" onClick={() => { void openTrash(); setDrawerOpen(false) }}><Trash2 size={17} /> Trash</button>
        {session.terminalEnabled && <button className={`nav-item ${terminal && !terminal.hidden ? 'active' : ''}`} aria-pressed={Boolean(terminal && !terminal.hidden)} onClick={() => { toggleTerminal(); setDrawerOpen(false) }}><SquareTerminal size={17} /> Terminal</button>}
        <ConversionJobs />
        <div className="aside-note"><span>Signed in as</span><strong>{session.username}</strong>{isMobile && <button onClick={() => void logout()}><LogOut /> Sign out</button>}</div>
      </aside>
      <div className="content-stack">
        <main className={`browser ${view === 'details' ? 'column-view' : ''}`}>
        {isMobile ? <div className={`toolbar mobile-toolbar ${selected.size ? 'selection-toolbar' : ''}`}>
          {mobileSelecting ? <>
            <button title="Finish selecting" onClick={() => { setMobileSelecting(false); setSelected(new Set()); setPrimary(null) }}><Check /><span>Done</span></button>
            <strong className="selection-count">{selected.size} selected</strong>
            <span className="toolbar-spacer" />
            <button disabled={!selected.size} title="Selected item actions" aria-label="Selected item actions" onClick={() => setMobileSelectionMenu(true)}><MoreHorizontal /><span>Actions</span></button>
          </> : <>
            <button title="Upload files" onClick={() => inputRef.current?.click()}><Upload /><span>Upload</span></button>
            <span className="toolbar-spacer" />
            <button title="Select files" onClick={() => { setSelected(new Set()); setPrimary(null); setMobileSelecting(true) }}><Check /><span>Select</span></button>
            <button title="Folder actions" aria-label="Folder actions" onClick={openCurrentFolderMenu}><MoreHorizontal /><span>Actions</span></button>
          </>}
          <input ref={inputRef} type="file" multiple hidden onChange={e => e.target.files && mutate(() => api.upload(currentDir, e.target.files!), currentDir, () => api.upload(currentDir, e.target.files!, true))} />
        </div> : <div className="toolbar">
          <button onClick={() => createItem('directory')}><Plus size={16} /> Folder</button>
          <button onClick={() => createItem('file')}><File size={16} /> File</button>
          <button onClick={() => inputRef.current?.click()}><Upload size={16} /> Upload</button>
          <input ref={inputRef} type="file" multiple hidden onChange={e => e.target.files && mutate(() => api.upload(currentDir, e.target.files!), currentDir, () => api.upload(currentDir, e.target.files!, true))} />
          <span className="divider" />
          <button disabled={!selected.size} title="Copy (Ctrl/Cmd+C)" onClick={() => stageClipboard('copy')}><Copy size={16} /> Copy</button>
          <button disabled={!selected.size} title="Cut (Ctrl/Cmd+X)" onClick={() => stageClipboard('move')}><Scissors size={16} /> Cut</button>
          <button disabled={!clipboard} title="Paste (Ctrl/Cmd+V)" onClick={() => void paste()}><ClipboardPaste size={16} /> Paste</button>
          <button disabled={selected.size !== 1} onClick={() => void rename()}><Edit3 size={16} /> Rename</button>
          <button disabled={!selected.size} onClick={deleteSelected}><Trash2 size={16} /> Delete</button>
          <div className="toolbar-spacer" />
          <label className="hidden-toggle"><input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} /> Hidden</label>
          <button className="icon-button" title="Refresh" onClick={() => refresh()}><RefreshCw size={16} /></button>
          <button className={`icon-button ${showPreview ? 'active' : ''}`} title={`${showPreview ? 'Hide' : 'Show'} preview`} aria-pressed={showPreview} onClick={() => setShowPreview(value => !value)}><Eye size={16} /></button>
          <ViewSelector view={view} setView={setView} />
        </div>}
        <div className="location">{isMobile && <button className="mobile-back" disabled={!columnPath.length} title="Parent folder" aria-label="Go to parent folder" onClick={goToParent}><ChevronLeft /></button>}<nav className="breadcrumbs" aria-label="Current directory"><button onClick={goToRoot}>fs-root</button>{columnPath.map((entry, index) => <span key={entry.id}><ChevronRight /><button onClick={() => { setCurrentDir(entry.id); setSelected(new Set()); setPrimary(null); setColumnPath(previous => previous.slice(0, index + 1)) }}>{entry.name}</button></span>)}</nav><span>{visibleCount} visible</span></div>
        {error && <div className="banner error"><span>{error}</span><button onClick={() => setError('')}><X size={15} /></button></div>}
        <div className="browser-body"><div className="browser-view" onContextMenu={view === 'details' ? undefined : event => showFolderMenu(event, currentDir, columnPath.at(-1)?.path ?? '/fs-root')}>
          {!root ? <div className="center"><span className="spinner" /></div> : isMobile ?
            !activePage ? <div className="center"><span className="spinner" /></div> : <MobileDirectoryList rows={gridRows} selecting={mobileSelecting} canNavigateUp={Boolean(columnPath.length)} selected={selected} cutIds={cutIds} setSelected={setSelected} setPrimary={setPrimary} navigateUp={goToParent} activate={entry => { setMobileSelecting(false); activate(entry) }} renameEntry={rename} deleteEntry={deleteEntry} stageClipboard={stageClipboard} pasteInto={entry => paste(entry.id, entry.path)} hasClipboard={Boolean(clipboard)} showProperties={entry => showProperties(entry.id, entry)} concatenateVideos={concatenateVideos} setError={setError} /> : view === 'details' ?
            <ColumnBrowser root={root} path={columnPath} pages={expanded} filter={filter} selected={selected} cutIds={cutIds} primary={primary} defaultColumnWidth={defaultColumnWidth} columnWidths={columnWidths} setColumnWidth={(key, width) => setColumnWidths(previous => ({ ...previous, [key]: width }))} navigate={navigateColumn} loadDirectory={loadDirectory} selectItems={selectColumnItems} selectDragItems={(ids, entry) => { setSelected(ids); setPrimary(entry) }} selectParent={selectParentColumn} activate={activate} renameEntry={rename} moveEntries={moveByDrag} deleteEntry={deleteEntry} stageClipboard={stageClipboard} pasteInto={entry => paste(entry.id, entry.path)} hasClipboard={Boolean(clipboard)} showFolderMenu={showFolderMenu} showProperties={entry => showProperties(entry.id, entry)} concatenateVideos={concatenateVideos} setError={setError} /> :
            !activePage ? <div className="center"><span className="spinner" /></div> : gridRows.length === 0 ? <Empty /> : <FileList rows={gridRows} view={view} selected={selected} cutIds={cutIds} setSelected={setSelected} setPrimary={setPrimary} activate={activate} renameEntry={rename} moveEntries={moveByDrag} deleteEntry={deleteEntry} stageClipboard={stageClipboard} pasteInto={entry => paste(entry.id, entry.path)} hasClipboard={Boolean(clipboard)} showProperties={entry => showProperties(entry.id, entry)} concatenateVideos={concatenateVideos} setError={setError} />}
        </div>{!isMobile && showPreview && <ColumnPreview entries={previewEntries} primary={primary} />}</div>
        </main>
        {terminal && <TerminalDock directoryId={terminal.directoryId} hidden={terminal.hidden} onHide={() => setTerminal(current => current && ({ ...current, hidden: true }))} onClose={() => setTerminal(null)} />}
      </div>
    </div>
    {editor && <EditorWindow key={editor.document.id} document={editor.document} entry={editor.entry} onOpenFile={activateMarkdownLink} onDirtyChange={setEditorDirty} onClose={() => { documentRequest.current++; setEditor(null); setEditorDirty(false) }} onSaved={saved => setEditor(current => current?.document.id === saved.id ? { ...current, document: saved } : current)} />}
    {viewer && <ViewerWindow {...viewer} images={viewerImages} onNavigate={entry => {
      setViewer({ entry, type: 'image' }); setSelected(new Set([entry.id])); setPrimary(entry)
    }} onMarkupSaved={async entry => {
      await refresh(entry.parentId)
      setViewer({ entry, type: 'image' }); setSelected(new Set([entry.id])); setPrimary(entry)
    }} onClose={() => setViewer(null)} />}
    {trash && <TrashWindow items={trash} onClose={() => setTrash(null)} onChanged={async () => setTrash(await api.listTrash())} onRestored={entry => refresh(entry.parentId)} setError={setError} />}
    {folderMenu && <FolderContextMenu {...folderMenu} close={() => setFolderMenu(null)} createItem={createItem} paste={() => paste(folderMenu.directoryId, folderMenu.path)} hasClipboard={Boolean(clipboard)} showProperties={id => showProperties(id)} setError={setError} mobileControls={isMobile ? { hidden, toggleHidden: () => setHidden(value => !value), refresh: () => refresh(folderMenu.directoryId) } : undefined} />}
    {isMobile && mobileSelectionMenu && mobileSelectionEntry && <ContextMenu entry={mobileSelectionEntry} selectedEntries={previewEntries} x={innerWidth - 12} y={80} close={() => setMobileSelectionMenu(false)} open={() => activate(mobileSelectionEntry)} renameEntry={rename} deleteEntry={deleteEntry} stageClipboard={stageClipboard} pasteInto={entry => paste(entry.id, entry.path)} hasClipboard={Boolean(clipboard)} showProperties={entry => showProperties(entry.id, entry)} concatenateVideos={concatenateVideos} setError={setError} />}
    {properties && <PropertiesDialog {...properties} onClose={() => setProperties(null)} />}
    <div id="window-tray" className="window-tray" role="region" aria-label="Minimized windows" />
  </div>
}

function ConversionJobs() {
  const [jobs, setJobs] = useState<ConversionJob[]>([])
  const [extractions, setExtractions] = useState<ExtractionJob[]>([])
  const [concatenations, setConcatenations] = useState<ConcatenationJob[]>([])
  const [cleaning, setCleaning] = useState(false)
  const [cleanupReport, setCleanupReport] = useState<CacheCleanupReport>()
  const [cleanupError, setCleanupError] = useState('')
  const playableJobs = useRef<Record<string, boolean>>({})
  useEffect(() => {
    let active = true
    let liveRevision = 0
    let refreshRevision = 0
    const refresh = () => {
      const request = ++refreshRevision
      const revision = liveRevision
      return Promise.all([api.conversionJobs(), api.extractionJobs(), api.concatenationJobs()]).then(([nextJobs, nextExtractions, nextConcatenations]) => {
        if (active && request === refreshRevision && revision === liveRevision) {
          const becamePlayable = nextJobs.some(job => job.playable && !playableJobs.current[job.key])
          playableJobs.current = Object.fromEntries(nextJobs.map(job => [job.key, job.playable]))
          setJobs(nextJobs); setExtractions(nextExtractions); setConcatenations(nextConcatenations)
          if (becamePlayable) dispatchEvent(new Event('rfb:video-ready'))
        }
      }).catch(() => {})
    }
    const live = (message: Event) => {
      liveRevision += 1
      const event = (message as CustomEvent<LiveEvent>).detail
      if (event.type === 'mediaSnapshot') {
        const becamePlayable = event.jobs.some(job => job.playable && !playableJobs.current[job.key])
        playableJobs.current = Object.fromEntries(event.jobs.map(job => [job.key, job.playable]))
        setJobs(event.jobs); setExtractions(event.extractions); setConcatenations(jobsFromSnapshot(event.concatenations))
        if (becamePlayable) dispatchEvent(new Event('rfb:video-ready'))
      } else if (event.type === 'mediaJob') {
        const becamePlayable = event.job.playable && !playableJobs.current[event.job.key]
        playableJobs.current[event.job.key] = event.job.playable
        setJobs(previous => upsertJob(previous, event.job))
        if (becamePlayable) dispatchEvent(new Event('rfb:video-ready'))
      } else if (event.type === 'extractionJob') {
        setExtractions(previous => upsertJob(previous, event.job))
      } else if (event.type === 'concatenationJob') {
        setConcatenations(previous => upsertJob(previous, event.job))
      } else if (event.type === 'cacheCleanup') {
        setCleaning(event.state === 'started')
        if (event.report) { setCleanupReport(event.report); setCleanupError('') }
        if (event.error) setCleanupError(event.error)
      }
    }
    const resync = () => void refresh()
    addEventListener('rfb:media-live', live); addEventListener('rfb:media-resync', resync); void refresh()
    const reconciliationTimer = window.setInterval(refresh, 15000)
    return () => { active = false; window.clearInterval(reconciliationTimer); removeEventListener('rfb:media-live', live); removeEventListener('rfb:media-resync', resync) }
  }, [])
  const cleanup = async () => {
    setCleaning(true); setCleanupError(''); setCleanupReport(undefined)
    try { setCleanupReport(await api.cleanupCache()) }
    catch (error) { setCleanupError(messageOf(error)) }
    finally { setCleaning(false) }
  }
  const working = cleaning || jobs.some(job => job.status === 'working') || extractions.some(job => job.status === 'working') || concatenations.some(job => job.status === 'working')
  const progressLabel = (progress: number | null) => `${progressPercent(progress)}%`
  return <div className="conversion-jobs" aria-label="Media jobs">
    <div className="conversion-jobs-heading"><Film /> <span>Media jobs</span>{working && <span className="conversion-pulse" title="Media work in progress" />}<button className="cache-cleanup" disabled={cleaning} title="Reconcile and clean stale media cache" aria-label="Clean stale media cache" onClick={() => void cleanup()}><RefreshCw /></button></div>
    <div className="conversion-job-list">
      {jobs.length === 0 && extractions.length === 0 && concatenations.length === 0 ? <p>No media jobs yet.</p> : <>{concatenations.map(job => <div className={`conversion-job ${job.status}`} key={`concat-${job.key}`} title={job.fileName}>
        <span className="conversion-status" aria-label={job.status} />
        <div><strong>{job.result?.name ?? job.fileName}</strong><small>{job.status === 'failed' ? job.error ?? 'Concatenation failed' : `Concatenating videos${job.status === 'ready' ? ' complete' : ` · ${progressLabel(job.progress)}`}`}</small>{job.status === 'working' && <progress max={1} value={job.progress ?? 0} aria-label={`Concatenation ${progressLabel(job.progress)}`} />}</div>
      </div>)}{extractions.map(job => <div className={`conversion-job ${job.status}`} key={`extract-${job.key}`} title={job.fileName}>
        <span className="conversion-status" aria-label={job.status} />
        <div><strong>{job.result?.name ?? job.fileName}</strong><small>{job.status === 'failed' ? job.error ?? 'Extraction failed' : `${job.kind === 'frame' ? 'Frame extraction' : 'Clip extraction'}${job.status === 'ready' ? ' complete' : job.progress === null ? '…' : ` · ${progressLabel(job.progress)}`}`}</small>{job.status === 'working' && job.progress !== null && <progress max={1} value={job.progress} aria-label={`Clip extraction ${progressLabel(job.progress)}`} />}</div>
      </div>)}{jobs.map(job => <div className={`conversion-job ${job.status}`} key={job.key} title={job.fileName}>
        <span className="conversion-status" aria-label={job.status} />
        <div><strong>{job.fileName}</strong><small>{job.status === 'failed' ? 'Conversion failed' : `${job.mode === 'remux' ? 'Remuxing' : job.mode === 'audio' ? 'Converting audio' : 'Converting video'}${job.status === 'ready' ? ' complete' : ` · ${progressLabel(job.progress ?? 0)}${job.playable ? ' · playing' : ''}`}`}</small>{job.status === 'working' && <progress max={1} value={job.progress ?? 0} aria-label={`Conversion ${progressLabel(job.progress ?? 0)}`} />}</div>
      </div>)}</>}
      {cleanupReport && <p className="cache-cleanup-result">Removed {cleanupReport.artifactsRemoved} item{cleanupReport.artifactsRemoved === 1 ? '' : 's'} · {formatBytes(cleanupReport.bytesReclaimed)}</p>}
      {cleanupError && <p className="provenance-error">{cleanupError}</p>}
    </div>
  </div>
}

type BrowserColumn = { directoryId: string; page?: EntryPage; label: string }
function ColumnBrowser({ root, path, pages, filter, selected, cutIds, primary, defaultColumnWidth, columnWidths, setColumnWidth, navigate, loadDirectory, selectItems, selectDragItems, selectParent, activate, renameEntry, moveEntries, deleteEntry, stageClipboard, pasteInto, hasClipboard, showFolderMenu, showProperties, concatenateVideos, setError }: {
  root: EntryPage; path: Entry[]; pages: Record<string, EntryPage>; filter: string; selected: Set<string>; cutIds: Set<string>; primary: Entry | null
  defaultColumnWidth: number; columnWidths: Record<string, number>; setColumnWidth: (key: string, width: number) => void
  navigate: (entry: Entry, columnIndex: number) => Promise<void>; loadDirectory: (entry: Entry) => Promise<boolean>
  selectItems: (ids: Set<string>, primary: Entry | null, columnIndex: number, directoryId: string, preserveCurrentBranch?: boolean) => void
  selectDragItems: (ids: Set<string>, primary: Entry | null) => void; selectParent: (columnIndex: number) => void
  activate: (entry: Entry) => void; renameEntry: (entry: Entry) => Promise<void>; moveEntries: (ids: string[], destinationId: string, requireConfirmation?: boolean) => Promise<boolean>
  stageClipboard: (operation: ClipboardOperation, entry: Entry) => void; pasteInto: (entry: Entry) => Promise<void>; hasClipboard: boolean
  deleteEntry: (entry: Entry) => Promise<void>; showFolderMenu: (event: React.MouseEvent, directoryId: string, path: string) => void
  showProperties: (entry: Entry) => void; concatenateVideos: (entries: Entry[]) => Promise<void>; setError: (message: string) => void
}) {
  const [dragPath, setDragPath] = useState<Entry[] | null>(null)
  const visiblePath = dragPath ?? path
  const columns: BrowserColumn[] = [{ directoryId: '', page: root, label: 'fs-root' }, ...visiblePath.map(entry => ({ directoryId: entry.id, page: pages[entry.id], label: entry.name }))]
  const [activeColumn, setActiveColumn] = useState(0)
  const [menu, setMenu] = useState<{ entry: Entry; columnIndex: number; x: number; y: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const anchor = useRef<{ column: number; index: number } | null>(null)
  const draggedIds = useRef<string[]>([])
  const dragOrigin = useRef<{ selected: Set<string>; primary: Entry | null } | null>(null)
  const didDrop = useRef(false)
  const dragSession = useRef(0)
  const hoverTarget = useRef<string | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const edgeDirection = useRef<-1 | 0 | 1>(0)
  const edgeFrame = useRef<number | undefined>(undefined)
  const scroller = useRef<HTMLDivElement>(null)
  const columnRefs = useRef<Array<HTMLDivElement | null>>([])
  const cancelSpringOpen = (targetId?: string) => {
    if (targetId && hoverTarget.current !== targetId) return
    clearTimeout(hoverTimer.current); hoverTimer.current = undefined; hoverTarget.current = null
  }
  const setEdgeScroll = (direction: -1 | 0 | 1) => {
    if (edgeDirection.current === direction) return
    edgeDirection.current = direction
    if (!direction) {
      if (edgeFrame.current !== undefined) cancelAnimationFrame(edgeFrame.current)
      edgeFrame.current = undefined
      return
    }
    if (edgeFrame.current !== undefined) return
    const scroll = () => {
      if (!edgeDirection.current) { edgeFrame.current = undefined; return }
      if (scroller.current) scroller.current.scrollLeft += edgeDirection.current * 12
      edgeFrame.current = requestAnimationFrame(scroll)
    }
    edgeFrame.current = requestAnimationFrame(scroll)
  }
  const resetDragVisuals = () => {
    dragSession.current += 1; cancelSpringOpen(); setEdgeScroll(0); setDropTarget(null); setDragPath(null)
  }
  useEffect(() => {
    setActiveColumn(Math.min(visiblePath.length, columns.length - 1))
    requestAnimationFrame(() => scroller.current?.scrollTo({ left: scroller.current.scrollWidth, behavior: 'smooth' }))
  }, [visiblePath.length])
  useEffect(() => () => {
    clearTimeout(hoverTimer.current)
    if (edgeFrame.current !== undefined) cancelAnimationFrame(edgeFrame.current)
  }, [])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    addEventListener('pointerdown', close); addEventListener('keydown', escape)
    return () => { removeEventListener('pointerdown', close); removeEventListener('keydown', escape) }
  }, [menu])
  const visibleEntries = (column: BrowserColumn) => (column.page?.entries ?? []).filter(entry => entry.name.toLowerCase().includes(filter.toLowerCase()))
  const choose = (entry: Entry, columnIndex: number, entryIndex: number, event?: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>, preserveCurrentBranch = false) => {
    const entries = visibleEntries(columns[columnIndex])
    setActiveColumn(columnIndex)
    if (event?.shiftKey && anchor.current?.column === columnIndex) {
      const start = Math.min(anchor.current.index, entryIndex), end = Math.max(anchor.current.index, entryIndex)
      selectItems(new Set(entries.slice(start, end + 1).map(item => item.id)), entry, columnIndex, columns[columnIndex].directoryId, preserveCurrentBranch)
      return
    }
    if (event?.metaKey || event?.ctrlKey) {
      const next = activeColumn === columnIndex ? new Set(selected) : new Set<string>()
      next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id)
      anchor.current = { column: columnIndex, index: entryIndex }
      selectItems(next, next.has(entry.id) ? entry : null, columnIndex, columns[columnIndex].directoryId, preserveCurrentBranch)
      return
    }
    anchor.current = { column: columnIndex, index: entryIndex }
    selectItems(new Set([entry.id]), entry, columnIndex, columns[columnIndex].directoryId, preserveCurrentBranch)
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
  const startResize = (event: React.PointerEvent, key: string, width: number) => {
    event.preventDefault(); event.stopPropagation(); const startX = event.clientX, startWidth = width
    const move = (pointer: PointerEvent) => setColumnWidth(key, Math.min(480, Math.max(180, startWidth + pointer.clientX - startX)))
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up) }
    addEventListener('pointermove', move); addEventListener('pointerup', up)
  }
  const startDrag = (event: React.DragEvent, entry: Entry) => {
    const ids = selected.has(entry.id) ? Array.from(selected) : [entry.id]
    dragSession.current += 1; draggedIds.current = ids; didDrop.current = false
    dragOrigin.current = { selected: new Set(selected), primary }
    setDragPath(path)
    if (!selected.has(entry.id)) selectDragItems(new Set([entry.id]), entry)
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-remote-file-browser', ids.join(',')); event.dataTransfer.setData('text/plain', entry.name)
  }
  const endDrag = () => {
    const origin = dragOrigin.current
    const restoreSelection = !didDrop.current && origin
    draggedIds.current = []; resetDragVisuals()
    if (restoreSelection) { selectDragItems(origin.selected, origin.primary); dragOrigin.current = null }
  }
  const acceptDrop = (event: React.DragEvent, id: string) => {
    if (!draggedIds.current.length || draggedIds.current.includes(id)) return false
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropTarget(id || '__root__'); return true
  }
  const scheduleSpringOpen = (entry: Entry, columnIndex: number) => {
    if (visiblePath[columnIndex]?.id === entry.id) { cancelSpringOpen(); return }
    if (hoverTarget.current === entry.id) return
    cancelSpringOpen(); hoverTarget.current = entry.id
    const session = dragSession.current
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = undefined
      if (session !== dragSession.current || hoverTarget.current !== entry.id) return
      setDragPath(current => springLoadedPath(current ?? path, entry, columnIndex))
      void loadDirectory(entry).then(loaded => {
        if (!loaded && session === dragSession.current) {
          setDragPath(current => current?.[columnIndex]?.id === entry.id ? current.slice(0, columnIndex) : current)
        }
      })
    }, 600)
  }
  const drop = (event: React.DragEvent, id: string) => {
    if (!acceptDrop(event, id)) return
    const ids = draggedIds.current
    const origin = dragOrigin.current
    didDrop.current = true; draggedIds.current = []; resetDragVisuals()
    void moveEntries(ids, id, true).then(moved => {
      if (!moved && origin) selectDragItems(origin.selected, origin.primary)
      dragOrigin.current = null
    })
  }
  const trackEdgeScroll = (event: React.DragEvent) => {
    if (!draggedIds.current.length || !scroller.current) return
    const bounds = scroller.current.getBoundingClientRect()
    setEdgeScroll(event.clientX < bounds.left + 48 ? -1 : event.clientX > bounds.right - 48 ? 1 : 0)
  }
  return <div className="column-browser" ref={scroller} onDragOverCapture={trackEdgeScroll} onDragLeave={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { cancelSpringOpen(); setEdgeScroll(0); setDropTarget(null) }
  }}>
    {columns.map((column, columnIndex) => {
      const entries = visibleEntries(column), targetKey = column.directoryId || '__root__', branchId = visiblePath[columnIndex]?.id
      const width = Math.min(480, Math.max(180, columnWidths[targetKey] || defaultColumnWidth))
      return <div className={`finder-column ${activeColumn === columnIndex ? 'active' : ''} ${dropTarget === targetKey ? 'drop-target' : ''}`} style={{ '--column-width': `${width}px` } as React.CSSProperties} key={targetKey} ref={node => { columnRefs.current[columnIndex] = node }} tabIndex={0} role="listbox" aria-label={column.label} aria-multiselectable="true" onFocus={() => setActiveColumn(columnIndex)} onKeyDown={event => keyboard(event, columnIndex)} onContextMenu={event => showFolderMenu(event, column.directoryId, columnIndex === 0 ? '/fs-root' : visiblePath[columnIndex - 1].path)} onDragOver={event => { cancelSpringOpen(); acceptDrop(event, column.directoryId) }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) }} onDrop={event => drop(event, column.directoryId)}>
        {!column.page ? <div className="column-state"><span className="spinner" /></div> : entries.length === 0 ? <div className="column-state">{filter ? 'No matches' : 'Empty folder'}</div> : entries.map((entry, entryIndex) => <div className={`column-row ${selected.has(entry.id) ? 'selected' : branchId === entry.id ? 'branch-selected' : ''} ${cutIds.has(entry.id) ? 'cut' : ''} ${dropTarget === entry.id ? 'drop-target' : ''}`} key={entry.id} role="option" aria-selected={selected.has(entry.id)} aria-current={branchId === entry.id ? 'location' : undefined} draggable onDragStart={event => startDrag(event, entry)} onDragEnd={endDrag} onClick={event => choose(entry, columnIndex, entryIndex, event, true)} onDoubleClick={() => entry.kind === 'directory' ? void navigate(entry, columnIndex) : activate(entry)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu({ entry, columnIndex, x: event.clientX, y: event.clientY }) }} onDragOver={event => { if (entry.kind === 'directory' && acceptDrop(event, entry.id)) scheduleSpringOpen(entry, columnIndex) }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { cancelSpringOpen(entry.id); setDropTarget(current => current === entry.id ? null : current) } }} onDrop={event => { if (entry.kind === 'directory') drop(event, entry.id) }}>
          <FileGlyph entry={entry} /><span title={entry.name}>{entry.name}</span>{entry.kind === 'directory' && <ChevronRight className="column-arrow" />}
        </div>)}
        <div className="column-resizer" role="separator" aria-orientation="vertical" aria-label={`Resize ${column.label} column`} title="Resize column" onPointerDown={event => startResize(event, targetKey, width)} />
      </div>
    })}
    {menu && <ContextMenu entry={menu.entry} selectedEntries={(columns[menu.columnIndex].page?.entries ?? []).filter(entry => selected.has(entry.id))} x={menu.x} y={menu.y} close={() => setMenu(null)} open={() => menu.entry.kind === 'directory' ? void navigate(menu.entry, menu.columnIndex) : activate(menu.entry)} renameEntry={renameEntry} deleteEntry={deleteEntry} stageClipboard={stageClipboard} pasteInto={pasteInto} hasClipboard={hasClipboard} showProperties={showProperties} concatenateVideos={concatenateVideos} setError={setError} />}
  </div>
}

function ColumnPreview({ entries, primary }: { entries: Entry[]; primary: Entry | null }) {
  if (!entries.length) return <aside className="column-preview"><div className="preview-placeholder"><Eye /><span>Select an item to preview</span></div></aside>
  if (entries.length > 1) return <aside className="column-preview"><div className="preview-hero"><File className="preview-glyph" /><strong>{entries.length} items</strong><span>{formatBytes(entries.reduce((sum, entry) => sum + entry.size, 0))}</span></div></aside>
  const entry = primary && entries.some(item => item.id === primary.id) ? primary : entries[0]
  return <aside className="column-preview">
    <div className="preview-hero">
      {entry.mime.startsWith('image/') ? <img src={thumbnailUrl(entry.id, 'large', entry.etag)} alt="" /> : entry.mime.startsWith('video/') ? <VideoPlayer key={`${entry.id}:${entry.etag}`} entry={entry} autoPlay={false} /> : entry.mime.startsWith('audio/') ? <audio key={`${entry.id}:${entry.etag}`} src={mediaUrl(entry.id, entry.etag)} controls preload="metadata" /> : <FileGlyph entry={entry} />}
      <strong title={entry.name}>{entry.name}</strong><span>{entry.kind === 'directory' ? 'Folder' : entry.mime}</span>
    </div>
    <dl className="preview-metadata"><dt>Size</dt><dd>{formatBytes(entry.size)}</dd><dt>Permissions</dt><dd><code>{entry.permissions} {entry.mode.toString(8)}</code></dd><dt>Owner</dt><dd>{entry.uid}:{entry.gid}</dd><dt>Modified</dt><dd>{formatDate(entry.modifiedAt)}</dd><dt>Created</dt><dd>{formatDate(entry.createdAt)}</dd><dt>Accessed</dt><dd>{formatDate(entry.accessedAt)}</dd></dl>
    {entry.kind === 'file' && <ProvenanceEditor key={entry.id} entry={entry} />}
  </aside>
}

function ProvenanceEditor({ entry }: { entry: Entry }) {
  const promptAction = usePrompt()
  const [urls, setUrls] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const load = () => api.provenance(entry.id).then(data => setUrls(data.urls)).catch(e => setError(messageOf(e)))
    setUrls(null); setError(''); void load()
    const changed = (event: Event) => {
      const change = (event as CustomEvent<ProvenanceChange>).detail
      if (change.id === entry.id) { setUrls(change.urls); setError('') }
    }
    addEventListener('rfb:provenance-changed', changed)
    addEventListener('rfb:provenance-resync', load)
    return () => { removeEventListener('rfb:provenance-changed', changed); removeEventListener('rfb:provenance-resync', load) }
  }, [entry.id])
  const add = async () => {
    const url = await promptAction({ title: 'Add provenance URL', label: 'Source URL', submitLabel: 'Add', placeholder: 'https://example.com/source' })
    if (!url || !urls) return
    try { const next = (await api.setProvenance(entry.id, [...urls, url])).urls; setUrls(next); dispatchEvent(new CustomEvent<ProvenanceChange>('rfb:provenance-changed', { detail: { id: entry.id, urls: next } })); setError('') } catch (e) { setError(messageOf(e)) }
  }
  const remove = async (url: string) => {
    if (!urls) return
    try { const next = (await api.setProvenance(entry.id, urls.filter(value => value !== url))).urls; setUrls(next); dispatchEvent(new CustomEvent<ProvenanceChange>('rfb:provenance-changed', { detail: { id: entry.id, urls: next } })); setError('') } catch (e) { setError(messageOf(e)) }
  }
  return <section className="provenance-panel" aria-label="File provenance">
    <div className="provenance-heading"><span><Link2 /> Provenance</span><button className="compact" onClick={() => void add()} disabled={!urls}><Plus /> Add URL</button></div>
    {error && <div className="provenance-error">{error}</div>}
    {urls === null && !error ? <span className="spinner" /> : urls?.length === 0 ? <p>No source URLs recorded.</p> : <ul>{urls?.map(url => <li key={url}><a href={url} target="_blank" rel="noreferrer" title={url}>{url}<ExternalLink /></a><button className="icon-button" title="Remove URL" aria-label={`Remove ${url}`} onClick={() => void remove(url)}><X /></button></li>)}</ul>}
  </section>
}

type Row = { entry: Entry; depth: number }

function FileList({ rows, view, selected, cutIds, setSelected, setPrimary, activate, renameEntry, moveEntries, deleteEntry, stageClipboard, pasteInto, hasClipboard, showProperties, concatenateVideos, setError }: {
  rows: Row[]; view: ViewMode; selected: Set<string>; cutIds: Set<string>; setSelected: (value: Set<string>) => void; setPrimary: (entry: Entry | null) => void
  activate: (entry: Entry) => void; renameEntry: (entry: Entry) => Promise<void>
  moveEntries: (ids: string[], destinationId: string) => Promise<boolean>
  stageClipboard: (operation: ClipboardOperation, entry: Entry) => void; pasteInto: (entry: Entry) => Promise<void>; hasClipboard: boolean
  deleteEntry: (entry: Entry) => Promise<void>; showProperties: (entry: Entry) => void; concatenateVideos: (entries: Entry[]) => Promise<void>; setError: (message: string) => void
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
    setMenu({ entry, x: event.clientX, y: event.clientY })
  }
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
  const contextMenu = menu && <ContextMenu {...menu} selectedEntries={rows.map(row => row.entry).filter(entry => selected.has(entry.id))} close={() => setMenu(null)} open={() => activate(menu.entry)} renameEntry={renameEntry} deleteEntry={deleteEntry} stageClipboard={stageClipboard} pasteInto={pasteInto} hasClipboard={hasClipboard} showProperties={showProperties} concatenateVideos={concatenateVideos} setError={setError} />
  return <div className={`preview-list ${view}`}>
    {rows.map(({ entry, depth }, index) => <div className={`preview-card ${selected.has(entry.id) ? 'selected' : ''} ${cutIds.has(entry.id) ? 'cut' : ''} ${dropTarget === entry.id ? 'drop-target' : ''}`} style={{ marginLeft: depth * 18 }} key={entry.id} onClick={event => selectEntry(entry, index, event)} onDoubleClick={() => activate(entry)} onContextMenu={event => showMenu(event, entry)} {...dragProps(entry)}>
      <button className="card-menu" aria-label={`Actions for ${entry.name}`} onClick={event => showMenu(event, entry)}><MoreHorizontal /></button>
      {entry.kind === 'directory' ? <button className="preview-image folder-preview" tabIndex={-1}><Folder /></button> : entry.mime.startsWith('image/') || (view !== 'small' && entry.mime.startsWith('video/')) ? <button className="preview-image" tabIndex={-1}><img src={thumbnailUrl(entry.id, view, entry.etag)} loading="lazy" />{entry.mime.startsWith('video/') && entry.browserReady && <VideoReadyBadge />}</button> : <button className="preview-image" tabIndex={-1}><FileGlyph entry={entry} /></button>}
      <button className="filename" tabIndex={-1} title={entry.name}>{entry.name}</button>
      {view !== 'small' && <small>{formatBytes(entry.size)}</small>}
    </div>)}
    {contextMenu}
  </div>
}

function MobileDirectoryList({ rows, selecting, canNavigateUp, selected, cutIds, setSelected, setPrimary, navigateUp, activate, renameEntry, deleteEntry, stageClipboard, pasteInto, hasClipboard, showProperties, concatenateVideos, setError }: {
  rows: Row[]; selecting: boolean; canNavigateUp: boolean; selected: Set<string>; cutIds: Set<string>
  setSelected: (value: Set<string>) => void; setPrimary: (entry: Entry | null) => void; navigateUp: () => void; activate: (entry: Entry) => void
  renameEntry: (entry: Entry) => Promise<void>; deleteEntry: (entry: Entry) => Promise<void>; stageClipboard: (operation: ClipboardOperation, entry: Entry) => void
  pasteInto: (entry: Entry) => Promise<void>; hasClipboard: boolean; showProperties: (entry: Entry) => void; concatenateVideos: (entries: Entry[]) => Promise<void>; setError: (message: string) => void
}) {
  const [menu, setMenu] = useState<{ entry: Entry; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    addEventListener('pointerdown', close); addEventListener('keydown', escape)
    return () => { removeEventListener('pointerdown', close); removeEventListener('keydown', escape) }
  }, [menu])
  const toggle = (entry: Entry) => {
    const next = new Set(selected)
    next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id)
    setSelected(next); setPrimary(next.has(entry.id) ? entry : rows.find(row => next.has(row.entry.id))?.entry ?? null)
  }
  const showMenu = (event: React.MouseEvent, entry: Entry) => {
    event.preventDefault(); event.stopPropagation(); setMenu({ entry, x: event.clientX, y: event.clientY })
  }
  return <div className="mobile-directory-list" role="list" aria-label="Directory contents">
    {canNavigateUp && <button className="mobile-parent-row" onClick={navigateUp}><span className="mobile-glyph-slot"><ChevronLeft /></span><span className="mobile-entry-label"><strong>Parent folder</strong><small>Go up one level</small></span></button>}
    {!rows.length && <Empty />}
    {rows.map(({ entry }) => <div className={`mobile-directory-row ${selected.has(entry.id) ? 'selected' : ''} ${cutIds.has(entry.id) ? 'cut' : ''}`} role="listitem" key={entry.id}>
      {selecting && <input type="checkbox" aria-label={`Select ${entry.name}`} checked={selected.has(entry.id)} onChange={() => toggle(entry)} />}
      <button className="mobile-entry-open" onClick={() => selecting ? toggle(entry) : activate(entry)}>
        <span className="mobile-glyph-slot"><FileGlyph entry={entry} /></span>
        <span className="mobile-entry-label"><strong title={entry.name}>{entry.name}</strong><small>{entry.kind === 'directory' ? 'Folder' : formatBytes(entry.size)}</small></span>
        {entry.kind === 'directory' && <ChevronRight className="mobile-directory-arrow" />}
      </button>
      {!selecting && <button className="mobile-row-actions" aria-label={`Actions for ${entry.name}`} onClick={event => showMenu(event, entry)}><MoreHorizontal /></button>}
    </div>)}
    {menu && <ContextMenu {...menu} selectedEntries={rows.map(row => row.entry).filter(entry => selected.has(entry.id))} close={() => setMenu(null)} open={() => activate(menu.entry)} renameEntry={renameEntry} deleteEntry={deleteEntry} stageClipboard={stageClipboard} pasteInto={pasteInto} hasClipboard={hasClipboard} showProperties={showProperties} concatenateVideos={concatenateVideos} setError={setError} />}
  </div>
}

function PositionedContextMenu({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  const isMobile = useMobileMode()
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })
  useLayoutEffect(() => {
    const place = () => {
      const menu = menuRef.current
      if (!menu) return
      const bounds = menu.getBoundingClientRect()
      const next = fitContextMenuToViewport(
        { x, y },
        { width: bounds.width, height: bounds.height },
        { width: innerWidth, height: innerHeight },
      )
      setPosition(current => current.x === next.x && current.y === next.y ? current : next)
    }
    place()
    addEventListener('resize', place)
    return () => removeEventListener('resize', place)
  }, [x, y])
  const menu = <div ref={menuRef} className="context-menu" style={{ left: position.x, top: position.y }} role="menu" onPointerDown={event => event.stopPropagation()}>{children}</div>
  return isMobile ? <div className="mobile-menu-backdrop" role="presentation">{menu}</div> : menu
}

function ContextMenu({ entry, selectedEntries, x, y, close, open, renameEntry, deleteEntry, stageClipboard, pasteInto, hasClipboard, showProperties, concatenateVideos, setError }: { entry: Entry; selectedEntries: Entry[]; x: number; y: number; close: () => void; open: () => void; renameEntry: (entry: Entry) => Promise<void>; deleteEntry: (entry: Entry) => Promise<void>; stageClipboard: (operation: ClipboardOperation, entry: Entry) => void; pasteInto: (entry: Entry) => Promise<void>; hasClipboard: boolean; showProperties: (entry: Entry) => void; concatenateVideos: (entries: Entry[]) => Promise<void>; setError: (message: string) => void }) {
  const promptAction = usePrompt()
  const vfxEditorEnabled = useContext(VfxEditorContext)
  const copyPath = async () => {
    try { await navigator.clipboard.writeText(entry.path) } catch { setError(clipboardError(entry.path)) }
    close()
  }
  const copyProvenance = async () => {
    close()
    let url = ''
    try {
      const provenance = await api.provenance(entry.id)
      url = provenance.urls[0] ?? ''
      if (!url) throw new Error('No provenance URL is defined.')
    } catch (error) { setError(messageOf(error)); return }
    try { await navigator.clipboard.writeText(url) } catch { setError(clipboardError(url)) }
  }
  const remove = async () => {
    close()
    try { await deleteEntry(entry) } catch (error) { setError(messageOf(error)) }
  }
  const stage = (operation: ClipboardOperation) => { close(); stageClipboard(operation, entry) }
  const paste = () => { close(); void pasteInto(entry) }
  const rename = () => { close(); void renameEntry(entry) }
  const properties = () => { close(); showProperties(entry) }
  const addProvenance = async () => {
    close()
    const url = await promptAction({ title: 'Add provenance URL', label: 'Source URL', submitLabel: 'Add', placeholder: 'https://example.com/source' })
    if (!url) return
    try {
      const current = await api.provenance(entry.id)
      const next = await api.setProvenance(entry.id, [...current.urls, url])
      dispatchEvent(new CustomEvent<ProvenanceChange>('rfb:provenance-changed', { detail: { id: entry.id, urls: next.urls } }))
    } catch (error) { setError(messageOf(error)) }
  }
  const editWithVfx = () => {
    close()
    void launchVfxEditor(entry.id, (url, target) => window.open(url, target), api.openVfxProject).catch(error => setError(messageOf(error)))
  }
  const canConcatenate = selectedEntries.length >= 2 && selectedEntries.some(item => item.id === entry.id) && selectedEntries.every(item => item.kind === 'file' && item.mime.startsWith('video/'))
  const concatenate = () => { close(); void concatenateVideos(selectedEntries) }
  return <PositionedContextMenu x={x} y={y}>
    <button role="menuitem" autoFocus onClick={() => { close(); open() }}><FolderOpen /> Open</button>
    <button role="menuitem" onClick={() => stage('move')}><Scissors /> Cut</button>
    <button role="menuitem" onClick={() => stage('copy')}><Copy /> Copy</button>
    {entry.kind === 'directory' && <button role="menuitem" disabled={!hasClipboard} onClick={paste}><ClipboardPaste /> Paste Into</button>}
    <button role="menuitem" onClick={rename}><Edit3 /> Rename</button>
    <button role="menuitem" onClick={copyPath}><Copy /> Copy path</button>
    <button role="menuitem" onClick={properties}><Info /> Properties</button>
    <span className="context-divider" />
    {canConcatenate && <button role="menuitem" onClick={concatenate}><Film /> Concatenate videos</button>}
    {vfxEditorEnabled && entry.kind === 'file' && entry.mime.startsWith('video/') && <button role="menuitem" onClick={editWithVfx}><ExternalLink /> Edit with VFX Editor</button>}
    {entry.kind === 'file' && <button role="menuitem" onClick={() => void addProvenance()}><Link2 /> Add provenance URL</button>}
    {entry.kind === 'file' && entry.hasProvenance && <button role="menuitem" onClick={() => void copyProvenance()}><Copy /> Copy Provenance URL</button>}
    <button role="menuitem" className="danger" onClick={remove}><Trash2 /> Delete</button>
  </PositionedContextMenu>
}

function FolderContextMenu({ directoryId, path, x, y, close, createItem, paste, hasClipboard, showProperties, setError, mobileControls }: { directoryId: string; path: string; x: number; y: number; close: () => void; createItem: (kind: 'file' | 'directory', directoryId?: string) => Promise<void>; paste: () => Promise<void>; hasClipboard: boolean; showProperties: (id: string) => void; setError: (message: string) => void; mobileControls?: { hidden: boolean; toggleHidden: () => void; refresh: () => void } }) {
  useEffect(() => {
    const dismiss = () => close()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    addEventListener('pointerdown', dismiss); addEventListener('keydown', escape)
    return () => { removeEventListener('pointerdown', dismiss); removeEventListener('keydown', escape) }
  }, [close])
  const create = (kind: 'file' | 'directory') => { close(); void createItem(kind, directoryId) }
  const pasteHere = () => { close(); void paste() }
  const copyPath = async () => {
    try { await navigator.clipboard.writeText(path) } catch { setError(clipboardError(path)) }
    close()
  }
  const properties = () => { close(); showProperties(directoryId) }
  const refresh = () => { close(); mobileControls?.refresh() }
  const toggleHidden = () => { close(); mobileControls?.toggleHidden() }
  return <PositionedContextMenu x={x} y={y}>
    <button role="menuitem" autoFocus onClick={() => create('directory')}><Folder /> New Folder</button>
    <button role="menuitem" onClick={() => create('file')}><File /> New File</button>
    <span className="context-divider" />
    <button role="menuitem" disabled={!hasClipboard} onClick={pasteHere}><ClipboardPaste /> Paste</button>
    {mobileControls && <button role="menuitem" onClick={refresh}><RefreshCw /> Refresh</button>}
    {mobileControls && <button role="menuitem" onClick={toggleHidden}><Eye /> {mobileControls.hidden ? 'Hide hidden files' : 'Show hidden files'}</button>}
    <button role="menuitem" onClick={copyPath}><Copy /> Copy Path</button>
    <button role="menuitem" onClick={properties}><Info /> Properties</button>
  </PositionedContextMenu>
}

function PropertiesDialog({ id, initial, onClose }: { id: string; initial?: Entry; onClose: () => void }) {
  const [entry, setEntry] = useState<Entry | undefined>(initial)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setEntry(initial); setLoading(true); setError('')
    api.metadata(id).then(metadata => {
      if (active) setEntry(metadata)
    }).catch(reason => {
      if (active) setError(messageOf(reason))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [id, initial])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    addEventListener('keydown', escape)
    return () => removeEventListener('keydown', escape)
  }, [onClose])
  return <div className="modal-backdrop" role="presentation" onPointerDown={onClose}>
    <section className="confirm-dialog properties-dialog" role="dialog" aria-modal="true" aria-labelledby="properties-title" onPointerDown={event => event.stopPropagation()}>
      <div className="properties-heading">
        <div className="confirm-mark">{entry ? <FileGlyph entry={entry} /> : <Info />}</div>
        <div><h2 id="properties-title">Properties</h2>{entry && <p title={entry.path}>{entry.name}</p>}</div>
      </div>
      {!entry ? <div className="properties-loading" role="status"><span className="spinner" /> Loading properties…</div> : <dl className="properties-metadata">
        <dt>Name</dt><dd>{entry.name}</dd>
        <dt>Path</dt><dd>{entry.path}</dd>
        <dt>Type</dt><dd>{propertyTypeLabel(entry.kind)}</dd>
        {entry.kind === 'file' && <><dt>MIME</dt><dd><code>{entry.mime}</code></dd></>}
        {entry.kind === 'directory' ? <><dt>Contents</dt><dd>{directoryContentsLabel(entry, loading)}</dd></> : <><dt>Size</dt><dd>{formatBytes(entry.size)} ({entry.size.toLocaleString()} bytes)</dd></>}
        <dt>Permissions</dt><dd><code>{entry.permissions} ({entry.mode.toString(8).padStart(4, '0')})</code></dd>
        <dt>Owner</dt><dd>{entry.uid}:{entry.gid}</dd>
        <dt>Modified</dt><dd>{formatDate(entry.modifiedAt)}</dd>
        <dt>Created</dt><dd>{formatDate(entry.createdAt)}</dd>
        <dt>Accessed</dt><dd>{formatDate(entry.accessedAt)}</dd>
        {entry.symlinkTarget !== undefined && <><dt>Target</dt><dd>{entry.symlinkTarget}</dd></>}
      </dl>}
      {error && <p className="properties-error" role="alert">Could not refresh properties: {error}</p>}
      <div className="confirm-actions"><button className="primary" autoFocus onClick={onClose}>Close</button></div>
    </section>
  </div>
}

function ViewSelector({ view, setView }: { view: ViewMode; setView: (view: ViewMode) => void }) {
  return <div className="view-selector" aria-label="View mode">
    {(['details', 'small', 'medium', 'large'] as ViewMode[]).map(mode => <button className={view === mode ? 'active' : ''} title={mode === 'details' ? 'columns' : mode} key={mode} onClick={() => setView(mode)}>{mode === 'details' ? <Columns3 /> : mode === 'small' ? <Menu /> : mode === 'medium' ? <Grid2X2 /> : <Maximize2 />}</button>)}
  </div>
}

function EditorWindow({ document, entry, onClose, onSaved, onDirtyChange, onOpenFile }: { document: DocumentFile; entry: Pick<Entry, 'name' | 'path'>; onClose: () => void; onSaved: (doc: DocumentFile) => void; onDirtyChange: (dirty: boolean) => void; onOpenFile: (id: string) => Promise<void> }) {
  const confirmAction = useConfirm()
  const [content, setContent] = useState(document.content)
  const isMarkdown = document.mime.includes('markdown') || document.id.endsWith('bWQ')
  const [mode, setMode] = useState<EditorMode>(isMarkdown ? 'split' : 'edit')
  const [wordWrap, setWordWrap] = useState(() => localStorage.getItem('rfb-editor-word-wrap') === 'true')
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [error, setError] = useState('')
  const [editorScroll, setEditorScroll] = useState<HTMLElement | null>(null)
  const preview = useRef<HTMLElement>(null)
  const previewContent = useRef<HTMLDivElement>(null)
  const latestContent = useRef(content)
  const savingRef = useRef(false)
  latestContent.current = content
  const dirty = content !== document.content
  useEffect(() => { localStorage.setItem('rfb-editor-word-wrap', String(wordWrap)) }, [wordWrap])
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  const syncPreview = useCallback(() => {
    if (mode !== 'split' || !editorScroll || !preview.current) return
    preview.current.scrollTop = proportionalScrollTop(editorScroll, preview.current)
  }, [editorScroll, mode])
  useLayoutEffect(() => {
    if (mode !== 'split' || !editorScroll || !preview.current) return
    let frame = 0
    const scheduleSync = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(syncPreview)
    }
    editorScroll.addEventListener('scroll', scheduleSync, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleSync)
    observer?.observe(editorScroll)
    const editorContent = editorScroll.querySelector('.cm-content')
    if (editorContent) observer?.observe(editorContent)
    if (previewContent.current) observer?.observe(previewContent.current)
    scheduleSync()
    return () => { cancelAnimationFrame(frame); editorScroll.removeEventListener('scroll', scheduleSync); observer?.disconnect() }
  }, [editorScroll, mode, syncPreview])
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(syncPreview)
    return () => cancelAnimationFrame(frame)
  }, [content, mode, syncPreview, wordWrap])
  const save = useCallback(async () => {
    if (savingRef.current || content === document.content) return
    const snapshot = { ...document, content }
    savingRef.current = true; setSaving(true); setSaveMessage(''); setError('')
    try {
      const saved = await api.saveDocument(snapshot)
      if (saved.id !== document.id) throw new Error('The server returned a different file after saving.')
      onSaved(saved)
      setSaveMessage(latestContent.current === snapshot.content ? `Saved ${entry.name}` : `Saved ${entry.name}; newer changes are unsaved.`)
    } catch (reason) { setError(messageOf(reason)) }
    finally { savingRef.current = false; setSaving(false) }
  }, [content, document, entry.name, onSaved])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!editorSaveShortcut(event)) return
      event.preventDefault(); void save()
    }
    addEventListener('keydown', shortcut)
    return () => removeEventListener('keydown', shortcut)
  }, [save])
  const changeContent = (value: string) => {
    latestContent.current = value; setContent(value); onDirtyChange(value !== document.content); setSaveMessage(''); setError('')
  }
  const close = async () => {
    if (savingRef.current) { setSaveMessage('Wait for the file to finish saving.'); return }
    if (!dirty || await confirmAction('Your unsaved edits will be lost.', { title: 'Discard unsaved changes?', confirmLabel: 'Discard', danger: true })) onClose()
  }
  const scrollFromPreview = (event: React.WheelEvent<HTMLElement>) => {
    if (mode !== 'split' || !editorScroll || event.deltaY === 0) return
    event.preventDefault()
    const computedLineHeight = Number.parseFloat(getComputedStyle(editorScroll).lineHeight)
    editorScroll.scrollTop += wheelDeltaPixels(event, Number.isFinite(computedLineHeight) ? computedLineHeight : 18, editorScroll.clientHeight)
  }
  const openMarkdownLink = (event: React.MouseEvent<HTMLAnchorElement>, href?: string) => {
    if (!isMarkdownLocalTarget(href)) return
    event.preventDefault(); setError('')
    const id = resolveMarkdownFileId(document.id, href)
    if (!id) { setError('The link must remain below the filesystem root.'); return }
    void onOpenFile(id).catch(reason => setError(messageOf(reason)))
  }
  const saveComplete = !dirty && Boolean(saveMessage) && !saving
  return <FloatingWindow title={`${entry.name} — Text editor`} onClose={() => void close()} className="editor-window">
    <div className="window-toolbar">
      <button className="primary compact editor-save" disabled={!dirty || saving} aria-busy={saving} title="Save (Ctrl/Cmd+S)" onClick={() => void save()}>{saveComplete ? <Check size={15} /> : <Save size={15} />} {saving ? 'Saving…' : saveComplete ? 'Saved' : 'Save'}</button>
      {isMarkdown && <div className="editor-mode-selector" role="group" aria-label="Markdown view">
        <button className={mode === 'edit' ? 'active' : ''} aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}><Edit3 size={15} /> Edit</button>
        <button className={mode === 'split' ? 'active' : ''} aria-pressed={mode === 'split'} onClick={() => setMode('split')}><Columns3 size={15} /> Split</button>
        <button className={mode === 'preview' ? 'active' : ''} aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}><Eye size={15} /> Preview</button>
      </div>}
      <button className={wordWrap ? 'active' : ''} aria-pressed={wordWrap} disabled={mode === 'preview'} title={mode === 'preview' ? 'Word wrap applies to the editor' : 'Toggle editor word wrap'} onClick={() => setWordWrap(value => !value)}><WrapText size={15} /> Word wrap</button>
      {saveMessage && <span className="editor-save-status" role="status" aria-live="polite">{saveMessage}</span>}
      <span className="toolbar-spacer" /><code title={entry.path}>{entry.path}</code>
    </div>
    {error && <div className="banner error" role="alert">{error}</div>}
    <div className={`editor-body mode-${mode}`}>
      <CodeMirror className="editor-pane" value={content} height="100%" theme="dark" extensions={[...(isMarkdown ? [markdown()] : []), ...(wordWrap ? [EditorView.lineWrapping] : [])]} onCreateEditor={view => setEditorScroll(view.scrollDOM)} onUpdate={update => { if (update.docChanged) changeContent(update.state.doc.toString()) }} />
      {mode !== 'edit' && <article ref={preview} className="markdown" onWheel={scrollFromPreview}><div ref={previewContent} className="markdown-content"><ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeSanitize, markdownSanitizeSchema]]}
          urlTransform={markdownUrlTransform}
          components={{
            a: ({ href, node: _node, ...props }) => <a {...props} href={href} onClick={event => openMarkdownLink(event, href)} />,
            img: ({ src, alt, title, node: _node, ...props }) => isMarkdownMp4Source(src)
              ? <video src={resolveMarkdownMediaSource(document.id, src)} controls preload="metadata" playsInline aria-label={alt || title || 'Embedded video'} title={title}>Your browser cannot play this video.</video>
              : <img {...props} src={resolveMarkdownMediaSource(document.id, src)} alt={alt} title={title} />,
          }}
        >{content}</ReactMarkdown></div></article>}
    </div>
  </FloatingWindow>
}

function ViewerWindow({ entry, type, images, onNavigate, onMarkupSaved, onClose }: { entry: Entry; type: 'image' | 'video'; images: Entry[]; onNavigate: (entry: Entry) => void; onMarkupSaved: (entry: Entry) => Promise<void>; onClose: () => void }) {
  const confirmAction = useConfirm()
  const [zoom, setZoom] = useState(1)
  const [rotate, setRotate] = useState(0)
  const [mediaDimensions, setMediaDimensions] = useState<{ width: number; height: number }>()
  const [viewport, setViewport] = useState(() => ({ width: innerWidth, height: innerHeight }))
  const [marking, setMarking] = useState(false)
  const [strokes, setStrokes] = useState<MarkupStroke[]>([])
  const [markupReady, setMarkupReady] = useState(false)
  const [savingMarkup, setSavingMarkup] = useState(false)
  const [markupMessage, setMarkupMessage] = useState('')
  const markupCanvas = useRef<HTMLCanvasElement>(null)
  const imageIndex = images.findIndex(image => image.id === entry.id)
  const discardMarkup = useCallback(async () => {
    if (savingMarkup) { setMarkupMessage('Wait for the markup to finish saving.'); return false }
    if (marking && strokes.length && !await confirmAction('Your unsaved markup will be lost.', { title: 'Discard markup?', confirmLabel: 'Discard', danger: true })) return false
    setMarking(false); setStrokes([]); setMarkupReady(false); setMarkupMessage('')
    return true
  }, [confirmAction, marking, savingMarkup, strokes.length])
  const navigate = useCallback(async (direction: -1 | 1) => {
    if (images.length < 2) return
    if (!await discardMarkup()) return
    const current = imageIndex >= 0 ? imageIndex : 0
    onNavigate(images[(current + direction + images.length) % images.length])
  }, [discardMarkup, imageIndex, images, onNavigate])
  useEffect(() => {
    setZoom(1); setRotate(0); setMediaDimensions(undefined); setMarking(false); setStrokes([]); setMarkupReady(false); setSavingMarkup(false); setMarkupMessage('')
  }, [entry.etag, entry.id])
  useEffect(() => {
    const resized = () => setViewport({ width: innerWidth, height: innerHeight })
    addEventListener('resize', resized)
    return () => removeEventListener('resize', resized)
  }, [])
  useEffect(() => {
    if (type !== 'image') return
    const keyboard = (event: KeyboardEvent) => {
      if (marking) {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault(); event.stopPropagation(); setStrokes(current => current.slice(0, -1))
        }
        return
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault(); event.stopPropagation()
      void navigate(event.key === 'ArrowLeft' ? -1 : 1)
    }
    addEventListener('keydown', keyboard, { capture: true })
    return () => removeEventListener('keydown', keyboard, { capture: true })
  }, [marking, navigate, type])
  const toggleMarkup = async () => {
    if (marking) { await discardMarkup(); return }
    setRotate(0); setStrokes([]); setMarkupMessage(''); setMarking(true)
  }
  const saveMarkup = async () => {
    if (!markupCanvas.current || !strokes.length) return
    setSavingMarkup(true); setMarkupMessage('')
    try {
      const saved = await api.saveImageMarkup(entry.id, entry.etag, await canvasPng(markupCanvas.current))
      setStrokes([]); setMarking(false); setMarkupMessage(`Saved ${saved.name}`)
      await onMarkupSaved(saved)
    } catch (error) { setMarkupMessage(messageOf(error)) } finally { setSavingMarkup(false) }
  }
  const requestClose = async () => { if (await discardMarkup()) onClose() }
  const compact = viewport.width <= 800
  const windowSize = mediaDimensions && fitMediaWindow(
    mediaDimensions.width,
    mediaDimensions.height,
    Math.max(320, viewport.width - (compact ? 20 : 48)),
    Math.max(260, viewport.height - (compact ? 80 : 48)),
    type === 'image' ? (marking ? 123 : 81) : 110,
  )
  return <FloatingWindow title={entry.name} onClose={() => void requestClose()} className={`viewer-window ${marking ? 'marking' : ''}`} size={windowSize}>
    {type === 'image' ? <>
      <div className="window-toolbar image-toolbar"><button onClick={() => setZoom(z => Math.max(.25, z - .25))}><ZoomOut /></button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(z => Math.min(5, z + .25))}><ZoomIn /></button><button disabled={marking} title={marking ? 'Rotation is unavailable while marking up' : 'Rotate clockwise'} onClick={() => setRotate(r => r + 90)}><RotateCw /></button><button className={marking ? 'active' : ''} aria-pressed={marking} disabled={!mediaDimensions} title={marking ? 'Leave markup mode' : 'Mark up image'} onClick={() => void toggleMarkup()}><Pencil /> Mark up</button>
        {marking && <><button disabled={!strokes.length || savingMarkup} title="Undo last stroke (Ctrl/Cmd+Z)" onClick={() => setStrokes(current => current.slice(0, -1))}><Undo2 /> Undo</button><button disabled={!strokes.length || savingMarkup} onClick={() => setStrokes([])}><Eraser /> Clear</button><button className="primary compact" disabled={!strokes.length || !markupReady || savingMarkup} onClick={() => void saveMarkup()}><Save /> {savingMarkup ? 'Saving…' : 'Save'}</button></>}
        {markupMessage && <span className="markup-message" role="status">{markupMessage}</span>}<span className="toolbar-spacer" /><a className="button" href={contentUrl(entry.id)}><Download /> Download</a></div>
      <div className={`image-stage ${marking ? 'marking' : ''}`}>
        <button className="image-nav previous" disabled={marking || images.length < 2} aria-label="Previous image" title="Previous image (Left Arrow)" onClick={() => void navigate(-1)}><ChevronLeft /></button>
        {marking ? <ImageMarkupCanvas ref={markupCanvas} entry={entry} zoom={zoom} strokes={strokes} setStrokes={setStrokes} onDimensions={(width, height) => setMediaDimensions({ width, height })} onReady={setMarkupReady} onError={setMarkupMessage} /> :
          <img src={mediaUrl(entry.id, entry.etag)} alt={entry.name} style={{ transform: `scale(${zoom}) rotate(${rotate}deg)` }} onLoad={event => setMediaDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />}
        <button className="image-nav next" disabled={marking || images.length < 2} aria-label="Next image" title="Next image (Right Arrow)" onClick={() => void navigate(1)}><ChevronRight /></button>
      </div>
    </> : <VideoPlayer entry={entry} editing onMediaSize={(width, height) => setMediaDimensions({ width, height })} />}
  </FloatingWindow>
}

const ImageMarkupCanvas = forwardRef<HTMLCanvasElement, { entry: Entry; zoom: number; strokes: MarkupStroke[]; setStrokes: React.Dispatch<React.SetStateAction<MarkupStroke[]>>; onDimensions: (width: number, height: number) => void; onReady: (ready: boolean) => void; onError: (message: string) => void }>(function ImageMarkupCanvas({ entry, zoom, strokes, setStrokes, onDimensions, onReady, onError }, forwardedRef) {
  const localCanvas = useRef<HTMLCanvasElement>(null)
  const sourceImage = useRef<HTMLImageElement | null>(null)
  const activeStroke = useRef<{ pointerId: number; stroke: MarkupStroke } | null>(null)
  const assignCanvas = (canvas: HTMLCanvasElement | null) => {
    localCanvas.current = canvas
    if (typeof forwardedRef === 'function') forwardedRef(canvas)
    else if (forwardedRef) forwardedRef.current = canvas
  }
  const paint = (nextStrokes: MarkupStroke[]) => {
    const canvas = localCanvas.current
    const image = sourceImage.current
    const context = canvas?.getContext('2d')
    if (!canvas || !image || !context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const lineWidth = markupStrokeWidth(canvas.width, canvas.height)
    nextStrokes.forEach(stroke => drawMarkupStroke(context, stroke, lineWidth))
  }
  useEffect(() => {
    let cancelled = false
    onReady(false); onError('')
    const image = new Image()
    image.onload = () => {
      if (cancelled || !localCanvas.current) return
      const canvas = localCanvas.current
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      sourceImage.current = image
      onDimensions(image.naturalWidth, image.naturalHeight)
      paint(strokes); onReady(true)
    }
    image.onerror = () => { if (!cancelled) { onReady(false); onError('The source image could not be loaded for markup.') } }
    image.src = mediaUrl(entry.id, entry.etag)
    return () => { cancelled = true; sourceImage.current = null; activeStroke.current = null }
  }, [entry.etag, entry.id])
  useEffect(() => { paint(strokes) }, [strokes])
  const pointFor = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget
    return markupPoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), canvas.width, canvas.height)
  }
  const start = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || activeStroke.current || !sourceImage.current) return
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
    const stroke = { points: [pointFor(event)] }
    activeStroke.current = { pointerId: event.pointerId, stroke }
    const context = event.currentTarget.getContext('2d')
    if (context) drawMarkupStroke(context, stroke, markupStrokeWidth(event.currentTarget.width, event.currentTarget.height))
  }
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const active = activeStroke.current
    if (!active || active.pointerId !== event.pointerId) return
    event.preventDefault()
    const point = pointFor(event)
    const previous = active.stroke.points.at(-1)!
    active.stroke.points.push(point)
    const context = event.currentTarget.getContext('2d')
    if (context) drawMarkupStroke(context, { points: [previous, point] }, markupStrokeWidth(event.currentTarget.width, event.currentTarget.height))
  }
  const finish = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const active = activeStroke.current
    if (!active || active.pointerId !== event.pointerId) return
    activeStroke.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setStrokes(current => [...current, active.stroke])
  }
  return <canvas ref={assignCanvas} className="markup-canvas" aria-label={`Mark up ${entry.name}`} style={{ transform: `scale(${zoom})` }} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} />
})

function VideoPlayer({ entry, autoPlay = true, editing = false, onMediaSize }: { entry: Entry; autoPlay?: boolean; editing?: boolean; onMediaSize?: (width: number, height: number) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const cancelled = useRef(false)
  const fallbackStarted = useRef(false)
  const hlsFailure = useRef('')
  const [hlsSource, setHlsSource] = useState<string>()
  const [message, setMessage] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [frameRate, setFrameRate] = useState<number>()
  const [markIn, setMarkIn] = useState<number>()
  const [markOut, setMarkOut] = useState<number>()
  const [extracting, setExtracting] = useState(false)
  useEffect(() => {
    cancelled.current = false; fallbackStarted.current = false; hlsFailure.current = ''; setHlsSource(undefined)
    setCurrentTime(0); setDuration(0); setFrameRate(undefined); setMarkIn(undefined); setMarkOut(undefined); setActionMessage(''); setExtracting(false)
    if (editing) api.mediaInfo(entry.id).then(info => {
      if (!cancelled.current) { setDuration(info.durationSeconds); setFrameRate(info.frameRate ?? undefined) }
    }).catch(e => { if (!cancelled.current) setActionMessage(messageOf(e)) })
    return () => { cancelled.current = true; hlsRef.current?.destroy(); hlsRef.current = null }
  }, [editing, entry.etag, entry.id])
  const attach = (playlistUrl: string) => {
    if (cancelled.current) return
    hlsFailure.current = ''
    setMessage('Loading browser-compatible stream…')
    setHlsSource(playlistUrl)
  }
  useEffect(() => {
    if (!hlsSource) return
    const video = videoRef.current
    if (!video || cancelled.current) return
    let nativeReady: (() => void) | undefined
    const startPlayback = () => {
      if (cancelled.current) return
      setMessage('')
      if (autoPlay) void video.play().catch(() => {
        if (!cancelled.current) setMessage('Stream ready. Press Play to start.')
      })
    }
    if (Hls.isSupported()) {
      let networkRecoveries = 0, mediaRecoveries = 0
      const hls = new Hls(); hlsRef.current = hls
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(hlsSource))
      hls.on(Hls.Events.MANIFEST_PARSED, startPlayback)
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || cancelled.current) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries++ === 0) {
          setMessage('Retrying the video stream…'); hls.startLoad(); return
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ === 0) {
          setMessage('Recovering video playback…'); hls.recoverMediaError(); return
        }
        const reason = `${data.type}/${data.details}`
        const detail = data.error?.message && data.error.message !== data.details ? `: ${data.error.message}` : ''
        hlsFailure.current = `Video playback failed (${reason})${detail}`
        setMessage(hlsFailure.current)
        hls.destroy()
        if (hlsRef.current === hls) hlsRef.current = null
      })
      hls.attachMedia(video)
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      nativeReady = startPlayback
      video.addEventListener('canplay', nativeReady, { once: true })
      video.src = hlsSource; video.load()
    } else setMessage('This browser cannot play HLS video')
    return () => {
      if (nativeReady) video.removeEventListener('canplay', nativeReady)
      const hls = hlsRef.current
      hlsRef.current = null
      hls?.destroy()
    }
  }, [autoPlay, hlsSource])
  const fallback = async () => {
    if (fallbackStarted.current) return
    fallbackStarted.current = true
    setMessage('Preparing a browser-compatible stream…')
    try {
      let current = await api.startHls(entry.id)
      const key = current.key
      let attached = false
      if (current.playable) { attach(current.playlistUrl); attached = true }
      while (current.status === 'working' && !cancelled.current) {
        await new Promise(r => setTimeout(r, 1000)); current = await api.hlsStatus(key)
        if (!attached && current.playable) { attach(current.playlistUrl); attached = true }
      }
      if (cancelled.current) return
      if (current.status !== 'ready') throw new Error('Transcoding failed')
      if (!attached) attach(current.playlistUrl)
    } catch (e) { setMessage(messageOf(e)) }
  }
  const handleVideoError = () => {
    if (!hlsSource && !fallbackStarted.current) { void fallback(); return }
    if (!hlsRef.current) setMessage(hlsFailure.current || mediaPlaybackError(videoRef.current?.error ?? null))
  }
  const step = (direction: -1 | 1) => {
    const video = videoRef.current
    if (!video || !frameRate || !duration) return
    video.pause()
    const next = stepFrame(video.currentTime, direction, frameRate, duration)
    video.currentTime = next; setCurrentTime(next)
  }
  const awaitExtraction = async (job: ExtractionJob) => {
    setExtracting(true)
    setActionMessage(job.kind === 'frame' ? 'Extracting frame…' : 'Extracting segment…')
    try {
      let current = job
      while (current.status === 'working' && !cancelled.current) {
        await new Promise(resolve => setTimeout(resolve, 750))
        current = await api.extractionStatus(current.key)
      }
      if (cancelled.current) return
      if (current.status === 'failed') throw new Error(current.error || 'Extraction failed')
      setActionMessage(`Created ${current.result?.name ?? 'extraction'}`)
    } catch (error) { if (!cancelled.current) setActionMessage(messageOf(error)) }
    finally { if (!cancelled.current) setExtracting(false) }
  }
  const extractFrame = () => {
    const time = Math.min(currentTime, Math.max(0, duration - (frameRate ? 1 / frameRate : .001)))
    setExtracting(true); setActionMessage('Starting frame extraction…')
    void api.startExtraction({ id: entry.id, kind: 'frame', time }).then(awaitExtraction).catch(error => { setExtracting(false); setActionMessage(messageOf(error)) })
  }
  const extractSegment = () => {
    if (!validSegment(markIn, markOut)) return
    setExtracting(true); setActionMessage('Starting segment extraction…')
    void api.startExtraction({ id: entry.id, kind: 'segment', startTime: markIn, endTime: markOut! }).then(awaitExtraction).catch(error => { setExtracting(false); setActionMessage(messageOf(error)) })
  }
  useEffect(() => {
    if (!editing) return
    const keyboard = (event: KeyboardEvent) => {
      if (ignoresVideoShortcut(event.target) || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === ',') { event.preventDefault(); step(-1) }
      else if (event.key === '.') { event.preventDefault(); step(1) }
      else if (event.key.toLowerCase() === 'i' && !event.shiftKey) { event.preventDefault(); setMarkIn(currentTime) }
      else if (event.key.toLowerCase() === 'o' && !event.shiftKey) { event.preventDefault(); setMarkOut(currentTime) }
      else if (event.key.toLowerCase() === 'f' && event.shiftKey && !extracting) { event.preventDefault(); extractFrame() }
      else if (event.key.toLowerCase() === 'x' && event.shiftKey && !extracting && validSegment(markIn, markOut)) { event.preventDefault(); extractSegment() }
    }
    addEventListener('keydown', keyboard)
    return () => removeEventListener('keydown', keyboard)
  }, [currentTime, duration, editing, extracting, frameRate, markIn, markOut])
  return <div className={`video-player ${editing ? 'editing' : ''}`}>
    <div className="video-stage"><video key={`${entry.id}:${entry.etag}:${hlsSource ? 'hls' : 'source'}`} ref={videoRef} src={hlsSource ? undefined : mediaUrl(entry.id, entry.etag)} controls muted autoPlay={!hlsSource && autoPlay} loop={shouldAutoLoop(duration)} preload={autoPlay ? 'auto' : 'metadata'} onError={handleVideoError} onLoadedMetadata={event => { const video = event.currentTarget; if (!duration && Number.isFinite(video.duration)) setDuration(video.duration); if (video.videoWidth > 0 && video.videoHeight > 0) onMediaSize?.(video.videoWidth, video.videoHeight) }} onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime)} onSeeked={event => setCurrentTime(event.currentTarget.currentTime)} />{message && <div className="video-message">{message}</div>}</div>
    {editing && <div className="video-tools" aria-label="Video extraction controls">
      <div className="frame-controls">
        <button title="Previous frame (,)" aria-label="Previous frame" disabled={!frameRate} onClick={() => step(-1)}><ChevronLeft /></button>
        <code>{formatMediaTime(currentTime)}</code>
        <button title="Next frame (.)" aria-label="Next frame" disabled={!frameRate} onClick={() => step(1)}><ChevronRight /></button>
        <span className="fps">{frameRate ? `${frameRate.toFixed(3)} fps` : 'FPS unavailable'}</span>
      </div>
      <div className="marker-controls">
        <button title="Set In (I)" onClick={() => setMarkIn(currentTime)}>In</button>
        <code>{markIn === undefined ? '--:--:--.---' : formatMediaTime(markIn)}</code>
        <button title="Clear In" disabled={markIn === undefined} onClick={() => setMarkIn(undefined)}><X /></button>
        <button title="Set Out (O)" onClick={() => setMarkOut(currentTime)}>Out</button>
        <code>{markOut === undefined ? '--:--:--.---' : formatMediaTime(markOut)}</code>
        <button title="Clear Out" disabled={markOut === undefined} onClick={() => setMarkOut(undefined)}><X /></button>
      </div>
      <div className="extract-controls">
        <button title="Extract frame (Shift+F)" disabled={extracting || !duration} onClick={extractFrame}><Camera /> Frame</button>
        <button title="Extract segment (Shift+X)" disabled={extracting || !validSegment(markIn, markOut)} onClick={extractSegment}><Scissors /> Segment</button>
      </div>
      {actionMessage && <div className="video-action-message" role="status">{actionMessage}</div>}
    </div>}
  </div>
}

function TrashWindow({ items, onClose, onChanged, onRestored, setError }: { items: TrashEntry[]; onClose: () => void; onChanged: () => Promise<void>; onRestored: (entry: Entry) => Promise<void>; setError: (s: string) => void }) {
  const confirmAction = useConfirm()
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await onChanged() } catch (e) { setError(messageOf(e)) } }
  const restore = async (item: TrashEntry) => {
    try {
      let entry: Entry
      try {
        entry = await api.restore(item.info.id)
      } catch (e) {
        if (!(e instanceof ApiFailure) || e.code !== 'already_exists' || !await confirmAction(`${e.message}. Replace it and move the old item to Trash?`, { title: 'Replace existing item?', confirmLabel: 'Replace', danger: true })) throw e
        entry = await api.restore(item.info.id, undefined, true)
      }
      await Promise.all([onChanged(), onRestored(entry)])
    } catch (e) { setError(messageOf(e)) }
  }
  const empty = async () => { if (await confirmAction('Everything in Trash will be permanently deleted. This cannot be undone.', { title: 'Empty Trash?', confirmLabel: 'Empty Trash', danger: true })) await act(api.emptyTrash) }
  const purge = async (item: TrashEntry) => { if (await confirmAction(`${item.info.originalName} will be permanently deleted. This cannot be undone.`, { title: 'Delete permanently?', confirmLabel: 'Delete', danger: true })) await act(() => api.purge(item.info.id)) }
  return <FloatingWindow title="Trash" onClose={onClose} className="trash-window">
    <div className="window-toolbar"><span>{items.length} item{items.length === 1 ? '' : 's'}</span><span className="toolbar-spacer" /><button disabled={!items.length} onClick={empty}><Trash2 /> Empty Trash</button></div>
    <div className="trash-list">{items.length === 0 ? <Empty label="Trash is empty" /> : items.map(item => <div className="trash-row" key={item.info.id}><FileGlyph entry={{ kind: item.kind } as Entry} /><div><strong>{item.info.originalName}</strong><small>Deleted {formatDate(item.info.deletedAt)}</small></div><span>{formatBytes(item.size)}</span><button onClick={() => restore(item)}>Restore</button><button className="danger" onClick={() => purge(item)}><Trash2 /></button></div>)}</div>
  </FloatingWindow>
}

function FloatingWindow({ title, onClose, className = '', size, children }: { title: string; onClose: () => void; className?: string; size?: { width: number; height: number }; children: React.ReactNode }) {
  const [position, setPosition] = useState(() => ({ x: Math.max(20, innerWidth * .12), y: 90 }))
  const [minimized, setMinimized] = useState(false)
  const drag = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)
  useEffect(() => {
    if (!size || moved.current) return
    setPosition({ x: Math.max(10, (innerWidth - size.width) / 2), y: Math.max(10, (innerHeight - size.height) / 2) })
  }, [size?.height, size?.width])
  const toggleMinimized = (event?: React.MouseEvent) => {
    event?.preventDefault(); event?.stopPropagation()
    setMinimized(value => !value)
  }
  const tray = minimized ? document.getElementById('window-tray') : null
  return <>
    <div className={`floating ${minimized ? 'stashed' : ''} ${className}`} style={{ left: position.x, top: position.y, width: size?.width, height: size?.height }} aria-hidden={minimized}>
      <div className="window-title" onDoubleClick={() => toggleMinimized()} onPointerDown={e => { moved.current = true; drag.current = { x: e.clientX - position.x, y: e.clientY - position.y }; e.currentTarget.setPointerCapture(e.pointerId) }} onPointerMove={e => { if (drag.current) setPosition({ x: Math.max(0, e.clientX - drag.current.x), y: Math.max(0, e.clientY - drag.current.y) }) }} onPointerUp={() => { drag.current = null }}><span>{title}</span><div className="window-actions"><button type="button" aria-label={`Minimize ${title}`} title="Minimize to tray" onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onClick={toggleMinimized}><Minus /></button><button type="button" aria-label={`Close ${title}`} title="Close" onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onClick={onClose}><X /></button></div></div>
      {children}
    </div>
    {tray && createPortal(<div className="window-tray-item">
      <button type="button" className="window-tray-restore" title={`Restore ${title}`} onClick={toggleMinimized}><Maximize2 /><span>{title}</span></button>
      <button type="button" className="window-tray-close" aria-label={`Close ${title}`} title={`Close ${title}`} onClick={onClose}><X /></button>
    </div>, tray)}
  </>
}

function FileGlyph({ entry }: { entry: Pick<Entry, 'kind'> & Partial<Entry> }) {
  if (entry.kind === 'directory') return <Folder className="glyph folder" />
  const video = entry.mime?.startsWith('video/')
  const icon = entry.mime?.startsWith('image/') ? <FileImage /> : video ? <Film /> : entry.mime?.startsWith('text/') ? <FileText /> : <File />
  return <span className="file-glyph glyph">{icon}{video && entry.browserReady && <VideoReadyBadge />}{entry.hasProvenance && <span className="provenance-check">✓</span>}</span>
}
function VideoReadyBadge() { return <span className="browser-ready" aria-label="Ready to play in browser" title="Ready to play in browser"><Play aria-hidden="true" fill="currentColor" /></span> }
function first<T>(set: Set<T>) { return set.values().next().value }
function findEntry(id: string | undefined, root: EntryPage | null, pages: Record<string, EntryPage>) { if (id === undefined) return; return [...(root?.entries ?? []), ...Object.values(pages).flatMap(p => p.entries)].find(entry => entry.id === id) }
function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} B`; const units = ['KB', 'MB', 'GB', 'TB']; let value = bytes / 1024, unit = 0; while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ } return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}` }
function formatDate(value?: string) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—' }
function messageOf(error: unknown) { return error instanceof Error ? error.message : 'The operation failed' }
function ignoresFileClipboardShortcut(target: EventTarget | null) {
  const element = target instanceof Element ? target : document.activeElement
  const blockedContext = Boolean(element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .context-menu, .floating, .modal-backdrop, .terminal-dock'))
  return !shouldHandleClipboardShortcut(Boolean(getSelection()?.toString()), blockedContext)
}
function mediaPlaybackError(error: MediaError | null) {
  if (!error) return 'Video playback failed.'
  if (error.code === 1) return 'Video playback was aborted.'
  if (error.code === 2) return 'The browser could not load the video stream.'
  if (error.code === 3) return 'The browser could not decode the converted video.'
  if (error.code === 4) return 'The converted video format is not supported by this browser.'
  return error.message || 'Video playback failed.'
}
function clipboardError(text: string) { return `The browser denied clipboard access. Copy manually: ${text}` }
function Empty({ label = 'This folder is empty' }: { label?: string }) { return <div className="empty"><FolderOpen /><strong>{label}</strong><span>Nothing to show here.</span></div> }
