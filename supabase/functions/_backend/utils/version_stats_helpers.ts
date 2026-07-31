export interface VersionUsageLike {
  date: string
  version_name: string
  get: number | null | undefined
}

export type DailyVersionMap = Record<string, Record<string, number>>

function createDailyVersionMap(dates: string[], versions: string[]) {
  const counts: DailyVersionMap = {}

  dates.forEach((date) => {
    counts[date] = {}
    versions.forEach((version) => {
      counts[date][version] = 0
    })
  })

  return counts
}

export function buildDailyReportedCountsByName(
  usage: VersionUsageLike[],
  dates: string[],
  versions: string[],
) {
  const counts = createDailyVersionMap(dates, versions)

  usage.forEach((entry) => {
    const date = entry.date
    const version = entry.version_name
    if (!version || !counts[date] || counts[date][version] === undefined)
      return
    counts[date][version] += Math.max(0, Math.round(entry.get ?? 0))
  })

  return counts
}

export function fillMissingDailyCounts(
  counts: DailyVersionMap,
  dates: string[],
  versions: string[],
  todayLabel: string = new Date().toISOString().slice(0, 10),
) {
  if (dates.length === 0 || versions.length === 0)
    return counts

  const filled: DailyVersionMap = {}
  dates.forEach((date) => {
    filled[date] = {}
    versions.forEach((version) => {
      filled[date][version] = Math.max(0, Math.round(counts[date]?.[version] ?? 0))
    })
  })

  for (let index = 1; index < dates.length; index++) {
    const date = dates[index]
    if (date === todayLabel)
      continue

    const previousDate = dates[index - 1]
    const dayTotal = versions.reduce((sum, version) => sum + (filled[date]?.[version] ?? 0), 0)
    const previousTotal = versions.reduce((sum, version) => sum + (filled[previousDate]?.[version] ?? 0), 0)

    if (dayTotal === 0 && previousTotal > 0) {
      versions.forEach((version) => {
        filled[date][version] = filled[previousDate]?.[version] ?? 0
      })
    }
  }

  return filled
}

export function convertCountsToPercentagesByName(
  counts: DailyVersionMap,
  dates: string[],
  versions: string[],
) {
  const percentages: DailyVersionMap = {}

  dates.forEach((date) => {
    const dayData = counts[date] ?? {}
    const total = versions.reduce((sum, version) => sum + (dayData[version] ?? 0), 0)
    percentages[date] = {}
    if (total <= 0) {
      versions.forEach((version) => {
        percentages[date][version] = 0
      })
      return
    }

    const preciseShares = versions.map((version) => {
      const count = dayData[version] ?? 0
      return (count / total) * 100
    })
    const flooredShares = preciseShares.map(share => Math.floor(share * 10) / 10)
    const flooredSum = flooredShares.reduce((sum, share) => sum + share, 0)
    let unitsToDistribute = Math.max(0, Math.round((100 - flooredSum) * 10))

    const remainderOrder = preciseShares
      .map((share, index) => ({ index, remainder: share - flooredShares[index] }))
      .sort((a, b) => {
        if (b.remainder === a.remainder)
          return a.index - b.index
        return b.remainder - a.remainder
      })

    const roundedShares = [...flooredShares]
    for (let i = 0; i < remainderOrder.length && unitsToDistribute > 0; i++, unitsToDistribute--) {
      const target = remainderOrder[i].index
      roundedShares[target] = Number((roundedShares[target] + 0.1).toFixed(1))
    }

    versions.forEach((version, index) => {
      percentages[date][version] = roundedShares[index] ?? 0
    })
  })

  return percentages
}

export interface VersionChartDataset {
  label: string
  data: number[]
  metaCounts: number[]
}

/** Chart.js datasets: percentage series plus raw counts in metaCounts. */
export function createPercentageDatasetsByName(
  versions: string[],
  dates: string[],
  percentagesByDate: DailyVersionMap,
  countsByDate: DailyVersionMap,
): VersionChartDataset[] {
  return versions.map((version) => {
    const percentageData = dates.map(date => percentagesByDate[date]?.[version] ?? 0)
    const countData = dates.map(date => Math.max(0, Math.round(countsByDate[date]?.[version] ?? 0)))

    return {
      label: version,
      data: percentageData,
      metaCounts: countData,
    }
  })
}

/** Alias used by public statistics routes/tests. */
export const createDatasetsByName = createPercentageDatasetsByName

