import type { CreditPricingStep } from '../src/services/creditPricing'
import { describe, expect, it } from 'vitest'
import { mauForMonthlyCredits, priceMauSlice, quoteEnterpriseScale } from '../src/services/enterpriseScale'

const OPEN = Number.MAX_SAFE_INTEGER
const steps: CreditPricingStep[] = [
  { type: 'mau', step_min: 0, step_max: 1_000_000, price_per_unit: 0.003, unit_factor: 1 },
  { type: 'mau', step_min: 1_000_000, step_max: 3_000_000, price_per_unit: 0.0006, unit_factor: 1 },
  { type: 'mau', step_min: 3_000_000, step_max: 6_000_000, price_per_unit: 0.00045, unit_factor: 1 },
  { type: 'mau', step_min: 6_000_000, step_max: 10_000_000, price_per_unit: 0.00035, unit_factor: 1 },
  { type: 'mau', step_min: 10_000_000, step_max: OPEN, price_per_unit: 0.00025, unit_factor: 1 },
  { type: 'bandwidth', step_min: 0, step_max: OPEN, price_per_unit: 1, unit_factor: 1 },
]

describe('enterprise scale pricing', () => {
  it('prices only the MAU above the Enterprise allowance', () => {
    expect(priceMauSlice(steps, 1_000_000, 1_000_000)).toBe(0)
    expect(priceMauSlice(steps, 1_000_000, 3_000_000)).toBeCloseTo(1200)
    expect(priceMauSlice(steps, 1_000_000, 10_000_000)).toBeCloseTo(3950)
  })

  it('quotes base plan plus whole-dollar monthly credits', () => {
    expect(quoteEnterpriseScale(steps, 1_000_000, 239, 3_000_000)).toEqual({
      targetMau: 3_000_000,
      includedMau: 1_000_000,
      basePriceMonthly: 239,
      monthlyCredits: 1200,
      totalMonthly: 1439,
    })
  })

  it('maps a monthly credit budget back to the biggest covered MAU stop', () => {
    expect(mauForMonthlyCredits(steps, 1_000_000, 0)).toBe(1_000_000)
    expect(mauForMonthlyCredits(steps, 1_000_000, 1200)).toBe(3_000_000)
    expect(mauForMonthlyCredits(steps, 1_000_000, 1199)).toBe(2_000_000)
  })
})
