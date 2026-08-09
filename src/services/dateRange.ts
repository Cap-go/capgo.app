export type DateRangePreset
  = '30min'
    | '1h'
    | '6h'
    | '12h'
    | '24h'
    | '3day'
    | '7day'
    | '14day'
    | '30day'
    | '90day'
    | 'quarter'
    | '6month'
    | '12month'
    | 'custom'

export type RollingDateRangePreset = Exclude<DateRangePreset, 'custom'>

export type DateRangePresetGroupKey = 'hours' | 'days' | 'months'

export const DEFAULT_DATE_RANGE_PRESET = '24h' as const satisfies RollingDateRangePreset

/** Default rolling window for devices / logs table toolbars. */
export const TABLE_DATE_RANGE_DEFAULT = '30min' as const satisfies RollingDateRangePreset

/** Rolling window lengths for preset modes (ms before `now`). */
export const DATE_RANGE_DURATIONS_MS: Record<RollingDateRangePreset, number> = {
  '30min': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3day': 3 * 24 * 60 * 60 * 1000,
  '7day': 7 * 24 * 60 * 60 * 1000,
  '14day': 14 * 24 * 60 * 60 * 1000,
  '30day': 30 * 24 * 60 * 60 * 1000,
  '90day': 90 * 24 * 60 * 60 * 1000,
  'quarter': 90 * 24 * 60 * 60 * 1000,
  '6month': 180 * 24 * 60 * 60 * 1000,
  '12month': 365 * 24 * 60 * 60 * 1000,
}

/** i18n keys for each rolling preset label. */
export const DATE_RANGE_PRESET_LABEL_KEYS: Record<RollingDateRangePreset, string> = {
  '30min': 'last-30-minutes',
  '1h': 'last-1-hour',
  '6h': 'last-6-hours',
  '12h': 'last-12-hours',
  '24h': 'last-24-hours',
  '3day': '3-days',
  '7day': '7-days',
  '14day': '14-days',
  '30day': '30-days',
  '90day': '90-days',
  'quarter': 'last-quarter',
  '6month': 'last-6-months',
  '12month': 'last-12-months',
}

/** Sidebar groups shown in the Cloudflare-style range picker. */
export const DATE_RANGE_PRESET_GROUPS: { key: DateRangePresetGroupKey, modes: RollingDateRangePreset[] }[] = [
  { key: 'hours', modes: ['30min', '1h', '6h', '12h', '24h'] },
  { key: 'days', modes: ['3day', '7day', '14day', '30day', '90day'] },
  { key: 'months', modes: ['quarter', '6month', '12month'] },
]

export interface DateRangeValue {
  start: Date
  end: Date
}

export function getDateRangeForPreset(
  mode: DateRangePreset,
  now = new Date(),
  custom?: DateRangeValue,
): DateRangeValue {
  if (mode === 'custom') {
    return custom ?? {
      start: new Date(now.getTime() - DATE_RANGE_DURATIONS_MS[DEFAULT_DATE_RANGE_PRESET]),
      end: now,
    }
  }
  return {
    start: new Date(now.getTime() - DATE_RANGE_DURATIONS_MS[mode]),
    end: now,
  }
}

/** Clamp a range into optional min/max bounds. */
export function clampDateRange(
  range: DateRangeValue,
  minDate?: Date | null,
  maxDate?: Date | null,
): DateRangeValue {
  let start = range.start.getTime()
  let end = range.end.getTime()
  if (end < start)
    [start, end] = [end, start]
  if (minDate)
    start = Math.max(start, minDate.getTime())
  if (maxDate)
    end = Math.min(end, maxDate.getTime())
  if (end < start)
    end = start
  return { start: new Date(start), end: new Date(end) }
}

/**
 * Infer a rolling preset when start/end look like "last X ending near now".
 * Falls back to `custom` when no preset matches within tolerance.
 */
