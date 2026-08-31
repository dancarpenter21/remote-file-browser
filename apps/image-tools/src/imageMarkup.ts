export type MarkupPoint = { x: number; y: number }
export type MarkupStroke = { points: MarkupPoint[] }

export const MARKUP_COLOR = '#ff3b30'

export function markupStrokeWidth(width: number, height: number) {
  return Math.max(4, Math.min(24, Math.min(width, height) * .006))
}

export function markupPoint(clientX: number, clientY: number, bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, width: number, height: number): MarkupPoint {
  if (bounds.width <= 0 || bounds.height <= 0) return { x: 0, y: 0 }
  return {
    x: Math.max(0, Math.min(width, (clientX - bounds.left) * width / bounds.width)),
    y: Math.max(0, Math.min(height, (clientY - bounds.top) * height / bounds.height)),
  }
}

export function drawMarkupStroke(context: CanvasRenderingContext2D, stroke: MarkupStroke, lineWidth: number) {
  const [first, ...rest] = stroke.points
  if (!first) return
  context.save()
  context.strokeStyle = MARKUP_COLOR; context.fillStyle = MARKUP_COLOR; context.lineWidth = lineWidth; context.lineCap = 'round'; context.lineJoin = 'round'
  if (!rest.length) { context.beginPath(); context.arc(first.x, first.y, lineWidth / 2, 0, Math.PI * 2); context.fill() }
  else { context.beginPath(); context.moveTo(first.x, first.y); rest.forEach(point => context.lineTo(point.x, point.y)); context.stroke() }
  context.restore()
}

export function canvasPng(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    try { canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The marked-up image could not be encoded as PNG.')), 'image/png') }
    catch (error) { reject(error) }
  })
}
