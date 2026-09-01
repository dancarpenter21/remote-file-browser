export type BasicFileKind = 'text' | 'image' | 'video'

const textMimes = new Set([
  'application/json',
  'application/javascript',
  'application/toml',
  'application/xml',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-sh',
  'application/x-yaml',
])

const textExtension = /\.(?:c|cc|conf|cpp|css|csv|go|h|hpp|html?|ini|java|js|jsx|json|log|md|php|properties|py|rs|sh|sql|toml|ts|tsx|txt|xml|ya?ml)$/i
const markdownExtension = /\.(?:md|markdown|mdown|mkd|mkdn)$/i

export function isMarkdownFile(file: { name: string; mime: string }): boolean {
  return file.mime === 'text/markdown' || file.mime === 'text/x-markdown' || markdownExtension.test(file.name)
}

export function basicFileKind(file: { name: string; mime: string }): BasicFileKind | undefined {
  if (file.mime.startsWith('image/')) return 'image'
  if (file.mime.startsWith('video/')) return 'video'
  if (file.mime.startsWith('text/') || textMimes.has(file.mime) || textExtension.test(file.name)) return 'text'
  return undefined
}

export function isSaveShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey) && !event.altKey
}
