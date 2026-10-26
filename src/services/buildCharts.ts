// Shared helpers for the build charts (Builds by status + Build time) and the
// org-wide native build summary.

import { addUtcDays, normalizeToUtcStartOfDay } from '~/services/date'

const DAY_IN_MS = 1000 * 60 * 60 * 24
export const WINDOW_DAYS = 30

export const BUILD_SERIES_KEYS = ['ios_succeeded', 'android_succeeded', 'ios_failed', 'android_failed'] as const
export type BuildSeriesKey = typeof BUILD_SERIES_KEYS[number]
export type BuildSeriesData = Record<BuildSeriesKey, number[]>

export function emptyBuildSeries(length: number = WINDOW_DAYS): BuildSeriesData {
  return {
    ios_succeeded: Array.from({ length }).fill(0) as number[],
    android_succeeded: Array.from({ length }).fill(0) as number[],
    ios_failed: Array.from({ length }).fill(0) as number[],
    android_failed: Array.from({ length }).fill(0) as number[],
  }
}

// Map a build_requests.status into a terminal outcome. Returns null for builds
// that are still in flight (pending/ready/starting/running) or unknown — they
// are not counted in the succeeded/failed breakdown. Both cancel spellings are
// handled since the backend uses each in different places.
export function bucketBuildStatus(status: string | null | undefined): 'succeeded' | 'failed' | null {
  switch (status) {
    case 'succeeded':
    case 'completed':
      return 'succeeded'
    case 'failed':
    case 'cancelled':
    case 'canceled':
    case 'expired':
      return 'failed'
    default:
      return null
  }
}

// Resolve the {platform}_{outcome} series key, or null for unsupported platforms.
export function buildSeriesKey(platform: string | null | undefined, outcome: 'succeeded' | 'failed'): BuildSeriesKey | null {
  if (platform === 'ios')
    return outcome === 'succeeded' ? 'ios_succeeded' : 'ios_failed'
  if (platform === 'android')
    return outcome === 'succeeded' ? 'android_succeeded' : 'android_failed'
  return null
}

export interface BuildChartWindow {
  windowStart: Date // UTC midnight of the first rendered day
  startISO: string // inclusive lower bound for created_at queries
  endISO: string // inclusive upper bound (end of today)
  dayCount: number // number of days from windowStart..today inclusive
}

// Resolve the fetch/render window. In billing-period mode it starts at the
// org's current cycle anchor (subscription_start) so the full cycle is covered
// — including a 31st day — instead of a fixed 30-day buffer. In last-30-days
// mode it is the trailing 30 days. Either way data is bucketed by day from
// windowStart, so there is no separate billing remapping step.
export function getBuildChartWindow(useBillingPeriod: boolean, subscriptionStart?: string | null): BuildChartWindow {
  const todayStart = normalizeToUtcStartOfDay()
  const endOfToday = new Date()

  let windowStart = new Date(todayStart)

  const cycleStart = subscriptionStart ? normalizeToUtcStartOfDay(new Date(subscriptionStart)) : null
  if (useBillingPeriod && cycleStart && !Number.isNaN(cycleStart.getTime())) {
    const elapsedDays = Math.floor((todayStart.getTime() - cycleStart.getTime()) / DAY_IN_MS)
    // Guard against a future or implausibly old anchor; fall back to 30 days.
    if (elapsedDays >= 0 && elapsedDays <= 366)
      windowStart = cycleStart
    else
      windowStart = addUtcDays(windowStart, -(WINDOW_DAYS - 1))
  }
  else {
    windowStart = addUtcDays(windowStart, -(WINDOW_DAYS - 1))
  }

  const dayCount = Math.max(Math.floor((todayStart.getTime() - windowStart.getTime()) / DAY_IN_MS) + 1, 1)
  return { windowStart, startISO: windowStart.toISOString(), endISO: endOfToday.toISOString(), dayCount }
}

export function dayIndexInWindow(date: Date, windowStart: Date): number {
  return Math.floor((date.getTime() - windowStart.getTime()) / DAY_IN_MS)
}

// Paginate a range query so apps above the configured max_rows cap are
// not silently undercounted. `runRange` must apply `.range(from, to)` and return
// the capgo result.
export async function fetchAllRows<T>(runRange: (from: number, to: number) => PromiseLike<{ data: T[] | null, error: unknown }>): Promise<T[]> {
  const PAGE_SIZE = 1000
  const rows: T[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await runRange(offset, offset + PAGE_SIZE - 1)
    if (error)
      throw error
    if (!data || data.length === 0)
      break
    rows.push(...data)
    if (data.length < PAGE_SIZE)
      break
  }
  return rows
}

// Percentage change between the last two non-zero days of a series.
export function computeLastDayEvolution(series: number[]): number {
  const nonZeroDays = series.filter(count => count > 0)
  if (nonZeroDays.length < 2)
    return 0
  const lastDayCount = nonZeroDays[nonZeroDays.length - 1]
  const previousDayCount = nonZeroDays[nonZeroDays.length - 2]
  return previousDayCount > 0 ? ((lastDayCount - previousDayCount) / previousDayCount) * 100 : 0
}

