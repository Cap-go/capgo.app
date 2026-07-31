export interface ChartLegendItem {
  id: string
  label: string
  backgroundColor: string
  borderColor: string
}

interface LegendDataset {
  label?: unknown
  backgroundColor?: unknown
  borderColor?: unknown
}

function getLegendColor(color: unknown): string {
  if (typeof color === 'string')
    return color
  if (Array.isArray(color))
    return getLegendColor(color[0])
  return '#64748b'
}

export function createChartLegendItems(datasets: LegendDataset[], idKey: string): ChartLegendItem[] {
  return datasets.map((dataset, index) => {
    const rawId = (dataset as Record<string, unknown>)[idKey]
    const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : index
    const label = typeof dataset.label === 'string' || typeof dataset.label === 'number' ? `${dataset.label}` : ''

    return {
      id: `${id}`,
      label,
      backgroundColor: getLegendColor(dataset.backgroundColor),
      borderColor: getLegendColor(dataset.borderColor),
    }
  })
}
