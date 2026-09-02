import { useRef, useState } from 'react'
import { Check, ChevronDown, ChevronUp, CircleX, RefreshCw, Upload, X } from 'lucide-react'
import { api, ApiFailure, uploadFile } from './api'
import type { LocalUploadManifest } from './uploadIntake'
import { planUpload, uploadPathKey, type UploadConflict } from './uploadPlanning'

export type UploadConflictChoice = 'cancel' | 'skip' | 'replace'
type UploadStatus = 'preparing' | 'queued' | 'creating' | 'uploading' | 'completed' | 'skipped' | 'failed' | 'cancelled'
type UploadItem = {
  id: number
  batchId: number
  kind: 'file' | 'directory'
  path: string[]
  file?: File
  status: UploadStatus
  loaded: number
  total: number
  error?: string
}
type UploadBatch = {
  id: number
  manifest: LocalUploadManifest
  destinationId: string
  destinationPath: string
  itemIds: number[]
  cancelled: boolean
}

const activeStatuses = new Set<UploadStatus>(['preparing', 'queued', 'creating', 'uploading'])
const pathStartsWith = (path: string[], prefix: string[]) => prefix.every((part, index) => path[index] === part)
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Upload failed'

export function useUploadQueue(
  chooseConflicts: (conflicts: UploadConflict[]) => Promise<UploadConflictChoice>,
  onChanged: (directoryIds: Set<string>) => Promise<void>,
) {
  const [, render] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const items = useRef<UploadItem[]>([])
  const batches = useRef(new Map<number, UploadBatch>())
  const pending = useRef<UploadBatch[]>([])
  const controllers = useRef(new Map<number, AbortController>())
  const sequence = useRef(0)
  const processing = useRef(false)
  const publish = () => render(value => value + 1)
  const item = (id: number) => items.current.find(candidate => candidate.id === id)
  const update = (id: number, values: Partial<UploadItem>) => {
    const target = item(id)
    if (target) Object.assign(target, values)
    publish()
  }
  const itemForPath = (batch: UploadBatch, kind: UploadItem['kind'], path: string[]) => {
    const key = uploadPathKey(path)
    return items.current.find(candidate => candidate.batchId === batch.id && candidate.kind === kind && uploadPathKey(candidate.path) === key)
  }
  const isCancelled = (batch: UploadBatch, id: number) => batch.cancelled || item(id)?.status === 'cancelled'

  const processBatch = async (batch: UploadBatch) => {
    const changed = new Set<string>()
    try {
      const plan = await planUpload(batch.manifest, batch.destinationId, id => api.listAll(id, true))
      if (batch.cancelled) return
      const choice = plan.conflicts.length ? await chooseConflicts(plan.conflicts) : 'replace'
      if (choice === 'cancel') {
        batch.cancelled = true
        batch.itemIds.forEach(id => { if (activeStatuses.has(item(id)?.status ?? 'cancelled')) update(id, { status: 'cancelled' }) })
        return
      }
      batch.itemIds.forEach(id => { if (item(id)?.status === 'preparing') update(id, { status: 'queued' }) })
      const directoryIds = new Map<string, string>([['[]', batch.destinationId]])
      const skippedDirectories = new Set<string>()
      const failedDirectories = new Set<string>()
      const hasAncestor = (path: string[], set: Set<string>) => path.some((_, index) => set.has(uploadPathKey(path.slice(0, index + 1))))

      for (const directory of plan.directories) {
        const queueItem = itemForPath(batch, 'directory', directory.path)
        if (!queueItem || isCancelled(batch, queueItem.id)) continue
        const key = uploadPathKey(directory.path)
        if (hasAncestor(directory.path.slice(0, -1), skippedDirectories)) {
          skippedDirectories.add(key); update(queueItem.id, { status: 'skipped' }); continue
        }
        if (hasAncestor(directory.path.slice(0, -1), failedDirectories)) {
          failedDirectories.add(key); update(queueItem.id, { status: 'failed', error: 'A parent folder could not be created' }); continue
        }
        if (directory.conflict && choice === 'skip') {
          skippedDirectories.add(key); update(queueItem.id, { status: 'skipped' }); continue
        }
        if (directory.existingId) {
          directoryIds.set(key, directory.existingId); update(queueItem.id, { status: 'completed' }); continue
        }
        const parentId = directoryIds.get(uploadPathKey(directory.path.slice(0, -1)))
        if (parentId === undefined) {
          failedDirectories.add(key); update(queueItem.id, { status: 'failed', error: 'The destination folder is unavailable' }); continue
        }
        update(queueItem.id, { status: 'creating' })
        try {
          const created = await api.create(parentId, directory.path.at(-1)!, 'directory', Boolean(directory.conflict && choice === 'replace'))
          directoryIds.set(key, created.id); changed.add(parentId); update(queueItem.id, { status: 'completed' })
        } catch (error) {
          if (error instanceof ApiFailure && error.code === 'already_exists') {
            const remote = (await api.listAll(parentId, true)).find(entry => entry.name === directory.path.at(-1))
            if (remote?.kind === 'directory') {
              directoryIds.set(key, remote.id); update(queueItem.id, { status: 'completed' }); continue
            }
          }
          failedDirectories.add(key); update(queueItem.id, { status: 'failed', error: errorMessage(error) })
        }
      }

      let nextFile = 0
      const worker = async () => {
        while (nextFile < plan.files.length) {
          const source = plan.files[nextFile++]
          const queueItem = itemForPath(batch, 'file', source.path)
          if (!queueItem || isCancelled(batch, queueItem.id)) continue
          const parentPath = source.path.slice(0, -1)
          if (hasAncestor(parentPath, skippedDirectories) || source.conflict && choice === 'skip') {
            update(queueItem.id, { status: 'skipped' }); continue
          }
          if (hasAncestor(parentPath, failedDirectories)) {
            update(queueItem.id, { status: 'failed', error: 'A parent folder could not be created' }); continue
          }
          const parentId = directoryIds.get(uploadPathKey(parentPath))
          if (parentId === undefined) {
            update(queueItem.id, { status: 'failed', error: 'The destination folder is unavailable' }); continue
          }
          const controller = new AbortController()
          controllers.current.set(queueItem.id, controller)
          update(queueItem.id, { status: 'uploading', loaded: 0, error: undefined })
          try {
            await uploadFile(parentId, source.file, Boolean(source.conflict && choice === 'replace'), (loaded, total) => update(queueItem.id, { loaded: Math.min(loaded, source.file.size), total: source.file.size || total }), controller.signal)
            changed.add(parentId); update(queueItem.id, { status: 'completed', loaded: source.file.size })
          } catch (error) {
            update(queueItem.id, { status: error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed', error: errorMessage(error) })
          } finally { controllers.current.delete(queueItem.id) }
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, plan.files.length) }, worker))
    } catch (error) {
      batch.itemIds.forEach(id => {
        if (activeStatuses.has(item(id)?.status ?? 'cancelled')) update(id, { status: batch.cancelled ? 'cancelled' : 'failed', error: errorMessage(error) })
      })
    } finally {
      if (changed.size) await onChanged(changed)
    }
  }

  const pump = async () => {
    if (processing.current) return
    processing.current = true
    try {
      while (pending.current.length) await processBatch(pending.current.shift()!)
    } finally { processing.current = false; publish() }
  }

  const enqueue = (manifest: LocalUploadManifest, destinationId: string, destinationPath: string) => {
    const batchId = ++sequence.current
    const batchItems: UploadItem[] = [
      ...manifest.directories.map(path => ({ id: ++sequence.current, batchId, kind: 'directory' as const, path, status: 'preparing' as const, loaded: 0, total: 0 })),
      ...manifest.files.map(source => ({ id: ++sequence.current, batchId, kind: 'file' as const, path: source.path, file: source.file, status: 'preparing' as const, loaded: 0, total: source.file.size })),
    ]
    if (!batchItems.length) return
    const batch = { id: batchId, manifest, destinationId, destinationPath, itemIds: batchItems.map(value => value.id), cancelled: false }
    batches.current.set(batchId, batch); items.current.push(...batchItems); pending.current.push(batch); publish(); void pump()
  }

  const cancelItem = (id: number) => {
    controllers.current.get(id)?.abort()
    const target = item(id)
    if (target && activeStatuses.has(target.status)) update(id, { status: 'cancelled' })
  }
  const cancelAll = () => {
    batches.current.forEach(batch => { batch.cancelled = true })
    controllers.current.forEach(controller => controller.abort())
    items.current.forEach(target => { if (activeStatuses.has(target.status)) Object.assign(target, { status: 'cancelled' as const }) })
    publish()
  }
  const retryItem = (target: UploadItem) => {
    const batch = batches.current.get(target.batchId)
    if (!batch) return
    const prefix = target.kind === 'directory' ? target.path : target.path.slice(0, -1)
    const files = batch.manifest.files.filter(source => target.kind === 'file' ? uploadPathKey(source.path) === uploadPathKey(target.path) : pathStartsWith(source.path, prefix))
    const directories = batch.manifest.directories.filter(path => pathStartsWith(path, prefix) || prefix.slice(0, path.length).every((part, index) => path[index] === part))
    enqueue({ files, directories }, batch.destinationId, batch.destinationPath)
  }
  const clearCompleted = () => {
    items.current = items.current.filter(target => !['completed', 'skipped', 'cancelled'].includes(target.status))
    publish()
  }

  const current = items.current
  const active = current.some(target => activeStatuses.has(target.status))
  const total = current.reduce((sum, target) => sum + target.total, 0)
  const loaded = current.reduce((sum, target) => sum + Math.min(target.loaded, target.total), 0)
  const completeCount = current.filter(target => target.status === 'completed').length
  const panel = current.length ? <section className={`upload-queue ${collapsed ? 'collapsed' : ''}`} aria-label="Upload queue">
    <header><Upload /><div><strong>Uploads</strong><small>{active ? `${completeCount} of ${current.length} complete` : `${completeCount} completed`}</small></div><button className="icon-button" title={collapsed ? 'Expand uploads' : 'Collapse uploads'} onClick={() => setCollapsed(value => !value)}>{collapsed ? <ChevronUp /> : <ChevronDown />}</button></header>
    {!collapsed && <>
      <progress value={total ? loaded : completeCount} max={total || current.length} />
      <div className="upload-items">{current.map(target => <div className={`upload-item ${target.status}`} key={target.id}>
        <span className="upload-status">{target.status === 'completed' ? <Check /> : target.status === 'failed' ? <CircleX /> : <Upload />}</span>
        <div><strong title={target.path.join('/')}>{target.path.join('/')}</strong><small>{target.error ?? `${target.status} → ${batches.current.get(target.batchId)?.destinationPath ?? '/fs-root'}`}</small>{target.status === 'uploading' && <progress value={target.loaded} max={target.total || 1} />}</div>
        {activeStatuses.has(target.status) && <button className="icon-button" title={`Cancel ${target.path.join('/')}`} onClick={() => cancelItem(target.id)}><X /></button>}
        {target.status === 'failed' && <button className="icon-button" title={`Retry ${target.path.join('/')}`} onClick={() => retryItem(target)}><RefreshCw /></button>}
      </div>)}</div>
      <footer>{active && <button onClick={cancelAll}>Cancel all</button>}<button disabled={!current.some(target => ['completed', 'skipped', 'cancelled'].includes(target.status))} onClick={clearCompleted}>Clear finished</button></footer>
    </>}
  </section> : null
  return { enqueue, panel }
}