export function inferDateRangePreset(
  start: Date,
  end: Date,
  now = new Date(),
  toleranceMs = 2 * 60 * 1000,
): DateRangePreset {
  const endDelta = Math.abs(end.getTime() - now.getTime())
  if (endDelta > toleranceMs)
    return 'custom'

  const duration = end.getTime() - start.getTime()
  if (duration <= 0)
    return 'custom'

  let best: RollingDateRangePreset | null = null
  let bestDelta = Number.POSITIVE_INFINITY
  for (const mode of Object.keys(DATE_RANGE_DURATIONS_MS) as RollingDateRangePreset[]) {
    const delta = Math.abs(DATE_RANGE_DURATIONS_MS[mode] - duration)
    if (delta <= toleranceMs && delta < bestDelta) {
      best = mode
      bestDelta = delta
    }
  }
  return best ?? 'custom'
}

export function isRollingDateRangePreset(value: string): value is RollingDateRangePreset {
  return value in DATE_RANGE_DURATIONS_MS
}

export interface DateRangeQueryParams {
  range?: unknown
  start?: unknown
  end?: unknown
}

export type ParsedDateRangeQuery
  = { mode: RollingDateRangePreset }
    | { mode: 'custom', start: Date, end: Date }

/** Parse `range` (+ optional `start`/`end` for custom) from a route query. */
export function parseDateRangeQuery(query: DateRangeQueryParams): ParsedDateRangeQuery | null {
  const range = typeof query.range === 'string' ? query.range : null
  if (!range)
    return null

  if (range === 'custom') {
    if (typeof query.start !== 'string' || typeof query.end !== 'string')
      return null
    const start = new Date(query.start)
    const end = new Date(query.end)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() < start.getTime())
      return null
    return { mode: 'custom', start, end }
  }

  if (isRollingDateRangePreset(range))
    return { mode: range }

  return null
}

export interface SerializedDateRangeQuery {
  range: DateRangePreset
  start?: string
  end?: string
}

/** Serialize a date-range mode for URL query params. */
export function serializeDateRangeQuery(
  mode: DateRangePreset,
  custom?: DateRangeValue,
): SerializedDateRangeQuery {
  if (mode === 'custom' && custom) {
    return {
      range: 'custom',
      start: custom.start.toISOString(),
      end: custom.end.toISOString(),
    }
  }
  if (mode === 'custom')
    return { range: DEFAULT_DATE_RANGE_PRESET }
  return { range: mode }
}

/**
 * Stable filter identity for table reloads.
 * Rolling presets must NOT embed `now`-based timestamps — those change every
 * call and would reset cursor pagination back to page 1 on each next click.
 */
export function getTableDateRangeSignature(
  mode: DateRangePreset,
  customRange?: [Date, Date] | null,
): { mode: DateRangePreset, start?: string, end?: string } {
  if (mode !== 'custom')
    return { mode }
  if (!customRange?.[0] || !customRange?.[1])
    return { mode: 'custom' }
  return {
    mode: 'custom',
    start: customRange[0].toISOString(),
    end: customRange[1].toISOString(),
  }
}

/**
 * Whether a devices/logs table reload should re-run the expensive count query.
 * Page-only navigation keeps the cached total so 100k+ device apps stay usable.
 */
export function shouldRecountOnTableReload(options: {
  filtersChanged: boolean
  previousPage: number
  requestedPage: number
}): boolean {
  if (options.filtersChanged)
    return true
  return options.previousPage === options.requestedPage
}

/**
 * Time-window pagination used by logs/deployments "Load older".
 * Page 1 is the selected range; page 0 / -1 / … shift one full window backward.
 */
export function getTimeWindowPageRange(
  rangeStartMs: number,
  rangeEndMs: number,
  page: number,
): { rangeStart: number, rangeEnd: number } {
  const timeDifference = rangeEndMs - rangeStartMs
  const pageTimeOffset = timeDifference * (page - 1)
  return {
    rangeStart: rangeStartMs + pageTimeOffset,
    rangeEnd: rangeEndMs + pageTimeOffset,
  }
}
