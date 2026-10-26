export interface PlanPriceIntervalIds {
  price_m_id: string | null
  price_y_id: string | null
  price_m_id_us?: string | null
  price_y_id_us?: string | null
  legacy_price_m_ids?: string[] | null
  legacy_price_y_ids?: string[] | null
}

// Monthly or yearly for a plan price, including replaced prices still billed on existing subscriptions.
export function getPlanPriceInterval(plan: PlanPriceIntervalIds, priceId: string | null | undefined): 'monthly' | 'yearly' | undefined {
  if (!priceId)
    return undefined
  if (plan.price_m_id === priceId || plan.price_m_id_us === priceId || plan.legacy_price_m_ids?.includes(priceId))
    return 'monthly'
  if (plan.price_y_id === priceId || plan.price_y_id_us === priceId || plan.legacy_price_y_ids?.includes(priceId))
    return 'yearly'
  return undefined
}
