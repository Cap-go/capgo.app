import type { Context } from 'hono'
import { simpleError } from './hono.ts'
import { cloudlogErr } from './logging.ts'

type CreditPlan = { credit_id: string | null } | null

export async function getFallbackCreditProductId(
  c: Context,
  customerId: string,
  fetchPlan: () => Promise<CreditPlan>,
): Promise<string> {
  let fallbackPlan: CreditPlan = null
  let fallbackError: unknown | null = null

  try {
    fallbackPlan = await fetchPlan()
  }
  catch (error) {
    fallbackError = error
  }

  if (!fallbackPlan?.credit_id) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'credit_fallback_plan_missing',
      customerId,
      error: fallbackError,
    })
    throw simpleError('credit_product_not_configured', 'Credit product is not configured')
  }

  return fallbackPlan.credit_id
}

interface CreditTierStep {
  id: number
  step_min: number
  step_max: number
  price_per_unit: number
  unit_factor: number
}

export interface TierUsage {
  tier_id: number
  step_min: number
  step_max: number
  unit_factor: number
  units_used: number // billing units (GiB/minutes/count)
  price_per_unit: number // Price per billing unit
  cost: number
}

export interface MetricBreakdown {
  cost: number
  tiers: TierUsage[]
}

/**
 * Price `value` units of overage for one metric. Tiers describe total usage,
 * so the overage covers [included, included + value) of the ladder. Mirrors
 * public.calculate_credit_cost. `steps` must be sorted by step_min.
 */
export function priceCreditTiers(steps: CreditTierStep[], value: number, included = 0): MetricBreakdown {
  if (!(value > 0))
    return { cost: 0, tiers: [] }

  const start = Math.max(Number.isFinite(included) ? included : 0, 0)
  const end = start + value
  const tiers: TierUsage[] = []
  let covered = 0
  let cost = 0

  const addTier = (step: CreditTierStep, rawUsage: number) => {
    const unitFactor = Math.max(step.unit_factor || 1, 1)
    // Convert using unit_factor and round up for pricing
    const unitsUsed = Math.ceil(rawUsage / unitFactor)
    const tierCost = unitsUsed * step.price_per_unit
    tiers.push({
      tier_id: step.id,
      step_min: step.step_min,
      step_max: step.step_max,
      unit_factor: unitFactor,
      units_used: unitsUsed,
      price_per_unit: step.price_per_unit,
      cost: tierCost,
    })
    cost += tierCost
  }

  for (const step of steps) {
    const slice = Math.min(end, step.step_max) - Math.max(start, step.step_min)
    if (slice <= 0)
      continue
    addTier(step, slice)
    covered += slice
  }

  // Usage outside every tier range is billed at the highest tier
  const highestStep = steps.at(-1)
  if (covered < value && highestStep)
    addTier(highestStep, value - covered)

  return { cost, tiers }
}
