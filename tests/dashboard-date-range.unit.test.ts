import { describe, expect, it } from 'vitest'
import { normalizeDashboardDateRange } from '~/services/supabase'

function createFallbackWindow(now: Date) {
  const end = new Date(now)
  end.setUTCHours(0, 0, 0, 0)
  end.setUTCDate(end.getUTCDate() + 1)

  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 30)

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  }
}

describe('dashboard date range normalization', () => {
  it.concurrent('keeps valid explicit dates unchanged', () => {
    const normalized = normalizeDashboardDateRange(
      '2026-04-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
      new Date('2026-04-21T12:00:00.000Z'),
    )

    expect(normalized).toEqual({
      start: '2026-04-01T00:00:00.000Z',
      end: '2026-05-01T00:00:00.000Z',
    })
  })

  it.concurrent('falls back to the last 30-day window when dates are omitted', () => {
    const now = new Date('2026-04-21T15:45:00.000Z')

    expect(normalizeDashboardDateRange(undefined, undefined, now)).toEqual(createFallbackWindow(now))
  })

  it.concurrent('uses UTC day boundaries so Europe and Brazil share the same fallback window', () => {
    // Same UTC instant: afternoon UTC on Apr 21
    const now = new Date('2026-04-21T15:45:00.000Z')
    const window = normalizeDashboardDateRange(undefined, undefined, now)

    // UTC today is Apr 21 → exclusive end is Apr 22 00:00Z; start is 30 days before that
    expect(window).toEqual({
      start: '2026-03-23T00:00:00.000Z',
      end: '2026-04-22T00:00:00.000Z',
    })
  })

  it.concurrent('falls back to the default window when either bound is invalid', () => {
    const now = new Date('2026-04-21T15:45:00.000Z')
    expect(normalizeDashboardDateRange('not-a-date', '2026-04-30T00:00:00.000Z', now)).toEqual(createFallbackWindow(now))
    expect(normalizeDashboardDateRange('2026-04-01T00:00:00.000Z', 'still-not-a-date', now)).toEqual(createFallbackWindow(now))
    expect(normalizeDashboardDateRange('2026-02-31T00:00:00.000Z', '2026-04-30T00:00:00.000Z', now)).toEqual(createFallbackWindow(now))
  })

  it.concurrent('falls back to the default window when the resolved range is inverted', () => {
    const now = new Date('2026-04-21T15:45:00.000Z')

    expect(normalizeDashboardDateRange('2026-05-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', now)).toEqual(createFallbackWindow(now))
  })
})
