import type { StatsInsightsResult } from './types.ts'

export interface StatsInsightRawSummary {
  total?: unknown
  device_count?: unknown
  action_count?: unknown
}

export interface StatsInsightRawAction {
  action?: unknown
  total?: unknown
  device_count?: unknown
  version_count?: unknown
  first_seen?: unknown
  last_seen?: unknown
  latest_version_name?: unknown
  latest_device_id?: unknown
}

export interface StatsInsightRawDaily {
  date?: unknown
  action?: unknown
  total?: unknown
}

export interface StatsInsightRawVersion {
  action?: unknown
  version_name?: unknown
  total?: unknown
  device_count?: unknown
  last_seen?: unknown
}

export interface StatsInsightRawDevice {
  action?: unknown
  device_id?: unknown
  total?: unknown
  version_name?: unknown
  last_seen?: unknown
}

export interface StatsInsightRawResult {
  summary?: StatsInsightRawSummary | null
  actions?: StatsInsightRawAction[]
  daily?: StatsInsightRawDaily[]
  versions?: StatsInsightRawVersion[]
  devices?: StatsInsightRawDevice[]
}

export function emptyStatsInsights(): StatsInsightsResult {
  return {
    summary: { total: 0, device_count: 0, action_count: 0 },
    actions: [],
    daily: [],
    versions: [],
    devices: [],
  }
}

export function normalizeStatsInsightNumber(value: unknown): number {
  const numeric = Number(value ?? 0)
  return Number.isFinite(numeric) ? numeric : 0
}

export function normalizeStatsInsightDate(value: unknown): string | null {
  if (!value)
    return null
  if (value instanceof Date)
    return value.toISOString()
  if (typeof value !== 'string' && typeof value !== 'number')
    return null

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? `${value}` : date.toISOString()
}

function normalizeStatsInsightString(value: unknown, fallback = ''): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'bigint')
    return fallback

  const text = `${value}`
  return text || fallback
}

export function sortStatsInsightTotals<T extends { total: number }>(items: T[], limit: number): T[] {
  const sortedItems = [...items]
  sortedItems.sort((left, right) => right.total - left.total)
  return sortedItems.slice(0, limit)
}

export function normalizeStatsInsightsResult(raw: StatsInsightRawResult): StatsInsightsResult {
  const summary = raw.summary ?? {}

  return {
    summary: {
      total: normalizeStatsInsightNumber(summary.total),
      device_count: normalizeStatsInsightNumber(summary.device_count),
      action_count: normalizeStatsInsightNumber(summary.action_count),
    },
    actions: (raw.actions ?? []).map(row => ({
      action: normalizeStatsInsightString(row.action),
      total: normalizeStatsInsightNumber(row.total),
      device_count: normalizeStatsInsightNumber(row.device_count),
      version_count: normalizeStatsInsightNumber(row.version_count),
      first_seen: normalizeStatsInsightDate(row.first_seen),
      last_seen: normalizeStatsInsightDate(row.last_seen),
      latest_version_name: normalizeStatsInsightString(row.latest_version_name, 'unknown'),
      latest_device_id: normalizeStatsInsightString(row.latest_device_id),
    })),
    daily: (raw.daily ?? []).map(row => ({
      date: normalizeStatsInsightString(row.date),
      action: normalizeStatsInsightString(row.action),
      total: normalizeStatsInsightNumber(row.total),
    })),
    versions: (raw.versions ?? []).map(row => ({
      action: normalizeStatsInsightString(row.action),
      version_name: normalizeStatsInsightString(row.version_name, 'unknown'),
      total: normalizeStatsInsightNumber(row.total),
      device_count: normalizeStatsInsightNumber(row.device_count),
      last_seen: normalizeStatsInsightDate(row.last_seen),
    })),
    devices: (raw.devices ?? []).map(row => ({
      action: normalizeStatsInsightString(row.action),
      device_id: normalizeStatsInsightString(row.device_id),
      total: normalizeStatsInsightNumber(row.total),
      version_name: normalizeStatsInsightString(row.version_name, 'unknown'),
      last_seen: normalizeStatsInsightDate(row.last_seen),
    })),
  }
}
