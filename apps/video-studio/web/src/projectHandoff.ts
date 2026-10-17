const key = (projectId: string) => `video-studio:handoff:${projectId}`;

export function rememberProjectHandoff(projectId: string, sessionId: string): void {
  try {
    window.sessionStorage.setItem(key(projectId), sessionId);
  } catch { /* The current launch still works when browser storage is unavailable. */ }
}

export function recalledProjectHandoff(projectId: string): string | undefined {
  try {
    return window.sessionStorage.getItem(key(projectId)) ?? undefined;
  } catch {
    return undefined;
  }
}
