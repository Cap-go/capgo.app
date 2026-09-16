import type { Context } from 'hono'
import { closeClient, getPgClient } from './pg.ts'

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

// Evaluate the five timezone conversions once, not once per candidate account.
export const REGISTRATION_MONTHLY_COMPARISON_SQL = `WITH comparison_windows AS MATERIALIZED (
  SELECT month,
    start_local::timestamp AT TIME ZONE '${REGISTRATION_COMPARISON_TIME_ZONE}' AS starts_at,
    CASE WHEN position = 1 THEN $4::timestamptz
      ELSE end_local::timestamp AT TIME ZONE '${REGISTRATION_COMPARISON_TIME_ZONE}'
    END AS ends_at
  FROM unnest($1::text[], $2::text[], $3::text[])
    WITH ORDINALITY AS boundary(month, start_local, end_local, position)
)
SELECT comparison.month,
  count(account.id) FILTER (WHERE account.created_via_invite = false)::bigint AS self_signup,
  count(account.id) FILTER (WHERE account.created_via_invite = true)::bigint AS organization_invite,
  count(account.id) FILTER (WHERE account.created_via_invite IS NULL)::bigint AS unknown_other,
  count(account.id)::bigint AS total
FROM comparison_windows AS comparison
LEFT JOIN public.users AS account
  ON account.created_at >= comparison.starts_at AND account.created_at < comparison.ends_at
GROUP BY comparison.month
ORDER BY comparison.month DESC`

export function buildRegistrationMonthlyComparisonQuery(now: Date) {
  const { generated_at, windows } = buildRegistrationComparisonWindows(now)
  return {
    sql: REGISTRATION_MONTHLY_COMPARISON_SQL,
    params: [
      windows.map(window => window.month),
      windows.map(window => window.start_local),
      windows.map(window => window.end_local),
      generated_at,
    ],
  }
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
  const query = buildRegistrationMonthlyComparisonQuery(now)
  // Admin-only, aggregate-only reporting uses the primary Supabase database so newly
  // created accounts are not omitted by replica lag. Never use this on plugin hot paths.
  const pgClient = getPgClient(c)
  try {
    const result = await pgClient.query(query.sql, query.params)
    const counts = new Map<string, { self_signup: number, organization_invite: number, unknown_other: number, total: number }>()
    for (const row of result.rows) {
      if (typeof row.month !== 'string' || !windows.some(window => window.month === row.month) || counts.has(row.month))
        throw new Error('Invalid registration comparison month')
      const values = {
        self_signup: registrationCount(row.self_signup),
        organization_invite: registrationCount(row.organization_invite),
        unknown_other: registrationCount(row.unknown_other),
        total: registrationCount(row.total),
      }
      if (values.self_signup + values.organization_invite + values.unknown_other !== values.total)
        throw new Error('Inconsistent registration comparison total')
      counts.set(row.month, values)
    }

    const months = windows.map(({ month, full_month }) => ({
      month,
      full_month,
      ...(counts.get(month) ?? { self_signup: 0, organization_invite: 0, unknown_other: 0, total: 0 }),
    }))
    const totals = months.reduce((sum, month) => ({
      self_signup: sum.self_signup + month.self_signup,
      organization_invite: sum.organization_invite + month.organization_invite,
      unknown_other: sum.unknown_other + month.unknown_other,
      total: sum.total + month.total,
    }), { self_signup: 0, organization_invite: 0, unknown_other: 0, total: 0 })
    return { ...metadata, months, totals }
  }
  finally {
    await closeClient(c, pgClient)
  }
}
