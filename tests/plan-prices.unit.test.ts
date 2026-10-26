import { describe, expect, it, vi } from 'vitest'
import { getCommonCurrencies, pickCurrency, pickPriceCurrencies } from '../supabase/functions/_backend/private/plan_prices.ts'
import { currencyForCountry, isCurrencyAllowedForCountry } from '../supabase/functions/_backend/utils/country_currency.ts'
import { getPlanPriceInterval } from '../supabase/functions/_backend/utils/plan_price_interval.ts'
import { getCurrencyRatios, getPriceCurrencyAmounts, scaleTiersToCurrency } from '../supabase/functions/_backend/utils/stripe.ts'
import { getPlanAmounts, getUsdRatio } from '../src/services/planPrices'

vi.mock('~/services/capgoApi', () => ({
  invokeCapgoApi: vi.fn(),
}))

describe('plan prices', () => {
  it.concurrent('reads every currency configured on a Stripe price', () => {
    expect(getPriceCurrencyAmounts({
      currency: 'usd',
      unit_amount: 1400,
      currency_options: {
        usd: { unit_amount: 1400 },
        eur: { unit_amount: 1400 },
        gbp: { unit_amount: null },
      },
    } as any)).toEqual({ usd: 1400, eur: 1400 })
    expect(getPriceCurrencyAmounts({ currency: 'usd', unit_amount: 3900, currency_options: undefined } as any)).toEqual({ usd: 3900 })
    expect(getPriceCurrencyAmounts({
      currency: 'usd',
      unit_amount: null,
      unit_amount_decimal: '1400.5',
      currency_options: { eur: { unit_amount: null, unit_amount_decimal: '1400' } },
    } as any)).toEqual({ usd: 1400.5, eur: 1400 })
  })

  it.concurrent('keeps only currencies every plan is sold in', () => {
    expect(getCommonCurrencies({
      solo: { month: { usd: 1400, eur: 1400, gbp: 1400 }, year: { usd: 14600, eur: 14600, gbp: 14600 } },
      team: { month: { usd: 9900, eur: 9900 }, year: { usd: 99800, eur: 99800 } },
    })).toEqual(['eur', 'usd'])
    // A plan whose Stripe price failed to load disables every currency.
    expect(getCommonCurrencies({
      solo: { month: { usd: 1400, eur: 1400 }, year: { usd: 14600, eur: 14600 } },
      team: { month: {}, year: {} },
    })).toEqual([])
    expect(getCommonCurrencies({})).toEqual([])
  })

  it.concurrent('picks the locked, local, then USD currency', () => {
    expect(pickCurrency(['eur', 'gbp', 'usd'], 'usd', 'FR')).toBe('usd')
    expect(pickCurrency(['eur', 'gbp', 'usd'], null, 'FR')).toBe('eur')
    expect(pickCurrency(['eur', 'gbp', 'usd'], null, 'GB')).toBe('gbp')
    expect(pickCurrency(['eur', 'usd'], null, 'GB')).toBe('usd')
    expect(pickCurrency(['eur', 'usd'], null, null)).toBe('usd')
    expect(pickCurrency(['usd'], 'eur', 'FR')).toBeNull()
    expect(pickCurrency([], null, 'FR')).toBeNull()
    // Any local currency Stripe sells is picked; unsold ones fall back to USD.
    expect(pickCurrency(['eur', 'jpy', 'usd'], null, 'JP')).toBe('jpy')
    expect(pickCurrency(['eur', 'usd'], null, 'JP')).toBe('usd')
  })

  it.concurrent('returns Stripe amounts in major units, or null when not sold in that currency', () => {
    const prices = { prod_solo: { month: { usd: 1400, eur: 1400 }, year: { usd: 14600, eur: 14600 } } }
    expect(getPlanAmounts(prices, 'prod_solo', 'eur')).toEqual({ month: 14, year: 146 })
    expect(getPlanAmounts(prices, 'prod_solo', 'gbp')).toBeNull()
    expect(getPlanAmounts(prices, 'prod_missing', 'usd')).toBeNull()
  })

  it.concurrent('prices extra-MAU tiers with the plan\'s own currency ratio', () => {
    const tiers = [{ up_to: 10, unit_amount: 60 }, { up_to: 'inf' as const, unit_amount: 45 }]
    // INR plan at 5000 vs USD 249: 500000 paise / 24900 cents.
    const ratios = getCurrencyRatios({ usd: 24900, inr: 500000, jpy: 24000 })
    expect(ratios.usd).toBe(1)
    expect(scaleTiersToCurrency(tiers, ratios.usd)).toEqual(tiers)
    expect(scaleTiersToCurrency(tiers, ratios.inr).map(tier => [tier.up_to, tier.unit_amount ?? String(tier.unit_amount_decimal)])).toEqual([[10, '1204.8193'], ['inf', '903.6145']])
    expect(scaleTiersToCurrency(tiers, 2)).toEqual([{ up_to: 10, unit_amount: 120 }, { up_to: 'inf', unit_amount: 90 }])
    expect(getCurrencyRatios({ eur: 1400 })).toEqual({})
  })

  it.concurrent('maps every country to its local currency', () => {
    expect(currencyForCountry('fr')).toBe('eur')
    expect(currencyForCountry('BG')).toBe('eur')
    expect(currencyForCountry('GB')).toBe('gbp')
    expect(currencyForCountry('JP')).toBe('jpy')
    expect(currencyForCountry('BR')).toBe('brl')
    expect(currencyForCountry('CH')).toBe('chf')
    expect(currencyForCountry('SN')).toBe('xof')
    expect(currencyForCountry('EC')).toBe('usd')
    expect(currencyForCountry('ZZ')).toBeNull()
    expect(currencyForCountry(null)).toBeNull()
  })

  it.concurrent('only offers USD and the visitor\'s own currency', () => {
    expect(isCurrencyAllowedForCountry('usd', 'IN')).toBe(true)
    expect(isCurrencyAllowedForCountry('INR', 'IN')).toBe(true)
    expect(isCurrencyAllowedForCountry('eur', 'IN')).toBe(false)
    expect(isCurrencyAllowedForCountry('eur', null)).toBe(false)
    const prices = { solo: { month: { usd: 1400, eur: 900, inr: 28000 }, year: { usd: 14600, eur: 9600, inr: 290000 } } }
    expect(pickPriceCurrencies(prices, new Set(['inr', 'usd']))).toEqual({ solo: { month: { usd: 1400, inr: 28000 }, year: { usd: 14600, inr: 290000 } } })
  })

  it.concurrent('converts USD figures with the plan\'s own ratio', () => {
    const prices = { ent: { month: { usd: 24900, jpy: 24000 }, year: { usd: 249000, jpy: 240000 } } }
    expect(getUsdRatio(prices, 'ent', 'jpy', 'month')).toBeCloseTo(24000 / 249)
    expect(getUsdRatio(prices, 'ent', 'eur', 'month')).toBeNull()
  })

  it.concurrent('recognises current and replaced plan prices', () => {
    const plan = { price_m_id: 'price_m_new', price_y_id: 'price_y_new', price_m_id_us: 'price_m_us', price_y_id_us: null, legacy_price_m_ids: ['price_m_old'], legacy_price_y_ids: ['price_y_old'] }
    expect(getPlanPriceInterval(plan, 'price_m_new')).toBe('monthly')
    expect(getPlanPriceInterval(plan, 'price_m_us')).toBe('monthly')
    expect(getPlanPriceInterval(plan, 'price_m_old')).toBe('monthly')
    expect(getPlanPriceInterval(plan, 'price_y_old')).toBe('yearly')
    expect(getPlanPriceInterval(plan, 'price_other')).toBeUndefined()
    expect(getPlanPriceInterval(plan, null)).toBeUndefined()
  })
})
