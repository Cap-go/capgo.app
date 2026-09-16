import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { buildRegistrationMonthlyComparisonQuery } from '../supabase/functions/_backend/utils/registration_monthly_comparison.ts'
import { getPostgresClient } from './test-utils.ts'

// Only the query builder is used here; the real test database pool comes from test-utils.
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({ getPgClient: vi.fn(), closeClient: vi.fn() }))

async function countFixtureAccounts(now: string, accounts: Array<[string, boolean | null]>) {
  const query = buildRegistrationMonthlyComparisonQuery(new Date(now))
  const values = accounts.map((_, index) => {
    const start = 5 + index * 3
    return `($${start}::uuid, $${start + 1}::timestamptz, $${start + 2}::boolean)`
  })
  // Run the production aggregation unchanged, replacing only its input relation with
  // parameterized synthetic records. No persistent data, shared resources, or writes.
  const fixture = accounts.length
    ? `VALUES ${values.join(', ')}`
    : 'SELECT NULL::uuid, NULL::timestamptz, NULL::boolean WHERE false'
  const sql = query.sql.replace('WITH comparison_windows AS MATERIALIZED (', `WITH fixture_accounts(id, created_at, created_via_invite) AS (${fixture}), comparison_windows AS MATERIALIZED (`)
    .replace('LEFT JOIN public.users AS account', 'LEFT JOIN fixture_accounts AS account')
  const pool = await getPostgresClient()
  const result = await pool.query(sql, [...query.params, ...accounts.flatMap(([createdAt, invited]) => [randomUUID(), createdAt, invited])])
  return result.rows.map(row => ({
    month: row.month,
    self_signup: Number(row.self_signup),
    organization_invite: Number(row.organization_invite),
    unknown_other: Number(row.unknown_other),
    total: Number(row.total),
  }))
}

describe('monthly registration comparison PostgreSQL execution', () => {
  it.concurrent('counts accounts and disjoint stored signup sources, not event retries or org joins', async () => {
    const rows = await countFixtureAccounts('2026-09-16T12:35:59.999Z', [
      ['2026-09-02T12:00:00Z', false],
      ['2026-09-03T12:00:00Z', false],
      ['2026-09-04T12:00:00Z', true],
      ['2026-09-05T12:00:00Z', null],
      ['2026-01-03T12:00:00Z', false],
    ])
    expect(rows).toHaveLength(5)
    expect(rows[0]).toEqual({ month: '2026-09', self_signup: 2, organization_invite: 1, unknown_other: 1, total: 4 })
    expect(rows.slice(1).every(row => row.total === 0)).toBe(true)
  })

  it.concurrent('includes exact local starts and excludes exact end cutoffs and future accounts', async () => {
    const rows = await countFixtureAccounts('2026-09-16T12:35:59.999Z', [
      ['2026-07-31T21:59:59.999Z', false],
      ['2026-07-31T22:00:00Z', true],
      ['2026-08-16T12:35:00Z', false],
      ['2026-09-16T12:34:59.999Z', false],
      ['2026-09-16T12:35:00Z', true],
      ['2026-09-16T12:35:59Z', false],
      ['2026-10-01T00:00:00Z', false],
    ])
    expect(rows[0].total).toBe(1)
    expect(rows[1].organization_invite).toBe(1)
    expect(rows.reduce((sum, row) => sum + row.total, 0)).toBe(2)
  })

  it.concurrent('uses each historical month’s winter or summer offset across a year boundary', async () => {
    const rows = await countFixtureAccounts('2027-01-16T13:35:00Z', [
      ['2027-01-16T13:34:59Z', false],
      ['2026-09-16T12:34:59Z', true],
      ['2026-09-16T13:00:00Z', false],
    ])
    expect(rows[0].total).toBe(1)
    expect(rows[4]).toEqual({ month: '2026-09', self_signup: 0, organization_invite: 1, unknown_other: 0, total: 1 })
  })

  it.concurrent('caps shorter months without assigning next-month midnight to the shorter month', async () => {
    const rows = await countFixtureAccounts('2026-03-31T12:35:00Z', [
      ['2026-02-28T22:59:59.999Z', true],
      ['2026-02-28T23:00:00Z', false],
    ])
    expect(rows[0].self_signup).toBe(1)
    expect(rows[1].organization_invite).toBe(1)
    expect(rows[1].self_signup).toBe(0)
  })

  it.concurrent('keeps the current UTC cutoff exact during the repeated Warsaw autumn hour', async () => {
    const rows = await countFixtureAccounts('2026-10-25T00:30:00Z', [
      ['2026-10-25T00:20:00Z', false],
      ['2026-10-25T00:45:00Z', true],
    ])
    expect(rows[0].total).toBe(1)
    expect(rows[0].organization_invite).toBe(0)
  })

  it.concurrent('returns five actual zero months for an empty account relation', async () => {
    const rows = await countFixtureAccounts('2026-09-16T12:35:00Z', [])
    expect(rows).toHaveLength(5)
    expect(rows.every(row => row.total === 0 && row.unknown_other === 0)).toBe(true)
  })
})
