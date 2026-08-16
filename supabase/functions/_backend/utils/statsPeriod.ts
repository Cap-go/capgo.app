export interface RollingStatsPeriod {
  start: string
  endExclusive: string
  endInclusive: string
  labels: string[]
}

function utcDayStartMs(date: Date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export function generateUtcDateLabels(from: Date, to: Date) {
  const start = utcDayStartMs(from)
  const end = utcDayStartMs(to)
  if (start > end)
    return [] as string[]

  const labels: string[] = []
  for (let cursor = start; cursor <= end; cursor += 24 * 60 * 60 * 1000)
    labels.push(new Date(cursor).toISOString().slice(0, 10))
  return labels
}

/**
 * 1 day is a rolling 24h window relative to `now`, with two UTC day labels
 * (24h ago and latest). 3/7/30 stay inclusive UTC calendar days through today.
 */
export function getRollingStatsPeriod(days: number, now = new Date()): RollingStatsPeriod {
  if (days === 1) {
    const endExclusive = new Date(now)
    const start = new Date(endExclusive.getTime() - 24 * 60 * 60 * 1000)
    const endInclusive = new Date(endExclusive.getTime() - 1)
    return {
      start: start.toISOString(),
      endExclusive: endExclusive.toISOString(),
      endInclusive: endInclusive.toISOString(),
      labels: generateUtcDateLabels(start, endExclusive),
    }
  }

  const todayStart = utcDayStartMs(now)
  const endExclusive = new Date(todayStart + 24 * 60 * 60 * 1000)
  const start = new Date(endExclusive.getTime() - days * 24 * 60 * 60 * 1000)
  const endInclusive = new Date(endExclusive.getTime() - 1)
  const lastLabelDay = new Date(endExclusive.getTime() - 24 * 60 * 60 * 1000)
  return {
    start: start.toISOString(),
    endExclusive: endExclusive.toISOString(),
    endInclusive: endInclusive.toISOString(),
    labels: generateUtcDateLabels(start, lastLabelDay),
  }
}
