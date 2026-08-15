import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  applyAdminStackedBarAccessibleBorders,
  buildAdminStackedBarChartData,
  buildAdminStackedBarChartOptions,
  buildAdminStackedBarLegendItems,
  formatAdminStackedBarTooltip,
  getAdminStackedBarTooltipTotal,
  toggleAdminStackedBarLegendGroup,
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

  it.concurrent('offers opt-in contrasting segment boundaries without changing every chart', () => {
    const data = buildAdminStackedBarChartData(['Aug 1', 'Aug 2'], series)
    const unchanged = applyAdminStackedBarAccessibleBorders(data, false, false)
    const light = applyAdminStackedBarAccessibleBorders(data, true, false)
    const dark = applyAdminStackedBarAccessibleBorders(data, true, true)

    expect(unchanged).toBe(data)
    expect(light.datasets.every(dataset => dataset.borderColor === '#0f172a' && dataset.borderWidth === 1)).toBe(true)
    expect(dark.datasets.every(dataset => dataset.borderColor === '#f8fafc' && dataset.borderWidth === 1)).toBe(true)
  })

  it.concurrent('preserves optional stack metadata and uses stack-scoped tooltip totals', () => {
    const grouped = buildAdminStackedBarChartData(['Aug 1'], [
      { label: 'No action', data: [3], color: '#94a3b8', stack: 'first_time', stackLabel: 'First-time' },
      { label: 'No action', data: [2], color: '#94a3b8', stack: 'returning', stackLabel: 'Returning' },
      { label: 'CLI + init', data: [1], color: '#10b981', stack: 'first_time', stackLabel: 'First-time' },
    ])

    expect(grouped.datasets.map(dataset => ({
      stack: dataset.stack,
      stackLabel: dataset.stackLabel,
    }))).toEqual([
      { stack: 'first_time', stackLabel: 'First-time' },
      { stack: 'returning', stackLabel: 'Returning' },
      { stack: 'first_time', stackLabel: 'First-time' },
    ])
    expect(getAdminStackedBarTooltipTotal(grouped.datasets, 0, 0)).toBe(4)
    expect(getAdminStackedBarTooltipTotal(grouped.datasets, 1, 0)).toBe(2)
  })

  it.concurrent('keeps legacy tooltip totals across every dataset', () => {
    const data = buildAdminStackedBarChartData(['Aug 1'], series)

    expect(getAdminStackedBarTooltipTotal(data.datasets, 0, 0)).toBe(10)
  })

  it.concurrent('includes the lifecycle label in grouped tooltips', () => {
    const data = buildAdminStackedBarChartData(['Aug 1'], [
      { label: 'No action', data: [3], color: '#94a3b8', stack: 'first_time', stackLabel: 'First-time' },
      { label: 'CLI + init', data: [1], color: '#10b981', stack: 'first_time', stackLabel: 'First-time' },
      { label: 'No action', data: [2], color: '#94a3b8', stack: 'returning', stackLabel: 'Returning' },
    ])
    const options = buildAdminStackedBarChartOptions(false, true) as any
    const label = options.plugins.tooltip.callbacks.label({
      parsed: { y: 3 },
      chart: { data },
      dataset: data.datasets[0],
      datasetIndex: 0,
      dataIndex: 0,
    })

    expect(label).toBe('First-time · No action: 3 (75%)')
  })

  it.concurrent('deduplicates active grouped legend labels and removes zero-only categories', () => {
    const grouped = buildAdminStackedBarChartData(['Aug 1', 'Aug 2'], [
      { label: 'No action', data: [3, 0], color: '#94a3b8', stack: 'first_time' },
      { label: 'No action', data: [0, 1], color: '#94a3b8', stack: 'returning' },
      { label: 'Never happened', data: [0, 0], color: '#ef4444', stack: 'first_time' },
      { label: 'Never happened', data: [0, 0], color: '#ef4444', stack: 'returning' },
    ])
    const chart = {
      data: grouped,
      isDatasetVisible: () => true,
    } as any

    expect(buildAdminStackedBarLegendItems(chart).map(item => item.text)).toEqual(['No action'])
  })

  it.concurrent('shows a grouped legend category that exists in only one lifecycle', () => {
    const grouped = buildAdminStackedBarChartData(['Aug 1'], [
      { label: 'CLI + init', data: [2], color: '#10b981', stack: 'first_time' },
      { label: 'No action', data: [1], color: '#94a3b8', stack: 'returning' },
    ])
    const chart = {
      data: grouped,
      isDatasetVisible: () => true,
    } as any

    expect(buildAdminStackedBarLegendItems(chart).map(item => item.text)).toEqual(['CLI + init', 'No action'])
  })

  it.concurrent('wires grouped legend generation and toggling through chart options', () => {
    const data = buildAdminStackedBarChartData(['Aug 1'], [
      { label: 'No action', data: [3], color: '#94a3b8', stack: 'first_time' },
      { label: 'No action', data: [2], color: '#94a3b8', stack: 'returning' },
      { label: 'Never happened', data: [0], color: '#ef4444', stack: 'first_time' },
    ])
    const visibility = [true, true, true]
    let updateCount = 0
    const chart = {
      data,
      isDatasetVisible: (index: number) => visibility[index],
      setDatasetVisibility: (index: number, visible: boolean) => { visibility[index] = visible },
      update: () => { updateCount++ },
    }
    const options = buildAdminStackedBarChartOptions(true, true) as any
    const items = options.plugins.legend.labels.generateLabels(chart)

    expect(items.map((item: { text: string, fontColor?: string }) => ({
      text: item.text,
      fontColor: item.fontColor,
    }))).toEqual([{ text: 'No action', fontColor: '#d1d5db' }])

    options.plugins.legend.onClick({}, items[0], { chart })
    expect(visibility).toEqual([false, false, true])
    expect(updateCount).toBe(1)
  })

  it.concurrent('toggles every lifecycle dataset represented by one legend item', () => {
    const visibility = [true, true, true]
    const chart = {
      data: { datasets: [{ label: 'No action' }, { label: 'No action' }, { label: 'CLI + init' }] },
      isDatasetVisible: (index: number) => visibility[index],
      setDatasetVisibility: (index: number, visible: boolean) => { visibility[index] = visible },
      update: () => undefined,
    } as any

    toggleAdminStackedBarLegendGroup(chart, 'No action')
    expect(visibility).toEqual([false, false, true])
    toggleAdminStackedBarLegendGroup(chart, 'No action')
    expect(visibility).toEqual([true, true, true])
  })

  it.concurrent('uses grouped interaction only when requested', () => {
    expect((buildAdminStackedBarChartOptions(false, false) as any).interaction.mode).toBe('index')
    expect((buildAdminStackedBarChartOptions(false, true) as any).interaction.mode).toBe('nearest')
  })
})
