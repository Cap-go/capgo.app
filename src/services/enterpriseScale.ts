import type { CreditPricingStep } from '~/services/creditPricing'
import { useConsole } from '~/services/console'
import { formatNumberValue } from '~/services/formatLocale'

// Enterprise is the only plan that scales past its included MAU. Instead of a
// separate "custom plan", the org buys extra MAU as a second item on the same
// Stripe subscription (priced on the MAU usage tiers). The extra MAU is part of
// the plan quota (stripe_info.extra_mau), so the UI shows "Enterprise 3M".
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
  extraMau: number
  basePriceMonthly: number
  extraMauPriceMonthly: number
  totalMonthly: number
}

// Stripe bills the extra MAU per 1,000 with the same tiers, so this matches the invoice.
export function quoteEnterpriseScale(steps: CreditPricingStep[], includedMau: number, basePriceMonthly: number, targetMau: number): EnterpriseScaleQuote {
  const extraMauPriceMonthly = Math.round(priceMauSlice(steps, includedMau, targetMau) * 100) / 100
  return {
    targetMau,
    includedMau,
    extraMau: Math.max(targetMau - includedMau, 0),
    basePriceMonthly,
    extraMauPriceMonthly,
    totalMonthly: basePriceMonthly + extraMauPriceMonthly,
  }
}

// MAU bought on top of the plan allowance, synced from the Stripe subscription.
export async function getOrgExtraMau(orgId: string) {
  const { data, error } = await useConsole()
    .from('orgs')
    .select('stripe_info(extra_mau)')
    .eq('id', orgId)
    .maybeSingle()
  if (error)
    throw error
  return Number(data?.stripe_info?.extra_mau ?? 0)
}

// "3M" reads like a plan name; locale compact notation can render "3m" or "3 Mio".
export function formatMau(value: number) {
  if (value >= 1_000_000)
    return `${formatNumberValue(value / 1_000_000, { maximumFractionDigits: 1 })}M`
  return formatNumberValue(value)
}
