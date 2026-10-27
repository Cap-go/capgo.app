import { describe, expect, it } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'

const plans = [
  { name: 'Solo', stripe_id: 'prod_solo', price_m: 12, price_m_id: 'price_solo_monthly', price_y: 120, price_y_id: 'price_solo_yearly', alt_price_m_ids: ['price_solo_monthly_p50'], regional_price_ids: { p50: { price_m_id: 'price_solo_monthly_p50' } } },
  { name: 'Team', stripe_id: 'prod_team', price_m: 49, price_m_id: 'price_team_monthly', price_y: 468, price_y_id: 'price_team_yearly' },
] as any

const unpaid = { paid_at: null, price_id: null, product_id: null, status: 'created' }
function paying(price_id: string, status = 'succeeded', paid_at = '2026-04-01T00:00:00.000Z') {
  return { is_good_plan: true, paid_at, price_id, product_id: price_id.includes('team') ? 'prod_team' : 'prod_solo', status }
}
const firstSubscription = () => stripeEventTestUtils.classifyRevenueMovement(unpaid as any, paying('price_solo_monthly', 'succeeded', '2026-04-22T12:00:00.000Z') as any, plans)
const zero = { newBusinessMrr: 0, expansionMrr: 0, contractionMrr: 0, churnMrr: 0 }

describe('stripe revenue movement classification', () => {
  it.concurrent('records first-time subscriptions as new business MRR', () => {
    expect(firstSubscription()).toMatchObject({ ...zero, currentMrr: 0, nextMrr: 12, newBusinessMrr: 12 })
  })

  it.concurrent.each([
    ['paid upgrades as expansion MRR', paying('price_solo_monthly'), paying('price_team_monthly'), { currentMrr: 12, nextMrr: 49, expansionMrr: 37 }],
    ['monthly to yearly cadence changes as contraction when MRR drops', paying('price_solo_monthly'), paying('price_solo_yearly'), { currentMrr: 12, nextMrr: 10, contractionMrr: 2 }],
    ['downgrades as contraction MRR', paying('price_team_monthly'), paying('price_solo_monthly'), { currentMrr: 49, nextMrr: 12, contractionMrr: 37, lostPlan: 'team' }],
    ['a regional price raised to full price as expansion MRR', paying('price_solo_monthly_p50'), paying('price_solo_monthly'), { currentMrr: 6, nextMrr: 12, expansionMrr: 6 }],
    ['cancellations as churned MRR', paying('price_team_yearly'), paying('price_team_yearly', 'canceled'), { currentMrr: 39, nextMrr: 0, churnMrr: 39, lostPlan: 'team' }],
  ])('records %s', (_label, current, next, expected) => {
    expect(stripeEventTestUtils.classifyRevenueMovement(current as any, next as any, plans)).toMatchObject({ ...zero, ...expected })
  })

  it.concurrent('tracks organization upgrades only for paying MRR increases', () => {
    const upgrade = stripeEventTestUtils.classifyRevenueMovement(paying('price_solo_monthly') as any, paying('price_team_monthly') as any, plans)
    const cadence = stripeEventTestUtils.classifyRevenueMovement(paying('price_solo_monthly') as any, paying('price_solo_yearly') as any, plans)
    expect(stripeEventTestUtils.shouldTrackOrganizationUpgrade(false, upgrade)).toBe(true)
    // A monthly->yearly flag does not count when MRR does not increase...
    expect(stripeEventTestUtils.shouldTrackOrganizationUpgrade(true, cadence)).toBe(false)
    // ...nor for a first-time subscription without already-paying MRR.
    expect(stripeEventTestUtils.shouldTrackOrganizationUpgrade(false, firstSubscription())).toBe(false)
    expect(stripeEventTestUtils.shouldTrackOrganizationUpgrade(true, firstSubscription())).toBe(false)
  })

  it.concurrent.each([
    ['2026-04-22T12:00:00.000Z', true],
    ['2026-04-22T12:20:00.000Z', false],
  ])('treats an incoming event at %s as stale=%s against a persisted 12:10 state', (incoming, stale) => {
    expect(stripeEventTestUtils.isStaleStripeEvent({ last_stripe_event_at: '2026-04-22T12:10:00.000Z' } as any, incoming)).toBe(stale)
  })
})
