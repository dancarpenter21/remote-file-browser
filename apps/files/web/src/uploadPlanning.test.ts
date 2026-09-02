import { describe, expect, it } from 'vitest'
import type { Entry } from './api'
import { conflictSummary, planUpload } from './uploadPlanning'

const entry = (name: string, kind: Entry['kind'], id = name): Entry => ({
  id, parentId: '', path: `/fs-root/${name}`, name, kind, size: 0, mode: 0, permissions: '', uid: 0, gid: 0, mime: '', etag: '', hasProvenance: false,
})
const localFile = (name: string, path: string[]) => ({ file: { name, size: 1 } as File, path })

describe('upload collision planning', () => {
  it('merges matching directories and reports file and type conflicts', async () => {
    const pages: Record<string, Entry[]> = {
      root: [entry('project', 'directory', 'project-id'), entry('loose.txt', 'file')],
      'project-id': [entry('existing.txt', 'file'), entry('as-file', 'file')],
    }
    const plan = await planUpload({
      directories: [['project'], ['project', 'as-file']],
      files: [localFile('existing.txt', ['project', 'existing.txt']), localFile('new.txt', ['project', 'new.txt']), localFile('loose.txt', ['loose.txt'])],
    }, 'root', async id => pages[id] ?? [])
    expect(plan.directories[0].existingId).toBe('project-id')
    expect(plan.conflicts.map(conflict => conflict.path)).toEqual([
      ['project', 'as-file'],
      ['project', 'existing.txt'],
      ['loose.txt'],
    ])
    expect(conflictSummary(plan.conflicts)).toContain('3 existing items conflict')
  })

  it('does not scan descendants below a conflicting directory', async () => {
    const calls: string[] = []
    const plan = await planUpload({ directories: [['blocked'], ['blocked', 'child']], files: [localFile('x', ['blocked', 'child', 'x'])] }, 'root', async id => {
      calls.push(id); return id === 'root' ? [entry('blocked', 'file')] : []
    })
    expect(calls).toEqual(['root'])
    expect(plan.conflicts).toHaveLength(1)
  })

  it('rejects manifests targeting reserved root storage', async () => {
    await expect(planUpload({ directories: [['.trash']], files: [] }, '', async () => [])).rejects.toThrow('reserved')
  })
})

