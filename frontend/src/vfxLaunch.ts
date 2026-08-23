import type { VfxProjectResponse } from './api'

type LaunchWindow = { close: () => void; location: { replace: (url: string) => void } }

export async function launchVfxEditor(
  id: string,
  openWindow: (url: string, target: string) => LaunchWindow | null,
  importProject: (id: string) => Promise<VfxProjectResponse>,
) {
  const editor = openWindow('/vfx/?handoff=1', '_blank')
  if (!editor) throw new Error('Allow popups for Remote Files to open VFX Editor.')
  try {
    const project = await importProject(id)
    editor.location.replace(`/vfx/?project=${encodeURIComponent(project.projectId)}`)
    return project
  } catch (error) {
    editor.close()
    throw error
  }
}
