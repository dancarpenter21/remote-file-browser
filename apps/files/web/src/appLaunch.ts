import type { AppLaunch } from './api'

type LaunchWindow = { close: () => void; location: { replace: (url: string) => void } }

export async function launchInstalledApp(
  placeholderUrl: string,
  openWindow: (url: string, target: string) => LaunchWindow | null,
  createLaunch: () => Promise<AppLaunch>,
) {
  const appWindow = openWindow(placeholderUrl, '_blank')
  if (!appWindow) throw new Error('Allow popups for Remote Files to open this app.')
  try {
    const launch = await createLaunch()
    appWindow.location.replace(launch.launchUrl)
    return launch
  } catch (error) {
    appWindow.close()
    throw error
  }
}

export async function launchTabbedTextEditor(
  appUrl: string,
  createLaunch: () => Promise<AppLaunch>,
  openWindow: (url: string, target: string) => Window | null = window.open,
) {
  const editor = openWindow(appUrl, 'remote-workspace-text-editor')
  if (!editor) throw new Error('Allow popups for Files to open Text Editor.')
  const launch = await createLaunch()
  const ticket = new URL(launch.launchUrl, location.origin).hash.slice('#ticket='.length)
  if (!ticket) throw new Error('Text Editor launch did not contain a ticket.')
  const channel = new BroadcastChannel('remote-workspace:text-editor')
  const requestId = crypto.randomUUID()
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Text Editor did not become ready.')), 8_000)
      const ping = window.setInterval(() => channel.postMessage({ type: 'ping', requestId }), 150)
      channel.onmessage = event => {
        if (event.data?.type !== 'ready' || event.data?.requestId !== requestId) return
        window.clearTimeout(timeout); window.clearInterval(ping)
        channel.postMessage({ type: 'launch', ticket }); resolve()
      }
      channel.postMessage({ type: 'ping', requestId })
    })
  } finally { channel.close() }
  editor.focus()
  return launch
}
