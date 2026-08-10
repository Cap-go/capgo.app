import type { LogicalPlansOpening, PlansBehaviorEvent } from '../supabase/functions/_backend/utils/plans_analytics_model.ts'
import { describe, expect, it } from 'vitest'
import {
  attributeCheckoutStarts,
  buildLogicalPlansOpenings,
  buildPlansChartData,
  CHECKOUT_ATTRIBUTION_MS,
  LEGACY_BURST_SECONDS,

} from '../supabase/functions/_backend/utils/plans_analytics_model.ts'

const ms = (value: string) => Date.parse(value)
function event(partial: Partial<PlansBehaviorEvent> & Pick<PlansBehaviorEvent, 'timestampMs' | 'orgId'>): PlansBehaviorEvent {
  return {
    actorId: 'user-a',
    event: 'User visit',
    page: '',
    path: '/settings/organization/plans',
    sessionId: '',
    ...partial,
  }
}

describe('plans analytics model', () => {
  it.concurrent('collapses only legacy bursts and preserves exact repeat openings', () => {
    const events = [
      event({ timestampMs: ms('2026-08-01T10:00:00Z'), orgId: 'org-a' }),
      event({ timestampMs: ms('2026-08-01T10:00:08Z'), orgId: 'org-a' }),
      event({ timestampMs: ms('2026-08-01T10:05:00Z'), orgId: 'org-a' }),
      event({ timestampMs: ms('2026-08-01T11:00:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
      event({ timestampMs: ms('2026-08-01T11:00:02Z'), orgId: 'org-a', page: 'plans', path: '' }),
    ]

    const openings = buildLogicalPlansOpenings(events, ms('2026-08-01T00:00:00Z'), ms('2026-08-02T00:00:00Z'))

    expect(LEGACY_BURST_SECONDS).toBe(30)
    expect(openings.map(opening => [opening.timestampMs, opening.source])).toEqual([
      [ms('2026-08-01T10:00:00Z'), 'legacy'],
      [ms('2026-08-01T10:05:00Z'), 'legacy'],
      [ms('2026-08-01T11:00:00Z'), 'exact'],
      [ms('2026-08-01T11:00:02Z'), 'exact'],
    ])
  })

  it.concurrent('repairs boundary bursts and prefers session identity over actor fallback', () => {
    const events = [
      event({ timestampMs: ms('2026-07-31T23:59:50Z'), orgId: 'org-a', actorId: 'user-a' }),
      event({ timestampMs: ms('2026-08-01T00:00:05Z'), orgId: 'org-a', actorId: 'user-a' }),
      event({ timestampMs: ms('2026-08-01T00:00:05Z'), orgId: 'org-a', actorId: 'user-b' }),
      event({ timestampMs: ms('2026-08-01T01:00:00Z'), orgId: 'org-a', actorId: 'shared', sessionId: 'session-a' }),
      event({ timestampMs: ms('2026-08-01T01:00:08Z'), orgId: 'org-a', actorId: 'shared', sessionId: 'session-b' }),
      event({ timestampMs: ms('2026-08-01T01:00:10Z'), orgId: 'org-a', actorId: 'different', sessionId: 'session-a' }),
    ]

    const openings = buildLogicalPlansOpenings(events, ms('2026-08-01T00:00:00Z'), ms('2026-08-02T00:00:00Z'))

    expect(openings.map(opening => [opening.timestampMs, opening.actorId, opening.sessionId])).toEqual([
      [ms('2026-08-01T00:00:05Z'), 'user-b', ''],
      [ms('2026-08-01T01:00:00Z'), 'shared', 'session-a'],
      [ms('2026-08-01T01:00:08Z'), 'shared', 'session-b'],
    ])
  })

  it.concurrent('normalizes only the legacy Plans path and ignores unrelated events', () => {
    const events = [
      event({ timestampMs: ms('2026-08-01T10:00:00Z'), orgId: 'org-a', path: 'https://console.capgo.app/settings/organization/plans/?tab=billing#top' }),
      event({ timestampMs: ms('2026-08-01T10:01:00Z'), orgId: 'org-a', path: '/settings/organization/plans-extra' }),
      event({ timestampMs: ms('2026-08-01T10:02:00Z'), orgId: 'org-a', path: 'http://[::1' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-01T10:03:00Z'), orgId: 'org-a' }),
      event({ timestampMs: ms('2026-08-01T10:04:00Z'), orgId: 'org-a', page: 'Plans', path: '' }),
    ]

    expect(buildLogicalPlansOpenings(events, ms('2026-08-01T00:00:00Z'), ms('2026-08-02T00:00:00Z')))
      .toMatchObject([{ timestampMs: ms('2026-08-01T10:00:00Z'), source: 'legacy' }])
  })

  it.concurrent('skips non-finite behavior timestamps before repair and attribution', () => {
    const openings = buildLogicalPlansOpenings([
      event({ timestampMs: Number.NaN, orgId: 'org-a' }),
      event({ timestampMs: ms('2026-08-01T10:00:00Z'), orgId: 'org-a' }),
    ], ms('2026-08-01T00:00:00Z'), ms('2026-08-02T00:00:00Z'))
    const invalidOpening: LogicalPlansOpening = {
      ...event({ timestampMs: Number.NaN, orgId: 'org-a', page: 'plans', path: '' }),
      source: 'exact',
    }

    expect(openings).toHaveLength(1)
    expect(openings[0].timestampMs).toBe(ms('2026-08-01T10:00:00Z'))
    expect(attributeCheckoutStarts([invalidOpening, ...openings], [
      event({ event: 'Checkout Started', timestampMs: Number.NaN, orgId: 'org-a', path: '' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-01T10:05:00Z'), orgId: 'org-a', path: '' }),
    ])).toMatchObject([{
      checkoutTimestampMs: ms('2026-08-01T10:05:00Z'),
      opening: { timestampMs: ms('2026-08-01T10:00:00Z') },
    }])
  })

  it.concurrent('attributes each checkout to the latest preceding same-org opening within 24 hours', () => {
    const openings = buildLogicalPlansOpenings([
      event({ timestampMs: ms('2026-08-01T22:00:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
      event({ timestampMs: ms('2026-08-01T23:55:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
      event({ timestampMs: ms('2026-08-02T00:00:00Z'), orgId: 'org-b', page: 'plans', path: '' }),
    ], ms('2026-08-01T00:00:00Z'), ms('2026-08-03T00:00:00Z'))
    const matches = attributeCheckoutStarts(openings, [
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-02T00:05:00Z'), orgId: 'org-a', path: '' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-03T00:00:00Z'), orgId: 'org-b', path: '' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-03T00:06:00Z'), orgId: 'org-a', path: '' }),
      event({ timestampMs: ms('2026-08-02T00:06:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
    ])

    expect(CHECKOUT_ATTRIBUTION_MS).toBe(24 * 60 * 60 * 1000)
    expect(matches.map(match => ({
      attributedDate: match.attributedDate,
      checkoutTimestampMs: match.checkoutTimestampMs,
      openingTimestampMs: match.opening.timestampMs,
      orgId: match.orgId,
    }))).toEqual([
      {
        attributedDate: '2026-08-01',
        checkoutTimestampMs: ms('2026-08-02T00:05:00Z'),
        openingTimestampMs: ms('2026-08-01T23:55:00Z'),
        orgId: 'org-a',
      },
      {
        attributedDate: '2026-08-02',
        checkoutTimestampMs: ms('2026-08-03T00:00:00Z'),
        openingTimestampMs: ms('2026-08-02T00:00:00Z'),
        orgId: 'org-b',
      },
    ])
  })

  it.concurrent('keeps range-wide uniques distinct from daily uniques and reconciles graph totals', () => {
    const openings = buildLogicalPlansOpenings([
      event({ timestampMs: ms('2026-08-01T08:00:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
      event({ timestampMs: ms('2026-08-02T08:00:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
      event({ timestampMs: ms('2026-08-02T09:00:00Z'), orgId: 'org-b', page: 'plans', path: '' }),
    ], ms('2026-08-01T00:00:00Z'), ms('2026-08-03T00:00:00Z'))
    const matches = attributeCheckoutStarts(openings, [
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-02T08:10:00Z'), orgId: 'org-a', path: '' }),
    ])
    const result = buildPlansChartData({
      openings,
      attributedCheckouts: matches,
      startMs: ms('2026-08-01T00:00:00Z'),
      endMs: ms('2026-08-03T00:00:00Z'),
      classifyAt: orgId => orgId === 'org-a' ? 'paying' : 'active_trial',
    })

    expect(result.traffic.uniqueVisitorOrganizations).toEqual([1, 1])
    expect(result.traffic.totalOpens).toEqual([1, 2])
    expect(result.visitorBreakdown.map(day => day.total)).toEqual([1, 2])
    expect(result.checkoutIntent.map(day => day.startedCheckout + day.didNotStart)).toEqual([1, 2])
    expect(result.checkoutVisitorBreakdown.map(day => day.total)).toEqual([0, 1])
  })

  it.concurrent('deduplicates same-day checkout starts and classifies the earliest attributed opening', () => {
    const openings = buildLogicalPlansOpenings([
      event({ timestampMs: ms('2026-08-01T08:00:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
      event({ timestampMs: ms('2026-08-01T12:00:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
    ], ms('2026-08-01T00:00:00Z'), ms('2026-08-02T00:00:00Z'))
    const matches = attributeCheckoutStarts(openings, [
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-01T08:05:00Z'), orgId: 'org-a', path: '' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-01T12:05:00Z'), orgId: 'org-a', path: '' }),
    ])
    const result = buildPlansChartData({
      openings,
      attributedCheckouts: matches,
      startMs: ms('2026-08-01T00:00:00Z'),
      endMs: ms('2026-08-02T00:00:00Z'),
      classifyAt: (_orgId, timestampMs) => timestampMs < ms('2026-08-01T10:00:00Z') ? 'expired_trial' : 'credits_only',
    })

    expect(result.checkoutIntent).toEqual([{ date: '2026-08-01', startedCheckout: 1, didNotStart: 0 }])
    expect(result.checkoutVisitorBreakdown[0]).toMatchObject({ expiredTrial: 1, creditsOnly: 0, total: 1 })
  })

  it.concurrent('zero-fills intersecting UTC days and uses each graph category timestamp', () => {
    const openings = buildLogicalPlansOpenings([
      event({ timestampMs: ms('2026-08-02T08:00:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
      event({ timestampMs: ms('2026-08-02T12:00:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
    ], ms('2026-08-01T12:00:00Z'), ms('2026-08-04T06:00:00Z'))
    const matches = attributeCheckoutStarts(openings, [
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-02T12:05:00Z'), orgId: 'org-a', path: '' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-02T12:10:00Z'), orgId: 'org-a', path: '' }),
    ])
    const classifiedAt: number[] = []
    const result = buildPlansChartData({
      openings,
      attributedCheckouts: matches,
      startMs: ms('2026-08-01T12:00:00Z'),
      endMs: ms('2026-08-04T06:00:00Z'),
      classifyAt: (_orgId, timestampMs) => {
        classifiedAt.push(timestampMs)
        return timestampMs < ms('2026-08-02T10:00:00Z') ? 'expired_trial' : 'credits_only'
      },
    })

    expect(result.traffic).toEqual({
      dates: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'],
      uniqueVisitorOrganizations: [0, 1, 0, 0],
      totalOpens: [0, 2, 0, 0],
    })
    expect(result.visitorBreakdown[1]).toMatchObject({ expiredTrial: 1, total: 1 })
    expect(result.checkoutIntent[1]).toEqual({ date: '2026-08-02', startedCheckout: 1, didNotStart: 0 })
    expect(result.checkoutVisitorBreakdown[1]).toMatchObject({ creditsOnly: 1, total: 1 })
    expect(classifiedAt).toEqual([
      ms('2026-08-02T08:00:00Z'),
      ms('2026-08-02T12:00:00Z'),
    ])
  })

  it.concurrent('skips non-finite chart timestamps before bucketing checkout intent', () => {
    const validOpening: LogicalPlansOpening = {
      ...event({ timestampMs: ms('2026-08-01T10:00:00Z'), orgId: 'org-a', page: 'plans', path: '' }),
      source: 'exact',
    }
    const invalidOpening: LogicalPlansOpening = { ...validOpening, timestampMs: Number.NaN }

    const result = buildPlansChartData({
      openings: [invalidOpening, validOpening],
      attributedCheckouts: [{
        attributedDate: '2026-08-01',
        checkoutTimestampMs: Number.NaN,
        opening: validOpening,
        orgId: 'org-a',
      }],
      startMs: ms('2026-08-01T00:00:00Z'),
      endMs: ms('2026-08-02T00:00:00Z'),
      classifyAt: () => 'unknown',
    })

    expect(result.traffic).toEqual({
      dates: ['2026-08-01'],
      uniqueVisitorOrganizations: [1],
      totalOpens: [1],
    })
    expect(result.checkoutIntent).toEqual([{ date: '2026-08-01', startedCheckout: 0, didNotStart: 1 }])
  })
})