// Index of "today" within the rendered labels (so future billing-period days
// stay empty).
export function getTodayLimit(labelCount: number, useBillingPeriod: boolean, cycleStart: Date, cycleEnd: Date): number {
  if (!useBillingPeriod)
    return labelCount - 1

  const today = normalizeToUtcStartOfDay()

  if (cycleEnd <= today)
    return labelCount - 1

  const diff = Math.floor((today.getTime() - cycleStart.getTime()) / DAY_IN_MS)
  if (Number.isNaN(diff) || diff < 0)
    return -1

  return Math.min(diff, labelCount - 1)
}

// Turn a raw per-day series into chart display values (daily or cumulative),
// stopping at `limitIndex` (clamped to the array bounds).
export function transformSeries(source: number[], accumulated: boolean, labelCount: number, limitIndex: number) {
  const display: Array<number | null> = Array.from({ length: labelCount }).fill(null) as Array<number | null>
  const base: Array<number | null> = Array.from({ length: labelCount }).fill(null) as Array<number | null>

  const safeLimit = Math.min(limitIndex, labelCount - 1)
  if (safeLimit < 0)
    return { display, base }

  let runningTotal = 0
  for (let index = 0; index <= safeLimit; index++) {
    const hasValue = index < source.length && typeof source[index] === 'number' && Number.isFinite(source[index])
    const numericValue = hasValue ? source[index] as number : 0

    base[index] = numericValue
    if (accumulated) {
      runningTotal += numericValue
      display[index] = runningTotal
    }
    else {
      display[index] = numericValue
    }
  }

  return { display, base }
}

export interface BuildSummaryRow {
  app_id: string
  status: string | null
  created_at: string | null
  started_at: string | null
  completed_at: string | null
  runner_wait_seconds: number | null
}

export interface BuildTotals {
  total: number
  succeeded: number
  failed: number
  inProgress: number
  // Share of finished builds that succeeded, 0-100, or null when nothing finished.
  successRate: number | null
  // Mean run time (started_at -> completed_at) of finished builds, in seconds.
  avgDurationSeconds: number | null
  // Mean time spent waiting for a runner, in seconds.
  avgWaitSeconds: number | null
}

export interface AppBuildSummary extends BuildTotals {
  appId: string
  lastBuildAt: string | null
}

interface BuildAccumulator {
  total: number
  succeeded: number
  failed: number
  durationSum: number
  durationCount: number
  waitSum: number
  waitCount: number
  lastBuildAt: string | null
}

function emptyAccumulator(): BuildAccumulator {
  return { total: 0, succeeded: 0, failed: 0, durationSum: 0, durationCount: 0, waitSum: 0, waitCount: 0, lastBuildAt: null }
}

function addToAccumulator(acc: BuildAccumulator, row: BuildSummaryRow) {
  acc.total += 1
  const outcome = bucketBuildStatus(row.status)
  if (outcome === 'succeeded')
    acc.succeeded += 1
  else if (outcome === 'failed')
    acc.failed += 1

  if (outcome && row.started_at && row.completed_at) {
    const seconds = (new Date(row.completed_at).getTime() - new Date(row.started_at).getTime()) / 1000
    if (Number.isFinite(seconds) && seconds >= 0) {
      acc.durationSum += seconds
      acc.durationCount += 1
    }
  }

  if (row.started_at && row.runner_wait_seconds != null && row.runner_wait_seconds >= 0) {
    acc.waitSum += row.runner_wait_seconds
    acc.waitCount += 1
  }

  if (row.created_at && (!acc.lastBuildAt || row.created_at > acc.lastBuildAt))
    acc.lastBuildAt = row.created_at
}

function toTotals(acc: BuildAccumulator): BuildTotals {
  const finished = acc.succeeded + acc.failed
  return {
    total: acc.total,
    succeeded: acc.succeeded,
    failed: acc.failed,
    inProgress: acc.total - finished,
    successRate: finished > 0 ? (acc.succeeded / finished) * 100 : null,
    avgDurationSeconds: acc.durationCount > 0 ? acc.durationSum / acc.durationCount : null,
    avgWaitSeconds: acc.waitCount > 0 ? acc.waitSum / acc.waitCount : null,
  }
}

// Aggregate build requests into org-wide totals plus a per-app breakdown
// (sorted by build count, busiest app first).
export function summarizeBuilds(rows: BuildSummaryRow[]): { totals: BuildTotals, apps: AppBuildSummary[] } {
  const overall = emptyAccumulator()
  const byApp = new Map<string, BuildAccumulator>()

  for (const row of rows) {
    addToAccumulator(overall, row)
    let appAcc = byApp.get(row.app_id)
    if (!appAcc) {
      appAcc = emptyAccumulator()
      byApp.set(row.app_id, appAcc)
    }
    addToAccumulator(appAcc, row)
  }

  const apps = [...byApp.entries()]
    .map(([appId, acc]) => ({ appId, lastBuildAt: acc.lastBuildAt, ...toTotals(acc) }))
    .sort((a, b) => b.total - a.total || a.appId.localeCompare(b.appId))

  return { totals: toTotals(overall), apps }
}

// Compact human duration (e.g. "45s", "3m 20s", "1h 05m").
export function formatBuildDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds))
    return '-'
  const rounded = Math.round(seconds)
  if (rounded < 60)
    return `${rounded}s`
  const minutes = Math.floor(rounded / 60)
  if (minutes < 60)
    return `${minutes}m ${String(rounded % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}
