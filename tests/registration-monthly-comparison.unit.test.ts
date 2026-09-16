import type { Context } from 'hono'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildRegistrationComparisonWindows,
  buildRegistrationMonthlyComparisonHogql,
  getAdminRegistrationMonthlyComparison,
} from '../supabase/functions/_backend/utils/registration_monthly_comparison.ts'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/posthog_read.ts', () => ({ queryPosthogHogql: queryMock }))
const now = new Date('2026-09-16T12:35:59.999Z')
const context = { get: () => 'registration-comparison-test' } as unknown as Context

beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ configured: true, connected: true, failureReason: null, rows: [] })
})

describe('registration comparison calendar windows', () => {
  it.concurrent('matches the current Warsaw day and minute across five months', () => {
    const result = buildRegistrationComparisonWindows(now)
    expect(result.generated_at).toBe('2026-09-16T12:35:00.000Z')
    expect(result.cutoff_day).toBe(16)
    expect(result.cutoff_time).toBe('14:35')
    expect(result.time_zone).toBe('Europe/Warsaw')
    expect(result.windows.map(window => window.month)).toEqual(['2026-09', '2026-08', '2026-07', '2026-06', '2026-05'])
    for (const window of result.windows) {
      expect(window.start_local).toBe(`${window.month}-01 00:00:00`)
      expect(window.end_local).toBe(`${window.month}-16 14:35:00`)
      expect(window.full_month).toBe(false)
    }
  })

  it.concurrent('uses Warsaw rather than the UTC calendar around local midnight', () => {
    const result = buildRegistrationComparisonWindows(new Date('2026-08-31T22:01:30Z'))
    expect(result.windows[0].month).toBe('2026-09')
    expect(result.cutoff_day).toBe(1)
    expect(result.cutoff_time).toBe('00:01')
  })

  it.concurrent('uses the winter offset and crosses the year boundary', () => {
    const result = buildRegistrationComparisonWindows(new Date('2027-01-16T13:35:00Z'))
    expect(result.cutoff_time).toBe('14:35')
    expect(result.windows.map(window => window.month)).toEqual(['2027-01', '2026-12', '2026-11', '2026-10', '2026-09'])
    expect(buildRegistrationMonthlyComparisonHogql(new Date('2027-01-16T13:35:00Z')))
      .toContain('toDateTime(\'2026-09-16 14:35:00\', \'Europe/Warsaw\')')
  })

  it.concurrent('ends shorter months at next local midnight without spilling over', () => {
    const result = buildRegistrationComparisonWindows(new Date('2026-03-31T12:35:00Z'))
    expect(result.windows[1]).toEqual({
      month: '2026-02',
      full_month: true,
      start_local: '2026-02-01 00:00:00',
      end_local: '2026-03-01 00:00:00',
    })
    expect(result.windows[4].end_local).toBe('2025-12-01 00:00:00')
  })

  it.concurrent('handles leap-year February', () => {
    const result = buildRegistrationComparisonWindows(new Date('2028-03-29T12:35:00Z'))
    expect(result.windows[1].full_month).toBe(false)
    expect(result.windows[1].end_local).toBe('2028-02-29 14:35:00')
  })

  it.concurrent('rejects invalid dates before building query literals', () => {
    expect(() => buildRegistrationMonthlyComparisonHogql(new Date('invalid'))).toThrow('Invalid registration comparison date')
  })
})

