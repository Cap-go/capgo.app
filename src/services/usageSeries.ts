export type NumericSeries = Array<number | undefined>
export type NumericSeriesByApp = Record<string, NumericSeries>

export function sumSeries(values: NumericSeries): number {
  return values.reduce<number>((acc, val) => (typeof val === 'number' && Number.isFinite(val) ? acc + val : acc), 0)
}

export function hasPositiveSeriesData(values: NumericSeries): boolean {
  return values.some(val => typeof val === 'number' && Number.isFinite(val) && val > 0)
}

export function hasPositiveSeriesByApp(seriesByApp: NumericSeriesByApp): boolean {
  return Object.values(seriesByApp).some(hasPositiveSeriesData)
}

export function aggregateSeriesByApp(seriesByApp: NumericSeriesByApp, fallbackLength = 0): NumericSeries {
  const length = Math.max(
    fallbackLength,
    ...Object.values(seriesByApp).map(values => values.length),
  )
  const result = Array.from({ length }).fill(undefined) as NumericSeries

  Object.values(seriesByApp).forEach((values) => {
    values.forEach((value, index) => {
      if (typeof value !== 'number' || !Number.isFinite(value))
        return
      result[index] = (result[index] ?? 0) + value
    })
  })

  return result
}

export function resolveUsageDisplaySeries(data: NumericSeries, seriesByApp: NumericSeriesByApp): NumericSeries {
  if (hasPositiveSeriesData(data) || !hasPositiveSeriesByApp(seriesByApp))
    return data

  return aggregateSeriesByApp(seriesByApp, data.length)
}
