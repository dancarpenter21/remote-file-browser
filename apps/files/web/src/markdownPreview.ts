import { defaultUrlTransform } from 'react-markdown'
import { defaultSchema } from 'rehype-sanitize'

const rasterDataImage = /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i
const urlScheme = /^[a-z][a-z\d+.-]*:/i

export type MarkdownLinkTarget =
  | { kind: 'external'; href: string }
  | { kind: 'fragment'; fragment: string }
  | { kind: 'local'; id: string; fragment: string }

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

  const target = resolveLocalMarkdownPath(documentId, source)
  return target ? `/api/v1/media/file?id=${encodeURIComponent(target.id)}${target.fragment ? `#${target.fragment}` : ''}` : source
}

export function resolveMarkdownLinkTarget(documentId: string, href?: string): MarkdownLinkTarget | undefined {
  if (!href) return undefined
  if (href.startsWith('#')) return { kind: 'fragment', fragment: decodeFragment(href.slice(1)) }
  if (href.startsWith('//') || urlScheme.test(href)) return { kind: 'external', href }

  const target = resolveLocalMarkdownPath(documentId, href)
  return target && { kind: 'local', id: target.id, fragment: decodeFragment(target.fragment) }
}

export function markdownHeadingElementId(fragment: string) {
  return `user-content-${decodeFragment(fragment.replace(/^#/, ''))}`
}

function resolveLocalMarkdownPath(documentId: string, source: string) {
  try {
    const documentPath = decodeFileId(documentId)
    const fragmentAt = source.indexOf('#')
    const fragment = fragmentAt === -1 ? '' : source.slice(fragmentAt + 1)
    const withoutFragment = fragmentAt === -1 ? source : source.slice(0, fragmentAt)
    const queryAt = withoutFragment.indexOf('?')
    const encodedPath = queryAt === -1 ? withoutFragment : withoutFragment.slice(0, queryAt)
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

    if (!parts.length) return undefined
    return { id: encodeFileId(parts.join('/')), fragment }
  } catch {
    return undefined
  }
}

function decodeFragment(fragment: string) {
  try { return decodeURIComponent(fragment) } catch { return fragment }
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
