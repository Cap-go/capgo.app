import { describe, expect, it, vi } from 'vitest'
import { getCommonCurrencies, pickCurrency } from '../supabase/functions/_backend/private/plan_prices.ts'
import { currencyForCountry } from '../supabase/functions/_backend/utils/country_currency.ts'
import { getPriceCurrencyAmounts, scaleTiersToCurrency } from '../supabase/functions/_backend/utils/stripe.ts'
import { getPlanAmounts } from '../src/services/planPrices'

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

  it.concurrent('re-expresses extra-MAU tiers in each currency\'s smallest unit', () => {
    const tiers = [{ up_to: 10, unit_amount: 60 }, { up_to: 'inf' as const, unit_amount: 45 }]
    expect(scaleTiersToCurrency(tiers, 'eur')).toEqual(tiers)
    expect(scaleTiersToCurrency(tiers, 'jpy').map(tier => [tier.up_to, String(tier.unit_amount_decimal)])).toEqual([[10, '0.6'], ['inf', '0.45']])
    expect(scaleTiersToCurrency(tiers, 'kwd')).toEqual([{ up_to: 10, unit_amount: 600 }, { up_to: 'inf', unit_amount: 450 }])
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
})
