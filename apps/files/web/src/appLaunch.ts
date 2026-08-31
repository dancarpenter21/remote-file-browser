import type { AppLaunch } from './api'

type LaunchWindow = { close: () => void; location: { replace: (url: string) => void } }

async function relayLaunchTicket(channelName: string, ticket: string, timeoutMessage: string) {
  const channel = new BroadcastChannel(channelName)
  const requestId = crypto.randomUUID()
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        globalThis.clearTimeout(timeout)
        globalThis.clearInterval(ping)
        error ? reject(error) : resolve()
      }
      const timeout = globalThis.setTimeout(() => finish(new Error(timeoutMessage)), 8_000)
      const ping = globalThis.setInterval(() => channel.postMessage({ type: 'ping', requestId }), 150)
      channel.onmessage = event => {
        if (event.data?.type !== 'ready' || event.data?.requestId !== requestId) return
        channel.postMessage({ type: 'launch', ticket })
        finish()
      }
      channel.postMessage({ type: 'ping', requestId })
    })
  } finally {
    channel.close()
  }
}

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
  await relayLaunchTicket('remote-workspace:text-editor', ticket, 'Text Editor did not become ready.')
  editor.focus()
  return launch
}

export async function launchReusableImageTools(
  appUrl: string,
  createLaunch: () => Promise<AppLaunch>,
  openWindow: (url: string, target: string) => Window | null = window.open,
) {
  const imageTools = openWindow(appUrl, 'remote-workspace-image-tools')
  if (!imageTools) throw new Error('Allow popups for Files to open Image Tools.')
  const launch = await createLaunch()
  const ticket = new URL(launch.launchUrl, location.origin).hash.slice('#ticket='.length)
  if (!ticket) throw new Error('Image Tools launch did not contain a ticket.')
  await relayLaunchTicket('remote-workspace:image-tools', ticket, 'Image Tools did not become ready.')
  imageTools.focus()
  return launch
}
