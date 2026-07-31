import { describe, expect, it } from 'vitest'
import { resolveUsageDisplaySeries, sumSeries } from '../src/services/usageSeries'

describe('usage display series', () => {
  it.concurrent('uses the aggregate series when it has positive values', () => {
    const series = resolveUsageDisplaySeries([0, 2, 0], {
      app_a: [0, 10, 0],
    })

    expect(series).toEqual([0, 2, 0])
    expect(sumSeries(series)).toBe(2)
  })

  it.concurrent('falls back to per-app data when the aggregate is zero-filled', () => {
    const series = resolveUsageDisplaySeries([0, 0, 0], {
      app_a: [undefined, 1.5, 0],
      app_b: [0.5, undefined, 2],
    })

    expect(series).toEqual([0.5, 1.5, 2])
    expect(sumSeries(series)).toBe(4)
  })
})
