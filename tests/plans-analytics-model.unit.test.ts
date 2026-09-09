import type { LogicalPlansOpening, PlansBehaviorEvent } from '../supabase/functions/_backend/utils/plans_analytics_model.ts'
import { describe, expect, it } from 'vitest'
import {
  attributeCheckoutStarts,
  buildLogicalPlansOpenings,
  buildPlansChartData,
  CHECKOUT_ATTRIBUTION_MS,
  classifyCheckoutCompletion,
} from '../supabase/functions/_backend/utils/plans_analytics_model.ts'

const ms = (value: string) => Date.parse(value)
function event(partial: Partial<PlansBehaviorEvent> & Pick<PlansBehaviorEvent, 'timestampMs' | 'orgId'>): PlansBehaviorEvent {
  return {
    event: 'User visit',
    page: '',
    ...partial,
  }
}

describe('plans analytics model', () => {
  it.concurrent('keeps every exact in-range Plans visit in stable timestamp order', () => {
    const events = [
      event({ timestampMs: ms('2026-08-01T00:00:01Z'), orgId: 'org-a', page: 'plans' }),
      event({ timestampMs: ms('2026-07-31T23:59:59Z'), orgId: 'pre-range', page: 'plans' }),
      event({ timestampMs: ms('2026-08-01T00:00:00Z'), orgId: 'org-a', page: 'plans' }),
      event({ timestampMs: ms('2026-08-01T00:00:01Z'), orgId: 'org-b', page: 'plans' }),
      event({ timestampMs: ms('2026-08-01T10:00:02Z'), orgId: 'empty-page' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-01T10:00:03Z'), orgId: 'checkout', page: 'plans' }),
      event({ timestampMs: ms('2026-08-02T00:00:00Z'), orgId: 'end-exclusive', page: 'plans' }),
    ]

    const openings = buildLogicalPlansOpenings(events, ms('2026-08-01T00:00:00Z'), ms('2026-08-02T00:00:00Z'))

    expect(openings).toEqual([
      event({ timestampMs: ms('2026-08-01T00:00:00Z'), orgId: 'org-a', page: 'plans' }),
      event({ timestampMs: ms('2026-08-01T00:00:01Z'), orgId: 'org-a', page: 'plans' }),
      event({ timestampMs: ms('2026-08-01T00:00:01Z'), orgId: 'org-b', page: 'plans' }),
    ])
    expect(openings.every(opening => !Object.hasOwn(opening, 'source'))).toBe(true)
  })

  it.concurrent('skips non-finite behavior timestamps before opening selection and attribution', () => {
    const openings = buildLogicalPlansOpenings([
      event({ timestampMs: Number.NaN, orgId: 'org-a', page: 'plans' }),
      event({ timestampMs: ms('2026-08-01T10:00:00Z'), orgId: 'org-a', page: 'plans' }),
    ], ms('2026-08-01T00:00:00Z'), ms('2026-08-02T00:00:00Z'))
    const invalidOpening: LogicalPlansOpening = event({ timestampMs: Number.NaN, orgId: 'org-a', page: 'plans' })

    expect(openings).toHaveLength(1)
    expect(openings[0].timestampMs).toBe(ms('2026-08-01T10:00:00Z'))
    expect(attributeCheckoutStarts([invalidOpening, ...openings], [
      event({ event: 'Checkout Started', timestampMs: Number.NaN, orgId: 'org-a' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-01T10:05:00Z'), orgId: 'org-a' }),
    ])).toMatchObject([{
      checkoutTimestampMs: ms('2026-08-01T10:05:00Z'),
      opening: { timestampMs: ms('2026-08-01T10:00:00Z') },
    }])
  })

  it.concurrent('attributes each checkout to the latest preceding same-org opening within 24 hours', () => {
    const openings = buildLogicalPlansOpenings([
      event({ timestampMs: ms('2026-08-01T22:00:00Z'), orgId: 'org-a', page: 'plans' }),
      event({ timestampMs: ms('2026-08-01T23:55:00Z'), orgId: 'org-a', page: 'plans' }),
      event({ timestampMs: ms('2026-08-02T00:00:00Z'), orgId: 'org-b', page: 'plans' }),
    ], ms('2026-08-01T00:00:00Z'), ms('2026-08-03T00:00:00Z'))
    const matches = attributeCheckoutStarts(openings, [
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-02T00:05:00Z'), orgId: 'org-a' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-03T00:00:00Z'), orgId: 'org-b' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-03T00:06:00Z'), orgId: 'org-a' }),
      event({ timestampMs: ms('2026-08-02T00:06:00Z'), orgId: 'org-a', page: 'plans' }),
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
      event({ timestampMs: ms('2026-08-01T08:00:00Z'), orgId: 'org-a', page: 'plans' }),
      event({ timestampMs: ms('2026-08-02T08:00:00Z'), orgId: 'org-a', page: 'plans' }),
      event({ timestampMs: ms('2026-08-02T09:00:00Z'), orgId: 'org-b', page: 'plans' }),
    ], ms('2026-08-01T00:00:00Z'), ms('2026-08-03T00:00:00Z'))
    const matches = attributeCheckoutStarts(openings, [
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-02T08:10:00Z'), orgId: 'org-a' }),
    ])
    const result = buildPlansChartData({
      openings,
      attributedCheckouts: matches,
      startMs: ms('2026-08-01T00:00:00Z'),
      endMs: ms('2026-08-03T00:00:00Z'),
      nowMs: ms('2026-08-10T00:00:00Z'),
      classifyAt: orgId => orgId === 'org-a' ? 'paying' : 'active_trial',
      isCheckoutCompleted: () => false,
    })

    expect(result.traffic.uniqueVisitorOrganizations).toEqual([1, 1])
    expect(result.traffic.totalOpens).toEqual([1, 2])
    expect(result.visitorBreakdown.map(day => day.total)).toEqual([1, 2])
    expect(result.checkoutIntent.map(day => day.startedCheckout + day.didNotStart)).toEqual([1, 2])
    expect(result.checkoutVisitorBreakdown.map(day => day.total)).toEqual([0, 1])
  })

  it.concurrent('deduplicates same-day checkout starts and classifies the earliest attributed opening', () => {
    const openings = buildLogicalPlansOpenings([
      event({ timestampMs: ms('2026-08-01T08:00:00Z'), orgId: 'org-a', page: 'plans' }),
      event({ timestampMs: ms('2026-08-01T12:00:00Z'), orgId: 'org-a', page: 'plans' }),
    ], ms('2026-08-01T00:00:00Z'), ms('2026-08-02T00:00:00Z'))
    const matches = attributeCheckoutStarts(openings, [
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-01T08:05:00Z'), orgId: 'org-a' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-01T12:05:00Z'), orgId: 'org-a' }),
    ])
    const result = buildPlansChartData({
      openings,
      attributedCheckouts: matches,
      startMs: ms('2026-08-01T00:00:00Z'),
      endMs: ms('2026-08-02T00:00:00Z'),
      nowMs: ms('2026-08-10T00:00:00Z'),
      classifyAt: (_orgId, timestampMs) => timestampMs < ms('2026-08-01T10:00:00Z') ? 'expired_trial' : 'credits_only',
      isCheckoutCompleted: () => false,
    })

    expect(result.checkoutIntent).toEqual([{ date: '2026-08-01', startedCheckout: 1, didNotStart: 0 }])
    expect(result.checkoutVisitorBreakdown[0]).toMatchObject({ expiredTrial: 1, creditsOnly: 0, total: 1 })
  })

  it.concurrent('zero-fills intersecting UTC days and uses each graph category timestamp', () => {
    const openings = buildLogicalPlansOpenings([
      event({ timestampMs: ms('2026-08-02T08:00:00Z'), orgId: 'org-a', page: 'plans' }),
      event({ timestampMs: ms('2026-08-02T12:00:00Z'), orgId: 'org-a', page: 'plans' }),
    ], ms('2026-08-01T12:00:00Z'), ms('2026-08-04T06:00:00Z'))
    const matches = attributeCheckoutStarts(openings, [
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-02T12:05:00Z'), orgId: 'org-a' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-02T12:10:00Z'), orgId: 'org-a' }),
    ])
    const classifiedAt: number[] = []
    const result = buildPlansChartData({
      openings,
      attributedCheckouts: matches,
      startMs: ms('2026-08-01T12:00:00Z'),
      endMs: ms('2026-08-04T06:00:00Z'),
      nowMs: ms('2026-08-10T00:00:00Z'),
      classifyAt: (_orgId, timestampMs) => {
        classifiedAt.push(timestampMs)
        return timestampMs < ms('2026-08-02T10:00:00Z') ? 'expired_trial' : 'credits_only'
      },
      isCheckoutCompleted: () => false,
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
    const validOpening: LogicalPlansOpening = event({
      timestampMs: ms('2026-08-01T10:00:00Z'),
      orgId: 'org-a',
      page: 'plans',
    })
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
      nowMs: ms('2026-08-10T00:00:00Z'),
      classifyAt: () => 'unknown',
      isCheckoutCompleted: () => false,
    })

    expect(result.traffic).toEqual({
      dates: ['2026-08-01'],
      uniqueVisitorOrganizations: [1],
      totalOpens: [1],
    })
    expect(result.checkoutIntent).toEqual([{ date: '2026-08-01', startedCheckout: 0, didNotStart: 1 }])
  })

  it.concurrent('classifies checkout completion from billing evidence within the observation window', () => {
    const checkoutAt = ms('2026-08-01T08:05:00Z')
    const completed = classifyCheckoutCompletion(
      checkoutAt,
      ms('2026-08-02T09:00:00Z'),
      timestampMs => timestampMs === checkoutAt && ms('2026-08-01T09:00:00Z') > checkoutAt,
    )
    const pending = classifyCheckoutCompletion(
      checkoutAt,
      ms('2026-08-01T20:00:00Z'),
      () => false,
    )
    const notCompleted = classifyCheckoutCompletion(
      checkoutAt,
      ms('2026-08-03T00:00:00Z'),
      () => false,
    )

    expect(completed).toBe('completed')
    expect(pending).toBe('pending')
    expect(notCompleted).toBe('not_completed')
  })

  it.concurrent('buckets checkout completion on the attributed Plans-opening UTC day', () => {
    const openings = buildLogicalPlansOpenings([
      event({ timestampMs: ms('2026-08-01T08:00:00Z'), orgId: 'org-a', page: 'plans' }),
      event({ timestampMs: ms('2026-08-01T09:00:00Z'), orgId: 'org-b', page: 'plans' }),
      event({ timestampMs: ms('2026-08-02T08:00:00Z'), orgId: 'org-c', page: 'plans' }),
    ], ms('2026-08-01T00:00:00Z'), ms('2026-08-03T00:00:00Z'))
    const matches = attributeCheckoutStarts(openings, [
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-01T08:05:00Z'), orgId: 'org-a' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-01T09:05:00Z'), orgId: 'org-b' }),
      event({ event: 'Checkout Started', timestampMs: ms('2026-08-02T08:05:00Z'), orgId: 'org-c' }),
    ])
    const result = buildPlansChartData({
      openings,
      attributedCheckouts: matches,
      startMs: ms('2026-08-01T00:00:00Z'),
      endMs: ms('2026-08-03T00:00:00Z'),
      nowMs: ms('2026-08-10T00:00:00Z'),
      classifyAt: () => 'active_trial',
      isCheckoutCompleted: (_orgId, checkoutTimestampMs) => checkoutTimestampMs === ms('2026-08-01T08:05:00Z'),
    })

    expect(result.checkoutCompletion).toEqual([
      { date: '2026-08-01', completed: 1, notCompleted: 1, pending: 0 },
      { date: '2026-08-02', completed: 0, notCompleted: 1, pending: 0 },
    ])
    expect(result.checkoutCompletion.map(day => day.completed + day.notCompleted + day.pending)).toEqual([2, 1])
  })
})
