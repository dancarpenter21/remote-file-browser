import { describe, expect, it } from 'vitest'
import { measurementMetrics, measurementPoint } from './imageMeasurement'

describe('image measurement', () => {
  it('maps viewport positions to bounded image pixels', () => {
    expect(measurementPoint(60, 45, { left: 10, top: 20, width: 100, height: 50 }, 1000, 500)).toEqual({ x: 500, y: 250 })
    expect(measurementPoint(-10, 200, { left: 10, top: 20, width: 100, height: 50 }, 1000, 500)).toEqual({ x: 0, y: 499 })
  })
  it('reports deltas and euclidean distance', () => {
    expect(measurementMetrics({ start: { x: 10, y: 20 } })).toBeNull()
    expect(measurementMetrics({ start: { x: 10, y: 20 }, end: { x: 13, y: 24 } })).toEqual({ deltaX: 3, deltaY: 4, distance: 5 })
  })
})
