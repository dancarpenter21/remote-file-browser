import { defaultUrlTransform } from 'react-markdown'
import { defaultSchema } from 'rehype-sanitize'

const rasterDataImage = /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i
const urlScheme = /^[a-z][a-z\d+.-]*:/i

export const markdownSanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'data'],
  },
}

export function markdownUrlTransform(url: string, key: string) {
  if (key === 'src' && rasterDataImage.test(url)) return url
  return defaultUrlTransform(url)
}

export function resolveMarkdownFileId(documentId: string, target?: string) {
  const path = resolveMarkdownPath(documentId, target)
  return path ? encodeFileId(path) : undefined
}

export function isMarkdownLocalTarget(target?: string): target is string {
  return Boolean(target && !target.startsWith('#') && !target.startsWith('?') && !target.startsWith('//') && !urlScheme.test(target))
}

export function resolveMarkdownMediaSource(documentId: string, source?: string) {
  if (!isMarkdownLocalTarget(source)) return source

  const path = resolveMarkdownPath(documentId, source)
  if (!path) return ''
  const fragmentAt = source.indexOf('#')
  const fragment = fragmentAt === -1 ? '' : source.slice(fragmentAt)
  return `/api/v1/media/file?id=${encodeURIComponent(encodeFileId(path))}${fragment}`
}

export function isMarkdownMp4Source(source?: string) {
  if (!source) return false
  const pathEnd = suffixStart(source)
  try {
    return decodeURIComponent(source.slice(0, pathEnd)).toLowerCase().endsWith('.mp4')
  } catch {
    return false
  }
}

function resolveMarkdownPath(documentId: string, target?: string) {
  if (!isMarkdownLocalTarget(target)) return undefined

  try {
    const documentPath = decodeFileId(documentId)
    const encodedPath = target.slice(0, suffixStart(target))
    if (!encodedPath) return undefined
    const targetPath = decodeURIComponent(encodedPath)
    const parts = targetPath.startsWith('/') ? [] : documentPath.split('/').slice(0, -1)

    for (const part of targetPath.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') {
        if (!parts.length) return undefined
        parts.pop()
      } else {
        parts.push(part)
      }
    }

    return parts.length ? parts.join('/') : undefined
  } catch {
    return undefined
  }
}

function suffixStart(value: string) {
  return [value.indexOf('?'), value.indexOf('#')]
    .filter(index => index >= 0)
    .reduce((end, index) => Math.min(end, index), value.length)
}

function decodeFileId(id: string) {
  const standard = id.replace(/-/g, '+').replace(/_/g, '/')
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function encodeFileId(path: string) {
  const bytes = new TextEncoder().encode(path)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
