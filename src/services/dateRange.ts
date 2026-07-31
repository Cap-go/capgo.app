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

export const DEFAULT_DATE_RANGE_PRESET = '24h' as const satisfies Exclude<DateRangePreset, 'custom'>

/** Rolling window lengths for preset modes (ms before `now`). */
export const DATE_RANGE_DURATIONS_MS: Record<Exclude<DateRangePreset, 'custom'>, number> = {
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
