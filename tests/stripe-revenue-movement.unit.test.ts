import { describe, expect, it } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'

const plans = [
  {
    name: 'Solo',
    stripe_id: 'prod_solo',
    price_m: 12,
    price_m_id: 'price_solo_monthly',
    price_y: 120,
    price_y_id: 'price_solo_yearly',
  },
  {
    name: 'Team',
    stripe_id: 'prod_team',
    price_m: 49,
    price_m_id: 'price_team_monthly',
    price_y: 468,
    price_y_id: 'price_team_yearly',
  },
] as const

describe('stripe revenue movement classification', () => {
  it.concurrent('records first-time subscriptions as new business MRR', () => {
    expect(stripeEventTestUtils.classifyRevenueMovement(
      {
        paid_at: null,
        price_id: null,
        product_id: null,
        status: 'created',
      },
      {
        is_good_plan: true,
        paid_at: '2026-04-22T12:00:00.000Z',
        price_id: 'price_solo_monthly',
        product_id: 'prod_solo',
        status: 'succeeded',
      },
      plans as any,
    )).toMatchObject({
      currentMrr: 0,
      nextMrr: 12,
      newBusinessMrr: 12,
      expansionMrr: 0,
      contractionMrr: 0,
      churnMrr: 0,
    })
  })

  it.concurrent('records paid upgrades as expansion MRR', () => {
    expect(stripeEventTestUtils.classifyRevenueMovement(
      {
        is_good_plan: true,
        paid_at: '2026-04-01T00:00:00.000Z',
        price_id: 'price_solo_monthly',
        product_id: 'prod_solo',
        status: 'succeeded',
      },
      {
        is_good_plan: true,
        paid_at: '2026-04-01T00:00:00.000Z',
        price_id: 'price_team_monthly',
        product_id: 'prod_team',
        status: 'succeeded',
      },
      plans as any,
    )).toMatchObject({
      currentMrr: 12,
      nextMrr: 49,
      expansionMrr: 37,
      newBusinessMrr: 0,
      contractionMrr: 0,
      churnMrr: 0,
    })
  })

  it.concurrent('tracks monthly to yearly cadence upgrades for admin metrics even when MRR stays flat', () => {
    const movement = stripeEventTestUtils.classifyRevenueMovement(
      {
        is_good_plan: true,
        paid_at: '2026-04-01T00:00:00.000Z',
        price_id: 'price_solo_monthly',
        product_id: 'prod_solo',
        status: 'succeeded',
      },
      {
        is_good_plan: true,
        paid_at: '2026-04-01T00:00:00.000Z',
        price_id: 'price_solo_yearly',
        product_id: 'prod_solo',
        status: 'succeeded',
      },
      plans as any,
    )

    expect(movement).toMatchObject({
      currentMrr: 12,
      nextMrr: 10,
      newBusinessMrr: 0,
      expansionMrr: 0,
      contractionMrr: 2,
      churnMrr: 0,
    })
    expect(stripeEventTestUtils.shouldTrackOrganizationUpgrade(true, movement)).toBe(false)
  })

  it.concurrent('tracks paying MRR increases as organization upgrades', () => {
    const movement = stripeEventTestUtils.classifyRevenueMovement(
      {
        is_good_plan: true,
        paid_at: '2026-04-01T00:00:00.000Z',
        price_id: 'price_solo_monthly',
        product_id: 'prod_solo',
        status: 'succeeded',
      },
      {
        is_good_plan: true,
        paid_at: '2026-04-01T00:00:00.000Z',
        price_id: 'price_team_monthly',
        product_id: 'prod_team',
        status: 'succeeded',
      },
      plans as any,
    )

    expect(movement.currentMrr).toBeGreaterThan(0)
    expect(movement.nextMrr).toBeGreaterThan(movement.currentMrr)
    expect(stripeEventTestUtils.shouldTrackOrganizationUpgrade(false, movement)).toBe(true)
  })

    it.concurrent('does not track first-time subscriptions as organization upgrades for admin metrics', () => {
    const movement = stripeEventTestUtils.classifyRevenueMovement(
      {
        paid_at: null,
        price_id: null,
        product_id: null,
        status: 'created',
      },
      {
        is_good_plan: true,
        paid_at: '2026-04-22T12:00:00.000Z',
        price_id: 'price_solo_monthly',
        product_id: 'prod_solo',
        status: 'succeeded',
      },
      plans as any,
    )

    expect(stripeEventTestUtils.shouldTrackOrganizationUpgrade(false, movement)).toBe(false)
    // monthly->yearly flag alone is not enough without already-paying MRR
    expect(stripeEventTestUtils.shouldTrackOrganizationUpgrade(true, movement)).toBe(false)
  })

  it.concurrent('records downgrades as contraction MRR', () => {
    expect(stripeEventTestUtils.classifyRevenueMovement(
      {
        is_good_plan: true,
        paid_at: '2026-04-01T00:00:00.000Z',
        price_id: 'price_team_monthly',
        product_id: 'prod_team',
        status: 'succeeded',
      },
      {
        is_good_plan: true,
        paid_at: '2026-04-01T00:00:00.000Z',
        price_id: 'price_solo_monthly',
        product_id: 'prod_solo',
        status: 'succeeded',
      },
      plans as any,
    )).toMatchObject({
      currentMrr: 49,
      nextMrr: 12,
      contractionMrr: 37,
      newBusinessMrr: 0,
      expansionMrr: 0,
      churnMrr: 0,
      lostPlan: 'team',
    })
  })

  it.concurrent('records cancellations as churned MRR', () => {
    expect(stripeEventTestUtils.classifyRevenueMovement(
      {
        is_good_plan: true,
        paid_at: '2026-04-01T00:00:00.000Z',
        price_id: 'price_team_yearly',
        product_id: 'prod_team',
        status: 'succeeded',
      },
      {
        is_good_plan: true,
        paid_at: '2026-04-01T00:00:00.000Z',
        price_id: 'price_team_yearly',
        product_id: 'prod_team',
        status: 'canceled',
      },
      plans as any,
    )).toMatchObject({
      currentMrr: 39,
      nextMrr: 0,
      churnMrr: 39,
      newBusinessMrr: 0,
      expansionMrr: 0,
      contractionMrr: 0,
      lostPlan: 'team',
    })
  })

  it.concurrent('records unresolved past due cancellations as churned MRR from the stored active status', () => {
    expect(stripeEventTestUtils.classifyRevenueMovement(
      {
        is_good_plan: true,
        paid_at: '2026-04-01T00:00:00.000Z',
        price_id: 'price_team_yearly',
        product_id: 'prod_team',
        status: 'succeeded',
      },
      {
        is_good_plan: true,
        paid_at: '2026-04-01T00:00:00.000Z',
        price_id: 'price_team_yearly',
        product_id: 'prod_team',
        status: 'canceled',
      },
      plans as any,
    )).toMatchObject({
      currentMrr: 39,
      nextMrr: 0,
      churnMrr: 39,
      newBusinessMrr: 0,
      expansionMrr: 0,
      contractionMrr: 0,
      lostPlan: 'team',
    })
  })

  it.concurrent('treats already-persisted newer subscription state as stale', () => {
    expect(stripeEventTestUtils.isStaleStripeEvent(
      {
        last_stripe_event_at: '2026-04-22T12:10:00.000Z',
      } as any,
      '2026-04-22T12:00:00.000Z',
    )).toBe(true)
  })

  it.concurrent('keeps newer incoming subscription events eligible for processing', () => {
    expect(stripeEventTestUtils.isStaleStripeEvent(
      {
        last_stripe_event_at: '2026-04-22T12:10:00.000Z',
      } as any,
      '2026-04-22T12:20:00.000Z',
    )).toBe(false)
  })
})
