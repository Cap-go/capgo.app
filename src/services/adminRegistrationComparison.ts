export interface RegistrationComparisonCounts {
  self_signup: number
  organization_invite: number
  unknown_other: number | null
  total: number
}

export interface RegistrationMonthlyComparison {
  source: 'supabase'
  generated_at: string
  time_zone: 'Europe/Warsaw'
  cutoff_day: number
  cutoff_time: string
  months: Array<RegistrationComparisonCounts & { month: string, full_month: boolean }>
  totals: RegistrationComparisonCounts
}

export function formatRegistrationComparisonMonth(month: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${month}-01T00:00:00Z`))
}
