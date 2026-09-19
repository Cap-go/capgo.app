import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatDateCF, getLastMonthAnalyticsWindow, getLastMonthAnalyticsWindowStart, runQueryToCFA } from '../supabase/functions/_backend/utils/cloudflare.ts'

describe('formatDateCF', () => {
  it.concurrent('normalizes Date objects to a stable UTC SQL timestamp', () => {
    expect(formatDateCF(new Date('2026-03-17T09:08:07.654Z'))).toBe('2026-03-17 09:08:07')
  })

  it.concurrent('normalizes ISO strings with offsets to UTC SQL timestamps', () => {
    expect(formatDateCF('2026-03-17T10:08:07+01:00')).toBe('2026-03-17 09:08:07')
  })
})

describe('analytics engine DateTime conversion', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('preserves missing timestamps instead of converting them to 1970', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ at: null }, { at: '' }, { at: '2026-09-19T12:00:00Z' }],
      meta: [{ name: 'at', type: 'DateTime' }],
      rows: 3,
      rows_before_limit_at_least: 3,
    }), { status: 200 })))
    const context = {
      env: { CF_ANALYTICS_TOKEN: 'test-token', CF_ACCOUNT_ANALYTICS_ID: 'test-account' },
      get: () => 'test-request',
    } as unknown as Context

    expect(await runQueryToCFA<{ at: Date | null }>(context, 'SELECT at')).toEqual([
      { at: null },
      { at: null },
      { at: new Date('2026-09-19T12:00:00Z') },
    ])
  })
})

describe('getLastMonthAnalyticsWindow', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.concurrent('builds deterministic rolling analytics bounds from a snapshot end date', () => {
    expect(getLastMonthAnalyticsWindow(new Date('2026-03-25T00:00:00.000Z'))).toEqual({
      startExpression: 'toDateTime(\'2026-02-23 00:00:00\')',
      endExpression: 'toDateTime(\'2026-03-25 00:00:00\')',
    })
  })

  it.concurrent('exposes the rolling analytics start for matching database fallbacks', () => {
    expect(getLastMonthAnalyticsWindowStart(new Date('2026-03-25T00:00:00.000Z')).toISOString()).toBe('2026-02-23T00:00:00.000Z')
  })

  it('preserves time-of-day for the default rolling analytics lower bound', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-03-25T12:34:56.789Z').getTime())

    expect(getLastMonthAnalyticsWindow()).toEqual({
      startExpression: 'toDateTime(\'2026-02-23 12:34:56\')',
      endExpression: 'now()',
    })
  })
})
