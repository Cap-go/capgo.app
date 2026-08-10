import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  buildAdminStackedBarChartData,
  buildAdminStackedBarChartOptions,
  formatAdminStackedBarTooltip,
} from '../src/components/admin/adminStackedBarChart'

describe('admin stacked bar chart', () => {
  const series = [
    { label: 'Normal registration', data: [7, 4], color: '#3b82f6' },
    { label: 'Organization invite', data: [2, 1], color: '#f97316' },
    { label: 'Without profile', data: [1, 0], color: '#94a3b8' },
  ]

  it.concurrent('preserves dataset order and colors', () => {
    const data = buildAdminStackedBarChartData(['Aug 1', 'Aug 2'], series)

    expect(data.labels).toEqual(['Aug 1', 'Aug 2'])
    expect(data.datasets.map(dataset => ({
      label: dataset.label,
      data: dataset.data,
      backgroundColor: dataset.backgroundColor,
    }))).toEqual(series.map(item => ({
      label: item.label,
      data: item.data,
      backgroundColor: item.color,
    })))
  })

  it.concurrent('stacks both axes and starts counts at zero', () => {
    const options = buildAdminStackedBarChartOptions(false) as any

    expect(options.scales.x.stacked).toBe(true)
    expect(options.scales.y.stacked).toBe(true)
    expect(options.scales.y.beginAtZero).toBe(true)
  })

  it.concurrent('formats a segment as count and share of its day', () => {
    expect(formatAdminStackedBarTooltip('Organization invite', 2, 10)).toBe('Organization invite: 2 (20%)')
    expect(formatAdminStackedBarTooltip('Without profile', 0, 0)).toBe('Without profile: 0 (0%)')
  })

  it.concurrent('uses the configured DaisyUI prefix for its loading spinner', async () => {
    const source = await readFile(new URL('../src/components/admin/AdminStackedBarChart.vue', import.meta.url), 'utf8')

    expect(source).toContain('class="d-loading d-loading-spinner d-loading-lg text-primary"')
    expect(source).not.toContain('class="loading loading-spinner loading-lg text-primary"')
  })

  it.concurrent('offers opt-in contrasting segment boundaries without changing every chart', async () => {
    const source = await readFile(new URL('../src/components/admin/AdminStackedBarChart.vue', import.meta.url), 'utf8')

    expect(source).toContain('accessibleBorders')
    expect(source).toContain('default: false')
    expect(source).toContain('isDark.value ? \'#f8fafc\' : \'#0f172a\'')
    expect(source).toContain('borderWidth: 1')
  })
})
