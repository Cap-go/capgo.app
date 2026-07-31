import type { BentoTrackingPayload } from './tracking.ts'

export const PLAN_CHECKOUT_STARTED_EVENT = 'Checkout Started'

export interface PlanCheckoutStartedBentoInput {
  event: string
  orgId: string | undefined
  orgName: string | undefined
  productId: string | undefined
  planName: string | undefined
  recurrence: string | undefined
  checkoutSource: string | undefined
  currentPlanName: string | undefined
  planPrice: number | undefined
  planPriceMonthly: number | undefined
  planPriceYearly: number | undefined
}

function normalizeRecurrence(recurrence: string | undefined) {
  if (recurrence === 'month' || recurrence === 'year')
    return recurrence
  return 'unknown'
}

function recurrenceToPlanType(recurrence: string) {
  if (recurrence === 'year')
    return 'yearly'
  if (recurrence === 'month')
    return 'monthly'
  return 'unknown'
}

export function buildPlanCheckoutStartedBentoEvent(input: PlanCheckoutStartedBentoInput): BentoTrackingPayload | undefined {
  if (input.event !== PLAN_CHECKOUT_STARTED_EVENT)
    return undefined
  if (!input.orgId)
    return undefined

  const recurrence = normalizeRecurrence(input.recurrence)
  const productId = input.productId ?? ''
  const planName = input.planName ?? ''

  return {
    cron: '* * * * *',
    event: 'user:checkout_started',
    preferenceKey: 'credit_usage',
    uniqId: `checkout_started:${productId || planName}:${recurrence}`,
    audience: 'billing',
    data: {
      org_id: input.orgId,
      org_name: input.orgName ?? '',
      product_id: productId,
      plan_name: planName,
      plan_type: recurrenceToPlanType(recurrence),
      recurrence,
      checkout_source: input.checkoutSource ?? 'plans',
      current_plan_name: input.currentPlanName ?? '',
      plan_price: input.planPrice ?? 0,
      plan_price_monthly: input.planPriceMonthly ?? 0,
      plan_price_yearly: input.planPriceYearly ?? 0,
    },
  }
}
