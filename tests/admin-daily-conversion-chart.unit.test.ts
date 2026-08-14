import { describe, expect, it } from 'vitest'
import {
  buildAdminDailyConversionChartData,
  buildAdminDailyConversionChartOptions,
} from '../src/components/admin/adminDailyConversionChart'

describe('admin daily conversion chart', () => {
  const points = [
    { date: '2026-08-01', started: 5, converted: 3, conversion_percent: 60 },
    { date: '2026-08-02', started: 0, converted: 0, conversion_percent: null },
  ]

  it.concurrent('builds vertical percentage columns while preserving missing days', () => {
    const data = buildAdminDailyConversionChartData(points, 'Conversion', '#6366f1')

    expect(data.labels).toEqual(['01/08/2026', '02/08/2026'])
    expect(data.datasets).toEqual([
      expect.objectContaining({
        label: 'Conversion',
        data: [60, null],
        backgroundColor: '#6366f1',
      }),
    ])
  })

  it.concurrent('fixes the y-axis to 0–100% and includes converted counts in tooltips', () => {
    const options = buildAdminDailyConversionChartOptions(points, false, 'attempts')
    const label = options.plugins?.tooltip?.callbacks?.label

    expect(options.indexAxis).toBe('x')
    expect(options.scales?.y).toMatchObject({ min: 0, max: 100 })
    expect(label?.call({} as never, { dataIndex: 0, parsed: { y: 60 } } as never)).toBe('60% · 3 / 5 attempts')
    expect(label?.call({} as never, { dataIndex: 1, parsed: { y: null } } as never)).toBe('')
  })
})
