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

export function resolveMarkdownImageSource(documentId: string, source?: string) {
  if (!source || source.startsWith('#') || source.startsWith('//') || urlScheme.test(source)) return source

  try {
    const documentPath = decodeFileId(documentId)
    const fragmentAt = source.indexOf('#')
    const fragment = fragmentAt === -1 ? '' : source.slice(fragmentAt)
    const withoutFragment = fragmentAt === -1 ? source : source.slice(0, fragmentAt)
    const queryAt = withoutFragment.indexOf('?')
    const encodedPath = queryAt === -1 ? withoutFragment : withoutFragment.slice(0, queryAt)
    const imagePath = decodeURIComponent(encodedPath)
    const parts = imagePath.startsWith('/') ? [] : documentPath.split('/').slice(0, -1)

    for (const part of imagePath.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') {
        if (!parts.length) return source
        parts.pop()
      } else {
        parts.push(part)
      }
    }

    if (!parts.length) return source
    return `/api/v1/media/file?id=${encodeURIComponent(encodeFileId(parts.join('/')))}${fragment}`
  } catch {
    return source
  }
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
