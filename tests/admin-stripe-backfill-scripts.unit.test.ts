import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { isActionableStripeCustomerId } from '../scripts/admin_stripe_backfill_utils.ts'
import { buildOrgConversionRateBackfillRows, calculateOrgConversionRate } from '../scripts/backfill_org_conversion_rate_trend.ts'
import { getCustomerProfileCountry, normalizeStripeCountryCode, shouldUpdateCustomerCountry } from '../scripts/backfill_stripe_customer_countries.ts'
import { buildStripeInvoiceRevenueBackfillRows, buildStripePriceLookup, classifyPlanKeyFromText } from '../scripts/fix_stripe_admin_revenue_dashboard_metrics.ts'

function globalStatsRevenueRow(dateId: string) {
  return {
    canceled_orgs: 0,
    churn_revenue: 0,
    churn_revenue_enterprise: 0,
    churn_revenue_maker: 0,
    churn_revenue_solo: 0,
    churn_revenue_team: 0,
    date_id: dateId,
    mrr: 0,
    new_paying_orgs: 0,
    paying: 0,
    paying_monthly: 0,
    paying_yearly: 0,
    plan_enterprise: 0,
    plan_enterprise_monthly: 0,
    plan_enterprise_yearly: 0,
    plan_maker: 0,
    plan_maker_monthly: 0,
    plan_maker_yearly: 0,
    plan_solo: 0,
    plan_solo_monthly: 0,
    plan_solo_yearly: 0,
    plan_team: 0,
    plan_team_monthly: 0,
    plan_team_yearly: 0,
    revenue_enterprise: 0,
    revenue_maker: 0,
    revenue_solo: 0,
    revenue_team: 0,
    total_revenue: 0,
    upgraded_orgs: 0,
  }
}

