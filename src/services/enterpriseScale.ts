import type { CreditPricingStep } from '~/services/creditPricing'

// Enterprise is the only plan that scales past its included MAU. Instead of a
// separate "custom plan", the MAU above the Enterprise allowance is paid with
// credits bought every month on the same subscription. The UI shows it as
// "Enterprise 3M" even though only the Enterprise base is a real plan.
export const ENTERPRISE_MAU_STOPS = [
  1_000_000,
  2_000_000,
  3_000_000,
  5_000_000,
  7_500_000,
  10_000_000,
  15_000_000,
  25_000_000,
  50_000_000,
  100_000_000,
] as const

// Mirrors priceCreditTiers in supabase/functions/_backend/utils/credits.ts:
// tiers describe total usage, so the extra MAU is priced on the slice
// [included, target) of the ladder.
export function priceMauSlice(steps: CreditPricingStep[], included: number, target: number) {
  const mauSteps = steps
    .filter(step => step.type === 'mau')
    .sort((a, b) => a.step_min - b.step_min)
  if (target <= included || !mauSteps.length)
    return 0

  let cost = 0
  let covered = 0
  for (const step of mauSteps) {
    const slice = Math.min(target, step.step_max) - Math.max(included, step.step_min)
    if (slice <= 0)
      continue
    cost += Math.ceil(slice / Math.max(step.unit_factor || 1, 1)) * step.price_per_unit
    covered += slice
  }
  const remaining = target - included - covered
  const highest = mauSteps.at(-1)
  if (remaining > 0 && highest)
    cost += Math.ceil(remaining / Math.max(highest.unit_factor || 1, 1)) * highest.price_per_unit
  return cost
}

export interface EnterpriseScaleQuote {
  targetMau: number
  includedMau: number
  basePriceMonthly: number
  monthlyCredits: number
  totalMonthly: number
}

// Credits are bought in whole dollars, so round up: the org never ends the
// month short of the MAU it picked.
export function quoteEnterpriseScale(steps: CreditPricingStep[], includedMau: number, basePriceMonthly: number, targetMau: number): EnterpriseScaleQuote {
  const monthlyCredits = Math.ceil(priceMauSlice(steps, includedMau, targetMau))
  return {
    targetMau,
    includedMau,
    basePriceMonthly,
    monthlyCredits,
    totalMonthly: basePriceMonthly + monthlyCredits,
  }
}

// Label for an org already on Enterprise: the biggest stop its recurring
// monthly credits fully cover (stripe_info.recurring_credits).
export function mauForMonthlyCredits(steps: CreditPricingStep[], includedMau: number, monthlyCredits: number) {
  let best = includedMau
  for (const stop of ENTERPRISE_MAU_STOPS) {
    if (stop > includedMau && Math.ceil(priceMauSlice(steps, includedMau, stop)) <= monthlyCredits)
      best = stop
  }
  return best
}
