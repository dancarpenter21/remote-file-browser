export type MeasurementPoint = { x: number; y: number }
export type PixelMeasurement = { start: MeasurementPoint; end?: MeasurementPoint }

export function measurementPoint(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  width: number,
  height: number,
): MeasurementPoint {
  if (bounds.width <= 0 || bounds.height <= 0 || width <= 0 || height <= 0) return { x: 0, y: 0 }
  return {
    x: Math.max(0, Math.min(width - 1, Math.round((clientX - bounds.left) * width / bounds.width))),
    y: Math.max(0, Math.min(height - 1, Math.round((clientY - bounds.top) * height / bounds.height))),
  }
}

export function measurementMetrics(measurement: PixelMeasurement) {
  if (!measurement.end) return null
  const deltaX = Math.abs(measurement.end.x - measurement.start.x)
  const deltaY = Math.abs(measurement.end.y - measurement.start.y)
  return { deltaX, deltaY, distance: Math.hypot(deltaX, deltaY) }
}
