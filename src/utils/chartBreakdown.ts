import type { NumericSeries, NumericSeriesByApp } from '~/services/usageSeries'

export interface ChartBreakdownSeries {
  id?: string
  data: NumericSeries
}

export const MAX_CHART_BREAKDOWN_SERIES = 10

export function limitChartBreakdown(source: NumericSeriesByApp): ChartBreakdownSeries[] {
  const series = Object.entries(source).map(([id, data]) => ({
    id,
    data,
    weight: data.reduce<number>((total, value) => total + (typeof value === 'number' && Number.isFinite(value) ? Math.abs(value) : 0), 0),
  })).filter(item => item.weight > 0)

  if (series.length <= MAX_CHART_BREAKDOWN_SERIES)
    return series.map(({ id, data }) => ({ id, data }))

  series.sort((first, second) => second.weight - first.weight)
  const visible = series.slice(0, MAX_CHART_BREAKDOWN_SERIES - 1)
  const remaining = series.slice(MAX_CHART_BREAKDOWN_SERIES - 1)
  const length = remaining.reduce((maximum, item) => Math.max(maximum, item.data.length), 0)
  const other: NumericSeries = Array.from<number | undefined>({ length }).fill(undefined)

  for (const item of remaining) {
    item.data.forEach((value, index) => {
      if (typeof value === 'number' && Number.isFinite(value))
        other[index] = (other[index] ?? 0) + value
    })
  }

  return [...visible.map(({ id, data }) => ({ id, data })), { data: other }]
}
