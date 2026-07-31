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

export const DEFAULT_DATE_RANGE_PRESET = '24h' as const satisfies RollingDateRangePreset

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
export const DATE_RANGE_PRESET_GROUPS: { key: string, modes: RollingDateRangePreset[] }[] = [
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
