import { defaultUrlTransform } from 'react-markdown'
import { defaultSchema } from 'rehype-sanitize'

const localScheme = /^[a-z][a-z\d+.-]*:/i
export const markdownSanitizeSchema = { ...defaultSchema, protocols: { ...defaultSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), 'data'] } }
export const markdownUrlTransform = (url: string, key: string) => key === 'src' && /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i.test(url) ? url : defaultUrlTransform(url)
export const isLocalTarget = (target?: string): target is string => Boolean(target && !target.startsWith('#') && !target.startsWith('?') && !target.startsWith('//') && !localScheme.test(target))

export function resolveFileId(documentPath: string, target?: string) {
  const path = resolvePath(documentPath, target)
  if (!path) return undefined
  const bytes = new TextEncoder().encode(path)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function resolveMedia(documentPath: string, target?: string) {
  if (!isLocalTarget(target)) return target
  const id = resolveFileId(documentPath, target)
  if (!id) return ''
  const fragment = target.includes('#') ? target.slice(target.indexOf('#')) : ''
  return `/api/v1/media/file?id=${encodeURIComponent(id)}${fragment}`
}

export const isVideo = (source?: string) => Boolean(source && source.split(/[?#]/, 1)[0]?.toLowerCase().match(/\.(mp4|m4v|webm|mov)$/))

function resolvePath(documentPath: string, target?: string) {
  if (!isLocalTarget(target)) return undefined
  try {
    const relative = decodeURIComponent(target.split(/[?#]/, 1)[0] ?? '')
    const current = documentPath.replace(/^\/fs-root\/?/, '')
    const parts = relative.startsWith('/') ? [] : current.split('/').slice(0, -1)
    for (const part of relative.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') { if (!parts.length) return undefined; parts.pop() } else parts.push(part)
    }
    return parts.join('/') || undefined
  } catch { return undefined }
}
