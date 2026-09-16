import type { Context } from 'hono'
import { queryPosthogHogql } from './posthog_read.ts'

export const REGISTRATION_COMPARISON_TIME_ZONE = 'Europe/Warsaw'
export const REGISTRATION_COMPARISON_MONTHS = 5

export function buildRegistrationComparisonWindows(now: Date) {
  if (!Number.isFinite(now.getTime()))
    throw new RangeError('Invalid registration comparison date')

  const generatedAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString()
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: REGISTRATION_COMPARISON_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(generatedAt))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)!.value
  const day = Number(part('day'))
  const cutoffTime = `${part('hour')}:${part('minute')}`
  const windows = Array.from({ length: REGISTRATION_COMPARISON_MONTHS }, (_, offset) => {
    const date = new Date(Date.UTC(Number(part('year')), Number(part('month')) - 1 - offset, 1))
    const month = date.toISOString().slice(0, 7)
    const nextMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
    const daysInMonth = new Date(nextMonth.getTime() - 86_400_000).getUTCDate()
    // A shorter month contributes its entire month, rather than spilling into the next one.
    const fullMonth = day > daysInMonth
    return {
      month,
      full_month: fullMonth,
      start_local: `${month}-01 00:00:00`,
      end_local: fullMonth
        ? `${nextMonth.toISOString().slice(0, 10)} 00:00:00`
        : `${month}-${String(day).padStart(2, '0')} ${cutoffTime}:00`,
    }
  })
  return { generated_at: generatedAt, time_zone: REGISTRATION_COMPARISON_TIME_ZONE, cutoff_day: day, cutoff_time: cutoffTime, windows }
}

export function buildRegistrationMonthlyComparisonHogql(now: Date) {
  const { generated_at, windows } = buildRegistrationComparisonWindows(now)
  const localDate = (value: string) => `toDateTime('${value}', '${REGISTRATION_COMPARISON_TIME_ZONE}')`
  const filters = windows.map((window, index) => `(
      registered_at >= ${localDate(window.start_local)}
      AND registered_at < ${index === 0 ? `parseDateTimeBestEffort('${generated_at}')` : localDate(window.end_local)}
    )`).join('\n    OR ')

  // Backend registration events have no browser host; do not apply the frontend host filter.
  // First-event attribution keeps retries and overlapping source events from counting a person twice.
  return `SELECT
  substring(toString(toTimeZone(registered_at, '${REGISTRATION_COMPARISON_TIME_ZONE}')), 1, 7) AS month,
  countIf(signup_event = 'User Joined') AS self_signup,
  countIf(signup_event = 'User Joined by Invite') AS organization_invite,
  count() AS total
FROM (
  SELECT person_id, min(timestamp) AS registered_at, argMin(event, timestamp) AS signup_event
  FROM events
  WHERE timestamp >= ${localDate(windows[windows.length - 1].start_local)}
    AND timestamp < parseDateTimeBestEffort('${generated_at}')
    AND event IN ('User Joined', 'User Joined by Invite')
  GROUP BY person_id
)
WHERE ${filters}
GROUP BY month
ORDER BY month DESC
LIMIT ${REGISTRATION_COMPARISON_MONTHS}`
}

function registrationCount(value: unknown): number {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value)))
    throw new Error('Invalid registration comparison count')
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error('Invalid registration comparison count')
  return count
}

export async function getAdminRegistrationMonthlyComparison(c: Context, now = new Date()) {
  const { windows, ...metadata } = buildRegistrationComparisonWindows(now)
  const posthog = await queryPosthogHogql(c, buildRegistrationMonthlyComparisonHogql(now))
  if (!posthog.configured || !posthog.connected || posthog.failureReason !== null)
    throw new Error('Registration comparison PostHog query failed')

  const counts = new Map<string, { self_signup: number, organization_invite: number, total: number }>()
  for (const row of posthog.rows) {
    if (typeof row.month !== 'string' || !windows.some(window => window.month === row.month) || counts.has(row.month))
      throw new Error('Invalid registration comparison month')
    const values = {
      self_signup: registrationCount(row.self_signup),
      organization_invite: registrationCount(row.organization_invite),
      total: registrationCount(row.total),
    }
    if (values.self_signup + values.organization_invite !== values.total)
      throw new Error('Inconsistent registration comparison total')
    counts.set(row.month, values)
  }

  const months = windows.map(({ month, full_month }) => ({
    month,
    full_month,
    ...(counts.get(month) ?? { self_signup: 0, organization_invite: 0, total: 0 }),
    // There is no separate event for unclassified registrations or accounts missing tracking.
    unknown_other: null,
  }))
  const totals = months.reduce((sum, month) => ({
    self_signup: sum.self_signup + month.self_signup,
    organization_invite: sum.organization_invite + month.organization_invite,
    total: sum.total + month.total,
  }), { self_signup: 0, organization_invite: 0, total: 0 })
  return { ...metadata, months, totals: { ...totals, unknown_other: null } }
}