describe('admin Stripe backfill scripts', () => {
  it.concurrent('calculates org conversion rates from paying and org snapshots', () => {
    expect(calculateOrgConversionRate(25, 200)).toBe(12.5)
    expect(calculateOrgConversionRate('1', '3')).toBe(33.3)
    expect(calculateOrgConversionRate(10, 0)).toBe(0)
  })

  it.concurrent('marks only changed org conversion rows', () => {
    const rows = buildOrgConversionRateBackfillRows([
      {
        date_id: '2026-04-01',
        paying: 25,
        org_conversion_rate: 0,
        plan_enterprise: 0,
        plan_enterprise_conversion_rate: 0,
        plan_maker: 10,
        plan_maker_conversion_rate: 0,
        plan_solo: 15,
        plan_solo_conversion_rate: 0,
        plan_team: 0,
        plan_team_conversion_rate: 0,
        plan_total_conversion_rate: 0,
      },
      {
        date_id: '2026-04-02',
        paying: 50,
        org_conversion_rate: 25,
        plan_enterprise: 0,
        plan_enterprise_conversion_rate: 0,
        plan_maker: 20,
        plan_maker_conversion_rate: 10,
        plan_solo: 30,
        plan_solo_conversion_rate: 15,
        plan_team: 0,
        plan_team_conversion_rate: 0,
        plan_total_conversion_rate: 25,
      },
    ] as any, [
      ...Array.from({ length: 200 }, () => ({ created_at: '2026-04-01T12:00:00.000Z' })),
      { created_at: '2026-04-03T00:00:00.000Z' },
    ])

    expect(rows).toEqual([
      {
        date_id: '2026-04-01',
        orgs: 200,
        paying: 25,
        current_plan_rates: {
          enterprise: 0,
          maker: 0,
          solo: 0,
          team: 0,
          total: 0,
        },
        current_rate: 0,
        // Plan rates use paying denominator: 10/25, 15/25, 25/25
        next_plan_rates: {
          enterprise: 0,
          maker: 40,
          solo: 60,
          team: 0,
          total: 100,
        },
        next_rate: 12.5,
        changed: true,
      },
      {
        date_id: '2026-04-02',
        orgs: 200,
        paying: 50,
        current_plan_rates: {
          enterprise: 0,
          maker: 10,
          solo: 15,
          team: 0,
          total: 25,
        },
        current_rate: 25,
        next_plan_rates: {
          enterprise: 0,
          maker: 40,
          solo: 60,
          team: 0,
          total: 100,
        },
        next_rate: 25,
        changed: true,
      },
    ])
  })

  it.concurrent('marks rows changed when only plan conversion rate differs', () => {
    const rows = buildOrgConversionRateBackfillRows([
      {
        date_id: '2026-04-10',
        paying: 40,
        org_conversion_rate: 20,
        plan_enterprise: 0,
        plan_enterprise_conversion_rate: 0,
        plan_maker: 10,
        plan_maker_conversion_rate: 4.5,
        plan_solo: 30,
        plan_solo_conversion_rate: 15,
        plan_team: 0,
        plan_team_conversion_rate: 0,
        plan_total_conversion_rate: 19.5,
      },
    ] as any, Array.from({ length: 200 }, () => ({ created_at: '2026-04-01T12:00:00.000Z' })))

    expect(rows).toEqual([
      {
        date_id: '2026-04-10',
        orgs: 200,
        paying: 40,
        current_plan_rates: {
          enterprise: 0,
          maker: 4.5,
          solo: 15,
          team: 0,
          total: 19.5,
        },
        current_rate: 20,
        // Plan rates use paying: 10/40=25, 30/40=75, 40/40=100
        next_plan_rates: {
          enterprise: 0,
          maker: 25,
          solo: 75,
          team: 0,
          total: 100,
        },
        next_rate: 20,
        changed: true,
      },
    ])
  })

  it.concurrent('normalizes Stripe country codes', () => {
    expect(normalizeStripeCountryCode(' us ')).toBe('US')
    expect(normalizeStripeCountryCode('USA')).toBeNull()
    expect(normalizeStripeCountryCode('')).toBeNull()
  })

  it.concurrent('reads customer profile country from Stripe customers', () => {
    expect(getCustomerProfileCountry({
      deleted: false,
      address: { country: 'fr' },
    } as unknown as Stripe.Customer)).toBe('FR')

    expect(getCustomerProfileCountry({
      deleted: true,
      id: 'cus_deleted',
      object: 'customer',
    } as Stripe.DeletedCustomer)).toBeNull()
  })

  it.concurrent('decides when customer country rows need updates', () => {
    expect(shouldUpdateCustomerCountry(null, 'US', false)).toBe(true)
    expect(shouldUpdateCustomerCountry('US', 'FR', false)).toBe(false)
    expect(shouldUpdateCustomerCountry('US', 'FR', true)).toBe(true)
    expect(shouldUpdateCustomerCountry(' us ', 'US', true)).toBe(false)
  })

  it.concurrent('skips pending Stripe customer placeholders', () => {
    expect(isActionableStripeCustomerId('cus_123')).toBe(true)
    expect(isActionableStripeCustomerId('pending_org_id')).toBe(false)
    expect(isActionableStripeCustomerId('')).toBe(false)
  })

  it.concurrent('classifies legacy Stripe prices from product and price text', () => {
    expect(classifyPlanKeyFromText('Capgo Solo yearly')).toBe('solo')
    expect(classifyPlanKeyFromText('maker subscription')).toBe('maker')
    expect(classifyPlanKeyFromText('Enterprise annual')).toBe('enterprise')
    expect(classifyPlanKeyFromText('storage credits')).toBeNull()
  })

  it.concurrent('builds Stripe price lookup for inactive historical prices', () => {
    const lookup = buildStripePriceLookup([
      {
        id: 'price_legacy_team_yearly',
        object: 'price',
        active: false,
        billing_scheme: 'per_unit',
        created: 0,
        currency: 'usd',
        livemode: false,
        lookup_key: null,
        metadata: {},
        nickname: 'Legacy Team yearly',
        product: {
          id: 'prod_legacy_team',
          object: 'product',
          active: false,
          created: 0,
          default_price: null,
          description: null,
          images: [],
          livemode: false,
          marketing_features: [],
          metadata: {},
          name: 'Team',
          package_dimensions: null,
          shippable: null,
          statement_descriptor: null,
          tax_code: null,
          type: 'service',
          updated: 0,
          url: null,
        },
        recurring: {
          aggregate_usage: null,
          interval: 'year',
          interval_count: 1,
          meter: null,
          trial_period_days: null,
          usage_type: 'licensed',
        },
        tax_behavior: 'unspecified',
        tiers_mode: null,
        transform_quantity: null,
        type: 'recurring',
        unit_amount: 58800,
        unit_amount_decimal: '58800',
      } as unknown as Stripe.Price,
    ], [])

    expect(lookup.get('price_legacy_team_yearly')).toMatchObject({
      interval: 'yearly',
      mrr: 49,
      plan: 'team',
    })
  })

  it.concurrent('rebuilds revenue trend snapshots, flow, churn, and plan breakdown from Stripe intervals', () => {
    const rows = buildStripeInvoiceRevenueBackfillRows([
      globalStatsRevenueRow('2022-01-01'),
      globalStatsRevenueRow('2022-01-02'),
      globalStatsRevenueRow('2022-01-03'),
    ], {
      fromDateId: '2022-01-01',
      intervals: [
        {
          customerId: 'cus_team',
          endMs: Date.parse('2022-01-04T00:00:00.000Z'),
          interval: 'monthly',
          mrr: 49,
          plan: 'team',
          priceId: 'price_team_monthly',
          sourceId: 'in_team',
          startMs: Date.parse('2022-01-01T00:00:00.000Z'),
          subscriptionId: 'sub_team',
        },
        {
          customerId: 'cus_team',
          endMs: Date.parse('2022-02-02T00:00:00.000Z'),
          interval: 'monthly',
          mrr: 12,
          plan: 'solo',
          priceId: 'price_solo_monthly',
          sourceId: 'in_solo',
          startMs: Date.parse('2022-01-02T12:00:00.000Z'),
          subscriptionId: 'sub_team',
        },
        {
          customerId: 'cus_yearly',
          endMs: Date.parse('2023-01-03T00:00:00.000Z'),
          interval: 'yearly',
          mrr: 10,
          plan: 'solo',
          priceId: 'price_solo_yearly',
          sourceId: 'in_yearly',
          startMs: Date.parse('2022-01-03T00:00:00.000Z'),
          subscriptionId: 'sub_yearly',
        },
      ],
      toDateId: '2022-01-03',
    })

    expect(rows[0]).toMatchObject({
      mrr: 49,
      new_paying_orgs: 1,
      paying: 1,
      paying_monthly: 1,
      plan_team: 1,
      revenue_team: 588,
      total_revenue: 588,
    })
    expect(rows[1]).toMatchObject({
      churn_revenue: 37,
      churn_revenue_team: 37,
      mrr: 12,
      new_paying_orgs: 0,
      paying: 1,
      plan_solo: 1,
      plan_team: 0,
      revenue_solo: 144,
      total_revenue: 144,
    })
    expect(rows[2]).toMatchObject({
      mrr: 22,
      new_paying_orgs: 1,
      paying: 2,
      paying_monthly: 1,
      paying_yearly: 1,
      plan_solo: 2,
      plan_solo_monthly: 1,
      plan_solo_yearly: 1,
      revenue_solo: 264,
      total_revenue: 264,
    })
  })
})
