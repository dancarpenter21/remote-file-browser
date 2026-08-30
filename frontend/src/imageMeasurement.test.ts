import { describe, expect, it } from 'vitest'
import { measurementMetrics, measurementPoint } from './imageMeasurement'

describe('image pixel measurement', () => {
  it('maps displayed positions to integer source-image pixels', () => {
    expect(measurementPoint(300, 175, { left: 100, top: 50, width: 400, height: 250 }, 1600, 1000)).toEqual({ x: 800, y: 500 })
  })

  it('clamps points to valid source pixel coordinates', () => {
    expect(measurementPoint(0, 500, { left: 100, top: 100, width: 200, height: 200 }, 800, 600)).toEqual({ x: 0, y: 599 })
    expect(measurementPoint(500, 0, { left: 100, top: 100, width: 200, height: 200 }, 800, 600)).toEqual({ x: 799, y: 0 })
  })

  it('reports Euclidean distance and axis deltas', () => {
    expect(measurementMetrics({ start: { x: 10, y: 20 } })).toBeNull()
    expect(measurementMetrics({ start: { x: 10, y: 20 }, end: { x: 13, y: 24 } })).toEqual({ deltaX: 3, deltaY: 4, distance: 5 })
  })
})