describe('registration comparison HogQL', () => {
  it.concurrent('deduplicates people before calendar filtering and source attribution', () => {
    const query = buildRegistrationMonthlyComparisonHogql(now)
    expect(query).toContain('event IN (\'User Joined\', \'User Joined by Invite\')')
    expect(query).toContain('GROUP BY person_id')
    expect(query).toContain('min(timestamp) AS registered_at, argMin(event, timestamp) AS signup_event')
    expect(query).toContain('registered_at >= toDateTime(\'2026-05-01 00:00:00\', \'Europe/Warsaw\')')
    expect(query).not.toContain('timestamp >=')
    expect(query).toContain('timestamp < parseDateTimeBestEffort(\'2026-09-16T12:35:00.000Z\')')
    expect(query).toContain('registered_at < toDateTime(\'2026-08-16 14:35:00\', \'Europe/Warsaw\')')
    expect(query).toContain('registered_at < parseDateTimeBestEffort(\'2026-09-16T12:35:00.000Z\')')
    expect(query).toContain('count() AS total')
    expect(query).toContain('LIMIT 5')
    expect(query).not.toContain('$host')
    expect(query).not.toContain('person.properties')
    expect(query).not.toContain('created_at')
  })

  it.concurrent('does not turn an earlier signup with an in-window retry into a new registration', () => {
    const query = buildRegistrationMonthlyComparisonHogql(now)
    // Execute the actual first-timestamp subquery. Source attribution is omitted because
    // SQLite lacks ClickHouse argMin; its value is irrelevant to this timestamp regression.
    const firstRegistrationQuery = query.slice(query.indexOf('SELECT person_id,'), query.indexOf('\n)'))
      .replace(', argMin(event, timestamp) AS signup_event', '')
    const db = new DatabaseSync(':memory:')
    try {
      db.function('parseDateTimeBestEffort', value => String(value))
      // All five fixture month boundaries use Warsaw's summer UTC+02:00 offset.
      db.function('toDateTime', (value, timeZone) => {
        if (timeZone !== 'Europe/Warsaw')
          throw new Error('Unexpected fixture time zone')
        return new Date(`${String(value).replace(' ', 'T')}+02:00`).toISOString()
      })
      db.exec('CREATE TABLE events (person_id TEXT, timestamp TEXT, event TEXT)')
      const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?)')
      insert.run('earlier-registration', '2026-01-05T12:00:00.000Z', 'User Joined')
      insert.run('earlier-registration', '2026-06-03T12:00:00.000Z', 'User Joined by Invite')
      insert.run('new-registration', '2026-06-03T12:00:00.000Z', 'User Joined')
      insert.run('new-registration', '2026-06-05T12:00:00.000Z', 'User Joined')
      insert.run('future-registration', '2026-10-03T12:00:00.000Z', 'User Joined')
      const rows = db.prepare(firstRegistrationQuery).all()
      expect(rows).toHaveLength(2)
      expect(rows.find(row => row.person_id === 'earlier-registration')?.registered_at).toBe('2026-01-05T12:00:00.000Z')
      expect(rows.filter(row => String(row.registered_at) >= '2026-05-01T00:00:00.000Z')
        .map(row => row.person_id)).toEqual(['new-registration'])
    }
    finally {
      db.close()
    }
  })
})

describe('registration comparison results', () => {
  it('normalizes counts, fills empty months, and totals disjoint monthly cohorts', async () => {
    queryMock.mockResolvedValue({ configured: true, connected: true, failureReason: null, rows: [
      { month: '2026-09', self_signup: '4', organization_invite: '2', total: '6' },
      { month: '2026-07', self_signup: 3, organization_invite: 1, total: 4 },
    ] })
    const result = await getAdminRegistrationMonthlyComparison(context, now)
    expect(queryMock).toHaveBeenCalledOnce()
    expect(queryMock).toHaveBeenCalledWith(context, buildRegistrationMonthlyComparisonHogql(now))
    expect(result.months).toHaveLength(5)
    expect(result.months[0]).toEqual({ month: '2026-09', full_month: false, self_signup: 4, organization_invite: 2, total: 6, unknown_other: null })
    expect(result.months[1].total).toBe(0)
    expect(result.totals).toEqual({ self_signup: 7, organization_invite: 3, total: 10, unknown_other: null })
    expect(result.generated_at).toBe('2026-09-16T12:35:00.000Z')
  })

  it('shows real zeros only after a successful empty query', async () => {
    const result = await getAdminRegistrationMonthlyComparison(context, now)
    expect(result.months.every(month => month.total === 0 && month.unknown_other === null)).toBe(true)
  })

  it.each(['unconfigured', 'timeout', 'unavailable', 'too_large'])('does not return fake zero counts on %s', async (failureReason) => {
    queryMock.mockResolvedValue({ configured: failureReason !== 'unconfigured', connected: failureReason === 'too_large', failureReason, rows: [] })
    await expect(getAdminRegistrationMonthlyComparison(context, now)).rejects.toThrow('PostHog query failed')
  })

  it.each([
    { self_signup: -1 },
    { self_signup: '' },
    { self_signup: null },
    { self_signup: 1.5 },
    { self_signup: Number.MAX_SAFE_INTEGER + 1 },
    { total: 99 },
    { month: '2026-10' },
  ])('rejects malformed aggregate rows %j', async (override) => {
    queryMock.mockResolvedValue({ configured: true, connected: true, failureReason: null, rows: [
      { month: '2026-09', self_signup: 4, organization_invite: 2, total: 6, ...override },
    ] })
    await expect(getAdminRegistrationMonthlyComparison(context, now)).rejects.toThrow()
  })

  it('rejects duplicate months instead of silently replacing counts', async () => {
    const row = { month: '2026-09', self_signup: 4, organization_invite: 2, total: 6 }
    queryMock.mockResolvedValue({ configured: true, connected: true, failureReason: null, rows: [row, row] })
    await expect(getAdminRegistrationMonthlyComparison(context, now)).rejects.toThrow('Invalid registration comparison month')
  })
})
