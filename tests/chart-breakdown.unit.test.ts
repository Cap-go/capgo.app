import type { NumericSeriesByApp } from '../src/services/usageSeries'
import { describe, expect, it } from 'vitest'
import { limitChartBreakdown, MAX_CHART_BREAKDOWN_SERIES } from '../src/utils/chartBreakdown'

describe('chart breakdown rendering budget', () => {
  it.concurrent('keeps a small active breakdown in its existing order without copying its arrays', () => {
    const source = { 'com.example.first': [1, 2], 'com.example.second': [4, 5] }
    const result = limitChartBreakdown(source)

    expect(result.map(series => series.id)).toEqual(Object.keys(source))
    expect(result[0].data).toBe(source['com.example.first'])
    expect(result[1].data).toBe(source['com.example.second'])
  })

  it.concurrent('does not spend the rendering budget on inactive or missing-only series', () => {
    expect(limitChartBreakdown({
      'com.example.empty': [],
      'com.example.zero': [0, 0],
      'com.example.missing': [undefined, undefined],
      'com.example.active': [undefined, 1],
    })).toEqual([{ id: 'com.example.active', data: [undefined, 1] }])
  })

  it.concurrent('groups the remainder without mutating inputs or fabricating an app identity', () => {
    const source = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
      `com.example.app${index}`,
      [index + 1, (index + 1) * 2, undefined],
    ]))
    const snapshot = structuredClone(source)
    const result = limitChartBreakdown(source)

    expect(result).toHaveLength(MAX_CHART_BREAKDOWN_SERIES)
    expect(result[0].id).toBe('com.example.app999')
    expect(result.at(-1)?.id).toBeUndefined()
    expect(result.at(-1)?.data[2]).toBeUndefined()
    expect(source).toEqual(snapshot)
    for (let dayIndex = 0; dayIndex < 2; dayIndex++) {
      const sum = result.reduce((total, series) => total + (series.data[dayIndex] ?? 0), 0)
      expect(sum).toBe(500_500 * (dayIndex + 1))
    }
  })

  it.concurrent('preserves signed totals, differing lengths, and zero days when grouping', () => {
    const source: NumericSeriesByApp = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [
      `com.example.top${index}`,
      [100, 100],
    ]))
    source['com.example.corrections'] = [-5, 5, undefined, 0]
    source['com.example.later'] = [undefined, -1, 2]

    const result = limitChartBreakdown(source)
    expect(result.at(-1)).toEqual({ data: [-5, 4, 2, 0] })
    expect(result.reduce((total, series) => total + (series.data[0] ?? 0), 0)).toBe(895)
  })

  it.concurrent('keeps tied series deterministic at the rendering boundary', () => {
    const source = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`com.example.app${index}`, [1]]))
    const result = limitChartBreakdown(source)

    expect(result.slice(0, -1).map(series => series.id)).toEqual(Object.keys(source).slice(0, 9))
    expect(result.at(-1)).toEqual({ data: [2] })
  })
})
