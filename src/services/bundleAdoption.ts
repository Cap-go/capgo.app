export interface VersionAdoption {
  versionName: string
  count: number
  total: number
  percent: number
}

export interface ChartDatasetLike {
  label: string
  data?: Array<number | null | undefined>
  metaCounts?: Array<number | null | undefined>
  metaCountValues?: Array<number | null | undefined>
}

function toNonNegativeInt(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return 0
  return Math.max(0, Math.round(value))
}

function getCountSeries(dataset: ChartDatasetLike): Array<number | null | undefined> {
  if (Array.isArray(dataset.metaCountValues) && dataset.metaCountValues.length > 0)
    return dataset.metaCountValues
  if (Array.isArray(dataset.metaCounts) && dataset.metaCounts.length > 0)
    return dataset.metaCounts
  return []
}

function findLatestIndex(datasets: ChartDatasetLike[]): number {
  let lastIndex = -1

  for (const dataset of datasets) {
    const counts = getCountSeries(dataset)

    for (let index = counts.length - 1; index >= 0; index--) {
      if (toNonNegativeInt(counts[index]) > 0) {
        lastIndex = Math.max(lastIndex, index)
        break
      }
    }
  }

  return lastIndex
}

function percentFromShare(count: number, total: number): number {
  if (total > 0)
    return Math.round((count / total) * 1000) / 10
  return 0
}

/**
 * Latest-day unique-device share for a specific bundle, or the leading bundle
 * when no version name is given. Counts come from daily check-in stats.
 */
export function getLatestDayVersionAdoption(
  datasets: ChartDatasetLike[],
  versionName?: string,
): VersionAdoption | null {
  if (!datasets.length)
    return null

  const lastIndex = findLatestIndex(datasets)
  if (lastIndex < 0) {
    if (!versionName)
      return null
    return {
      versionName,
      count: 0,
      total: 0,
      percent: 0,
    }
  }

  const total = datasets.reduce((sum, dataset) => {
    return sum + toNonNegativeInt(getCountSeries(dataset)[lastIndex])
  }, 0)

  const namedDataset = versionName
    ? datasets.find(dataset => dataset.label === versionName)
    : undefined

  if (versionName && !namedDataset) {
    return {
      versionName,
      count: 0,
      total,
      percent: 0,
    }
  }

  const target = namedDataset ?? datasets.reduce<ChartDatasetLike | null>((current, dataset) => {
    const count = toNonNegativeInt(getCountSeries(dataset)[lastIndex])
    if (!current)
      return dataset
    const currentCount = toNonNegativeInt(getCountSeries(current)[lastIndex])
    return count > currentCount ? dataset : current
  }, null)

  if (!target)
    return null

  const count = toNonNegativeInt(getCountSeries(target)[lastIndex])
  return {
    versionName: target.label,
    count,
    total,
    percent: percentFromShare(count, total),
  }
}
