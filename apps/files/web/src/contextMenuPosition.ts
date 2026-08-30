export type ContextMenuPosition = { x: number; y: number }

export function fitContextMenuToViewport(
  requested: ContextMenuPosition,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): ContextMenuPosition {
  return {
    x: Math.max(margin, Math.min(requested.x, viewport.width - menu.width - margin)),
    y: Math.max(margin, Math.min(requested.y, viewport.height - menu.height - margin)),
  }
}
