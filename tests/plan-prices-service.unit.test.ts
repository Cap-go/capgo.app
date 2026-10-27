import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { usePlanPrices } from '../src/services/planPrices'

const mocks = vi.hoisted(() => ({
  invokeCapgoApi: vi.fn(),
}))

vi.mock('~/services/capgoApi', () => ({
  invokeCapgoApi: mocks.invokeCapgoApi,
}))

const SOLO = 'prod_solo'
const TEAM = 'prod_team'

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    complete: true,
    currencies: ['eur', 'usd'],
    currency: 'eur',
    lockedCurrency: null,
    prices: {
      [SOLO]: { month: { eur: 900, usd: 1000 }, year: { eur: 9100, usd: 10000 } },
      [TEAM]: { month: { eur: 7900, usd: 8300 }, year: { eur: 79000, usd: 83000 } },
    },
    discount: { percent: 30, country: 'FR', currencies: ['eur'] },
    regularPrices: { [SOLO]: { month: { eur: 1300, usd: 1400 }, year: { eur: 13000, usd: 14600 } } },
    ...overrides,
  }
}

async function load(response: Record<string, unknown>) {
  mocks.invokeCapgoApi.mockResolvedValueOnce({ data: response, error: null })
  const prices = usePlanPrices(ref('org_1'))
  await vi.waitFor(() => expect(prices.ready.value).toBe(true))
  return prices
}

describe('usePlanPrices regional discount', () => {
  it('shows the regional price with its full price struck through', async () => {
    const prices = await load(catalog())
    expect(prices.amountsFor(SOLO)).toEqual({ month: 9, year: 91 })
    expect(prices.regularAmountsFor(SOLO)).toEqual({ month: 13, year: 130 })
    expect(prices.discount.value?.percent).toBe(30)
    expect(prices.showsStandardPrice(SOLO)).toBe(false)
  })

  it('shows and sells the full price once the buyer opts out', async () => {
    const prices = await load(catalog())
    prices.setStandardPrice(true)
    await nextTick()
    expect(prices.amountsFor(SOLO)).toEqual({ month: 13, year: 130 })
    expect(prices.regularAmountsFor(SOLO)).toBeNull()
    expect(prices.discount.value).toBeNull()
    expect(prices.showsStandardPrice(SOLO)).toBe(true)
    // Plans without a regional price are untouched.
    expect(prices.showsStandardPrice(TEAM)).toBe(false)
    prices.setStandardPrice(false)
  })

  it('sells the full price in a currency the discount is not sold in', async () => {
    const prices = await load(catalog({ currency: 'usd' }))
    expect(prices.amountsFor(SOLO)).toEqual({ month: 14, year: 146 })
    expect(prices.discount.value).toBeNull()
    expect(prices.showsStandardPrice(SOLO)).toBe(true)
  })

  it('sells the full price it shows when no currency qualifies (partial catalog)', async () => {
    const prices = await load(catalog({ complete: false, currencies: [], currency: null, discount: { percent: 50, country: 'GH', currencies: [] } }))
    expect(prices.amountsFor(SOLO)).toEqual({ month: 14, year: 146 })
    expect(prices.showsStandardPrice(SOLO)).toBe(true)
  })

  it('never falls back to the regional amount when the full price failed to load', async () => {
    const prices = await load(catalog({ currency: 'usd', regularPrices: { [SOLO]: { month: {}, year: {} } } }))
    expect(prices.amountsFor(SOLO)).toBeNull()
    expect(prices.hasPricesFor(SOLO)).toBe(false)
  })
})
