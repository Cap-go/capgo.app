import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildRegistrationComparisonWindows,
  buildRegistrationMonthlyComparisonQuery,
  getAdminRegistrationMonthlyComparison,
} from '../supabase/functions/_backend/utils/registration_monthly_comparison.ts'

const { queryMock, closeMock, clientMock } = vi.hoisted(() => ({ queryMock: vi.fn(), closeMock: vi.fn(), clientMock: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({ getPgClient: clientMock, closeClient: closeMock }))
const now = new Date('2026-09-16T12:35:59.999Z')
const context = { get: () => 'registration-comparison-test' } as unknown as Context

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] })
  closeMock.mockReset().mockResolvedValue(undefined)
  clientMock.mockReset().mockReturnValue({ query: queryMock })
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
    expect(buildRegistrationMonthlyComparisonQuery(new Date('2027-01-16T13:35:00Z')).params[2])
      .toContain('2026-09-16 14:35:00')
  })

  it.concurrent('ends shorter months at next local midnight without spilling over', () => {
    const result = buildRegistrationComparisonWindows(new Date('2026-03-31T12:35:00Z'))
    expect(result.windows[1]).toEqual({ month: '2026-02', full_month: true, start_local: '2026-02-01 00:00:00', end_local: '2026-03-01 00:00:00' })
    expect(result.windows[4].end_local).toBe('2025-12-01 00:00:00')
  })

  it.concurrent('handles leap-year February', () => {
    const result = buildRegistrationComparisonWindows(new Date('2028-03-29T12:35:00Z'))
    expect(result.windows[1].full_month).toBe(false)
    expect(result.windows[1].end_local).toBe('2028-02-29 14:35:00')
  })

  it.concurrent('rejects invalid dates before building query parameters', () => {
    expect(() => buildRegistrationMonthlyComparisonQuery(new Date('invalid'))).toThrow('Invalid registration comparison date')
  })
})

describe('registration comparison PostgreSQL', () => {
  it.concurrent('aggregates account records with parameterized, half-open Warsaw windows', () => {
    const { sql, params } = buildRegistrationMonthlyComparisonQuery(now)
    expect(sql).toContain('LEFT JOIN public.users AS account')
    expect(sql).toContain('account.created_via_invite = false')
    expect(sql).toContain('account.created_via_invite = true')
    expect(sql).toContain('account.created_via_invite IS NULL')
    expect(sql).toContain('count(account.id)::bigint AS total')
    expect(sql).toContain('account.created_at >= comparison.starts_at AND account.created_at < comparison.ends_at')
    expect(sql).toContain('unnest($1::text[], $2::text[], $3::text[])')
    expect(sql).toContain('AT TIME ZONE \'Europe/Warsaw\'')
    expect(sql).toContain('CASE WHEN position = 1 THEN $4::timestamptz')
    expect(sql).not.toContain('2026-09')
    expect(sql).not.toContain('events')
    expect(sql).not.toContain('org_users')
    expect(params).toEqual([
      ['2026-09', '2026-08', '2026-07', '2026-06', '2026-05'],
      ['2026-09', '2026-08', '2026-07', '2026-06', '2026-05'].map(month => `${month}-01 00:00:00`),
      ['2026-09', '2026-08', '2026-07', '2026-06', '2026-05'].map(month => `${month}-16 14:35:00`),
      '2026-09-16T12:35:00.000Z',
    ])
  })
})

describe('registration comparison results', () => {
  it('normalizes database counts, fills empty months, and totals disjoint cohorts', async () => {
    queryMock.mockResolvedValue({ rows: [
      { month: '2026-09', self_signup: '4', organization_invite: '2', unknown_other: '1', total: '7' },
      { month: '2026-07', self_signup: 3, organization_invite: 1, unknown_other: 0, total: 4 },
    ] })
    const result = await getAdminRegistrationMonthlyComparison(context, now)
    const query = buildRegistrationMonthlyComparisonQuery(now)
    expect(clientMock).toHaveBeenCalledWith(context)
    expect(queryMock).toHaveBeenCalledExactlyOnceWith(query.sql, query.params)
    expect(closeMock).toHaveBeenCalledExactlyOnceWith(context, { query: queryMock })
    expect(result.months).toHaveLength(5)
    expect(result.months[0]).toEqual({ month: '2026-09', full_month: false, self_signup: 4, organization_invite: 2, unknown_other: 1, total: 7 })
    expect(result.months[1].total).toBe(0)
    expect(result.totals).toEqual({ self_signup: 7, organization_invite: 3, unknown_other: 1, total: 11 })
    expect(result.generated_at).toBe('2026-09-16T12:35:00.000Z')
  })

  it('shows real zeros only after a successful empty query', async () => {
    const result = await getAdminRegistrationMonthlyComparison(context, now)
    expect(result.months.every(month => month.total === 0 && month.unknown_other === 0)).toBe(true)
  })

  it.each(['connection unavailable', 'query timeout'])('propagates %s without fake zeros and closes the client', async (message) => {
    queryMock.mockRejectedValue(new Error(message))
    await expect(getAdminRegistrationMonthlyComparison(context, now)).rejects.toThrow(message)
    expect(closeMock).toHaveBeenCalledOnce()
  })

  it.each([
    { self_signup: -1 },
    { self_signup: '' },
    { self_signup: null },
    { self_signup: 1.5 },
    { self_signup: Number.MAX_SAFE_INTEGER + 1 },
    { unknown_other: null },
    { unknown_other: -1 },
    { total: 99 },
    { month: '2026-10' },
  ])('rejects malformed aggregate rows %j and closes the client', async (override) => {
    queryMock.mockResolvedValue({ rows: [{ month: '2026-09', self_signup: 4, organization_invite: 2, unknown_other: 0, total: 6, ...override }] })
    await expect(getAdminRegistrationMonthlyComparison(context, now)).rejects.toThrow()
    expect(closeMock).toHaveBeenCalledOnce()
  })

  it('rejects duplicate months instead of silently replacing counts', async () => {
    const row = { month: '2026-09', self_signup: 4, organization_invite: 2, unknown_other: 0, total: 6 }
    queryMock.mockResolvedValue({ rows: [row, row] })
    await expect(getAdminRegistrationMonthlyComparison(context, now)).rejects.toThrow('Invalid registration comparison month')
  })
})
