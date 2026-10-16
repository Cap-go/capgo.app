import { describe, expect, it } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'
import { extractDataEvent } from '../supabase/functions/_backend/utils/stripe_event.ts'

const mockContext = {
  get: () => 'test-request-id',
} as any

function makeSubscriptionItem({
  currentPeriodEnd = 1_714_517_200,
  interval,
  priceId,
  productId,
  usageType = 'licensed',
}: {
  currentPeriodEnd?: number
  interval: 'month' | 'year'
  priceId: string
  productId: string
  usageType?: 'licensed' | 'metered'
}) {
  return {
    current_period_end: currentPeriodEnd,
    current_period_start: 1_711_925_200,
    plan: {
      id: priceId,
      interval,
      product: productId,
      usage_type: usageType,
    },
  } as any
}

function makePlan({
  name,
  monthlyPriceId,
  stripeId,
  yearlyPriceId,
}: {
  name: string
  monthlyPriceId: string
  stripeId: string
  yearlyPriceId: string
}) {
  return {
    name,
    price_m_id: monthlyPriceId,
    price_y_id: yearlyPriceId,
    stripe_id: stripeId,
  } as any
}

describe('stripe subscription event classification', () => {
  it.concurrent('marks monthly to yearly cadence changes as upgraded without a plan change', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_upgrade_same_plan',
          id: 'sub_upgrade_same_plan',
          items: {
            data: [
              makeSubscriptionItem({
                interval: 'year',
                priceId: 'price_yearly_same_plan',
                productId: 'prod_same_plan',
              }),
            ],
          },
        },
        previous_attributes: {
          items: {
            data: [
              makeSubscriptionItem({
                interval: 'month',
                priceId: 'price_monthly_same_plan',
                productId: 'prod_same_plan',
              }),
            ],
          },
        },
      },
      type: 'customer.subscription.updated',
    } as any)

    expect(stripeData.isUpgrade).toBe(true)
    expect(stripeData.previousPriceId).toBe('price_monthly_same_plan')
    expect(stripeData.previousProductId).toBe('prod_same_plan')
    expect(stripeEventTestUtils.getSubscriptionTrackingState(stripeData, 'updated')).toEqual({
      shouldSendPlanChange: false,
      statusName: 'upgraded',
    })
    expect(stripeEventTestUtils.getPlanChangeTrackingEventName('upgraded')).toBe('User Upgraded')
    expect(
      stripeEventTestUtils.buildSubscriptionEventMetadata(
        stripeData,
        makePlan({
          name: 'Solo',
          monthlyPriceId: 'price_monthly_same_plan',
          stripeId: 'prod_same_plan',
          yearlyPriceId: 'price_yearly_same_plan',
        }),
      ),
    ).toEqual({
      plan_name: 'Solo',
      plan_type: 'yearly',
      previous_plan_name: 'Solo',
      previous_plan_type: 'monthly',
    })
  })

  it.concurrent('uses the licensed subscription item for cancel-at-period-end timestamps', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          cancel_at_period_end: true,
          customer: 'cus_multi_item',
          id: 'sub_multi_item',
          items: {
            data: [
              makeSubscriptionItem({
                currentPeriodEnd: 1_720_000_000,
                interval: 'month',
                priceId: 'price_metered',
                productId: 'prod_metered',
                usageType: 'metered',
              }),
              makeSubscriptionItem({
                currentPeriodEnd: 1_714_517_200,
                interval: 'month',
                priceId: 'price_licensed',
                productId: 'prod_licensed',
              }),
            ],
          },
        },
      },
      type: 'customer.subscription.updated',
    } as any)

    expect(stripeData.data.canceled_at).toBe('2024-04-30T22:46:40.000Z')
    expect(stripeData.data.product_id).toBe('prod_licensed')
    expect(stripeData.data.price_id).toBe('price_licensed')
  })

  it.concurrent('maps subscription trial end to the stored trial date', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_trial_extended',
          id: 'sub_trial_extended',
          items: {
            data: [
              makeSubscriptionItem({
                interval: 'month',
                priceId: 'price_monthly_trial',
                productId: 'prod_trial',
              }),
            ],
          },
          trial_end: 1_722_470_400,
        },
      },
      type: 'customer.subscription.updated',
    } as any)

    expect(stripeData.data.trial_at).toBe('2024-08-01T00:00:00.000Z')
  })

  it.concurrent('keeps same-cadence plan switches as plan changes instead of upgrades', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_plan_change_monthly',
          id: 'sub_plan_change_monthly',
          items: {
            data: [
              makeSubscriptionItem({
                interval: 'month',
                priceId: 'price_monthly_new_plan',
                productId: 'prod_new_plan',
              }),
            ],
          },
        },
        previous_attributes: {
          items: {
            data: [
              makeSubscriptionItem({
                interval: 'month',
                priceId: 'price_monthly_old_plan',
                productId: 'prod_old_plan',
              }),
            ],
          },
        },
      },
      type: 'customer.subscription.updated',
    } as any)

    expect(stripeData.isUpgrade).toBe(false)
    expect(stripeData.previousPriceId).toBe('price_monthly_old_plan')
    expect(stripeData.previousProductId).toBe('prod_old_plan')
    expect(stripeEventTestUtils.getSubscriptionTrackingState(stripeData, 'updated')).toEqual({
      shouldSendPlanChange: true,
      statusName: 'updated',
    })
    expect(stripeEventTestUtils.getPlanChangeTrackingEventName('updated')).toBe('User Plan Changed')
    expect(
      stripeEventTestUtils.buildSubscriptionEventMetadata(
        stripeData,
        makePlan({
          name: 'Maker',
          monthlyPriceId: 'price_monthly_new_plan',
          stripeId: 'prod_new_plan',
          yearlyPriceId: 'price_yearly_new_plan',
        }),
        makePlan({
          name: 'Solo',
          monthlyPriceId: 'price_monthly_old_plan',
          stripeId: 'prod_old_plan',
          yearlyPriceId: 'price_yearly_old_plan',
        }),
      ),
    ).toEqual({
      plan_name: 'Maker',
      plan_type: 'monthly',
      previous_plan_name: 'Solo',
      previous_plan_type: 'monthly',
    })
  })

  it.concurrent('does not treat yearly to monthly switches as upgrades', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_downgrade_same_plan',
          id: 'sub_downgrade_same_plan',
          items: {
            data: [
              makeSubscriptionItem({
                interval: 'month',
                priceId: 'price_monthly_same_plan',
                productId: 'prod_same_plan',
              }),
            ],
          },
        },
        previous_attributes: {
          items: {
            data: [
              makeSubscriptionItem({
                interval: 'year',
                priceId: 'price_yearly_same_plan',
                productId: 'prod_same_plan',
              }),
            ],
          },
        },
      },
      type: 'customer.subscription.updated',
    } as any)

    expect(stripeData.isUpgrade).toBe(false)
    expect(stripeData.previousPriceId).toBe('price_yearly_same_plan')
    expect(stripeEventTestUtils.getSubscriptionTrackingState(stripeData, 'updated')).toEqual({
      shouldSendPlanChange: false,
      statusName: 'updated',
    })
    expect(
      stripeEventTestUtils.buildSubscriptionEventMetadata(
        stripeData,
        makePlan({
          name: 'Solo',
          monthlyPriceId: 'price_monthly_same_plan',
          stripeId: 'prod_same_plan',
          yearlyPriceId: 'price_yearly_same_plan',
        }),
      ),
    ).toEqual({
      plan_name: 'Solo',
      plan_type: 'monthly',
      previous_plan_name: 'Solo',
      previous_plan_type: 'yearly',
    })
  })

  it.concurrent('marks Stripe past_due subscription events for payment health metrics', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_past_due_metric',
          id: 'sub_past_due_metric',
          status: 'past_due',
          items: {
            data: [
              makeSubscriptionItem({
                interval: 'month',
                priceId: 'price_monthly_past_due',
                productId: 'prod_past_due',
              }),
            ],
          },
        },
      },
      type: 'customer.subscription.updated',
    } as any)

    expect(stripeData.data.status).toBe('past_due')
  })

  it.concurrent('maps customer.subscription.deleted to canceled status', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_deleted_status',
          id: 'sub_deleted_status',
          items: {
            data: [
              makeSubscriptionItem({
                interval: 'month',
                priceId: 'price_monthly_deleted',
                productId: 'prod_deleted',
              }),
            ],
          },
        },
      },
      type: 'customer.subscription.deleted',
    } as any)

    expect(stripeData.data.status).toBe('canceled')
  })

  it.concurrent('tags churn from unresolved past due subscriptions', () => {
    expect(stripeEventTestUtils.getChurnReason(
      { status: 'succeeded', past_due_at: '2026-04-01T00:00:00.000Z' },
      { status: 'canceled' },
    )).toBe('past_due_unresolved')
    expect(stripeEventTestUtils.getChurnReason(
      { status: 'succeeded', past_due_at: null },
      { status: 'canceled' },
    )).toBeNull()
  })
})
