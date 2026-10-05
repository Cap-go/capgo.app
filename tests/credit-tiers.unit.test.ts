import { describe, expect, it } from 'vitest'
import { priceCreditTiers } from '../supabase/functions/_backend/utils/credits.ts'

const MAX = Number.MAX_SAFE_INTEGER
const GIB = 1024 ** 3
const TB = 1024 ** 4

const mauSteps = [
  [0, 1_000_000, 0.003],
  [1_000_000, 3_000_000, 0.0003],
  [3_000_000, 6_000_000, 0.00025],
  [6_000_000, 10_000_000, 0.0002],
  [10_000_000, 25_000_000, 0.00018],
  [25_000_000, 100_000_000, 0.00015],
  [100_000_000, MAX, 0.0001],
].map(([step_min, step_max, price_per_unit], id) => ({ id, step_min, step_max, price_per_unit, unit_factor: 1 }))

const bandwidthSteps = [
  [0, 1 * TB, 0.06],
  [1 * TB, 2 * TB, 0.05],
  [2 * TB, 6 * TB, 0.0425],
  [6 * TB, 12 * TB, 0.035],
  [12 * TB, 25 * TB, 0.0275],
  [25 * TB, 63 * TB, 0.02],
  [63 * TB, 100 * TB, 0.015],
  [100 * TB, 250 * TB, 0.008],
  [250 * TB, 500 * TB, 0.006],
  [500 * TB, 1024 * TB, 0.005],
  [1024 * TB, MAX, 0.004],
].map(([step_min, step_max, price_per_unit], id) => ({ id, step_min, step_max, price_per_unit, unit_factor: GIB }))

describe('priceCreditTiers', () => {
  it('keeps small plans on the first tier', () => {
    expect(priceCreditTiers(mauSteps, 1000, 2000).cost).toBeCloseTo(3, 9)
  })

  it('prices the overage above the included amount, not from 0', () => {
    // 2M MAU on a 1M plan
    expect(priceCreditTiers(mauSteps, 1_000_000, 1_000_000).cost).toBeCloseTo(300, 9)
    // Same overage with nothing included
    expect(priceCreditTiers(mauSteps, 1_000_000).cost).toBeCloseTo(3000, 9)
  })

  it('splits an overage across every tier it covers', () => {
    // 5M MAU on a 1M plan: 2M at $0.0003 + 2M at $0.00025
    const result = priceCreditTiers(mauSteps, 4_000_000, 1_000_000)
    expect(result.tiers.map(tier => tier.units_used)).toEqual([2_000_000, 2_000_000])
    expect(result.cost).toBeCloseTo(1100, 9)
  })

  it('keeps overage cost per MAU going down with volume above 1M', () => {
    // Overage only, on a plan that includes 1M MAU
    const perMau = [1, 2, 4, 9, 19, 49, 149].map((millions) => {
      const overage = millions * 1_000_000
      return priceCreditTiers(mauSteps, overage, 1_000_000).cost / overage
    })
    for (let i = 1; i < perMau.length; i++)
      expect(perMau[i]).toBeLessThanOrEqual(perMau[i - 1])
  })

  it('prices bandwidth above the plan on the high-volume tiers', () => {
    // 200 TB on a 100 TB plan: 102400 GiB at $0.008
    expect(priceCreditTiers(bandwidthSteps, 100 * TB, 100 * TB).cost).toBeCloseTo(819.2, 6)
    // 11 TB on a 10 TB plan: 1 TB on the 6-12 TB tier
    expect(priceCreditTiers(bandwidthSteps, 1 * TB, 10 * TB).cost).toBeCloseTo(35.84, 6)
  })

  it('returns nothing for empty or invalid overage', () => {
    expect(priceCreditTiers(mauSteps, 0, 1_000_000)).toEqual({ cost: 0, tiers: [] })
    expect(priceCreditTiers(mauSteps, Number.NaN)).toEqual({ cost: 0, tiers: [] })
  })
})
