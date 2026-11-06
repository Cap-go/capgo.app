import type Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enforceRegionalPrice, enforceRegionalPriceForCustomer, getRequestPriceTier, isRegionalCurrency, paymentMethodCountry, priceTierForCurrency } from '../supabase/functions/_backend/utils/regional_price.ts'

const findPlanByProductId = vi.hoisted(() => vi.fn())

vi.mock('../supabase/functions/_backend/utils/stripe_billing.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/stripe_billing.ts')>(),
  findPlanByProductId,
}))

const solo = {
  stripe_id: 'prod_solo',
  price_m_id: 'price_solo_m',
  price_y_id: 'price_solo_y',
  regional_price_ids: {
    p85: { price_m_id: 'price_solo_m_p85', price_y_id: 'price_solo_y_p85' },
    p50: { price_m_id: 'price_solo_m_p50', price_y_id: 'price_solo_y_p50' },
  },
}

function context(country: string | null = null) {
  return { get: () => 'request-id', req: { raw: { cf: { country } }, header: () => undefined } } as any
}

function subscription(tier: string | null, overrides: Partial<Stripe.Subscription> = {}) {
  return {
    id: 'sub_1',
    status: 'active',
    currency: 'inr',
    customer: 'cus_1',
    default_payment_method: 'pm_1',
    items: { data: [{ id: 'si_1', price: { id: tier ? `price_solo_m_${tier}` : 'price_solo_m', product: 'prod_solo', recurring: { interval: 'month', usage_type: 'licensed' }, metadata: tier ? { capgo_tier: tier } : {} } }] },
    ...overrides,
  } as unknown as Stripe.Subscription
}

// Currencies Stripe sells the regional prices in (no GHS, so Ghana buys in USD).
const SOLD_CURRENCIES = ['eur', 'inr', 'usd']

function fakeStripe(cardCountry: string | null, addressCountry: string | null = null, live?: Stripe.Subscription) {
  const update = vi.fn(async () => ({}))
  const retrieve = vi.fn(async (id: string) => live ?? subscription('p50', { id }))
  const stripe = {
    prices: { retrieve: vi.fn(async (id: string) => ({ id, currency: 'usd', currency_options: Object.fromEntries(SOLD_CURRENCIES.map(currency => [currency, { unit_amount: 100 }])) })) },
    customers: { retrieve: vi.fn(async () => ({ id: 'cus_1', currency: 'eur', address: addressCountry ? { country: addressCountry } : null, invoice_settings: { default_payment_method: null } })) },
    paymentMethods: { retrieve: vi.fn(async () => ({ id: 'pm_1', card: cardCountry ? { country: cardCountry } : null, billing_details: { address: null } })) },
    subscriptions: { update, retrieve, list: vi.fn(async () => ({ data: [subscription(null, { id: 'sub_full' }), subscription('p50')] })) },
  } as unknown as Stripe
  return { stripe, update }
}

describe('regional price guard', () => {
  beforeEach(() => {
    findPlanByProductId.mockReset()
    findPlanByProductId.mockResolvedValue({ data: solo, error: null })
  })

  it('raises a discount paid with a card from a more expensive country and invoices the difference', async () => {
    const { stripe, update } = fakeStripe('DE', null, subscription('p50', { currency: 'eur' }))
    await expect(enforceRegionalPrice(context(), stripe, 'ee', subscription('p50'))).resolves.toBe(true)
    expect(update).toHaveBeenCalledWith('sub_1', { items: [{ id: 'si_1', price: 'price_solo_m_p85' }], proration_behavior: 'always_invoice' })
  })

  it('uses the billing address too', async () => {
    const { stripe, update } = fakeStripe('IN', 'US')
    await enforceRegionalPrice(context(), stripe, 'ee', subscription('p50'))
    expect(update).toHaveBeenCalledWith('sub_1', expect.objectContaining({ items: [{ id: 'si_1', price: 'price_solo_m' }] }))
  })

  it('keeps the discount for a local card and address', async () => {
    const { stripe, update } = fakeStripe('IN', 'IN')
    await expect(enforceRegionalPrice(context(), stripe, 'ee', subscription('p50'))).resolves.toBe(false)
    expect(update).not.toHaveBeenCalled()
  })

  it('charges the full price when nothing proves the region', async () => {
    const { stripe, update } = fakeStripe(null)
    await enforceRegionalPrice(context(), stripe, 'ee', subscription('p50'))
    expect(update).toHaveBeenCalledWith('sub_1', expect.objectContaining({ items: [{ id: 'si_1', price: 'price_solo_m' }] }))
  })

  it('leaves full prices and unpaid subscriptions alone', async () => {
    const { stripe, update } = fakeStripe('DE', null, subscription('p50', { status: 'incomplete' }))
    await expect(enforceRegionalPrice(context(), stripe, 'ee', subscription(null))).resolves.toBe(false)
    await expect(enforceRegionalPrice(context(), stripe, 'ee', subscription('p50'))).resolves.toBe(false)
    expect(update).not.toHaveBeenCalled()
    expect(stripe.customers.retrieve).not.toHaveBeenCalled()
  })

  it('waits for a trial-plan schedule to release the subscription', async () => {
    const { stripe, update } = fakeStripe('DE', null, subscription('p50', { schedule: 'sub_sched_1' }))
    await expect(enforceRegionalPrice(context(), stripe, 'ee', subscription('p50'))).resolves.toBe(false)
    expect(update).not.toHaveBeenCalled()
  })

  it('rechecks the customer subscriptions when the billing details change', async () => {
    const { stripe, update } = fakeStripe('IN', 'DE', subscription('p50', { currency: 'eur' }))
    await expect(enforceRegionalPriceForCustomer(context(), stripe, 'ee', 'cus_1')).resolves.toBe(true)
    expect(stripe.subscriptions.list).toHaveBeenCalledWith({ customer: 'cus_1', status: 'all', limit: 100 })
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith('sub_1', expect.objectContaining({ items: [{ id: 'si_1', price: 'price_solo_m_p85' }] }))
  })

  it('charges the full price when billed in another market\'s currency', async () => {
    // An org pinned to USD (or a buyer who picked USD) in India: the discount is priced in rupees.
    const { stripe, update } = fakeStripe('IN', 'IN', subscription('p50', { currency: 'usd' }))
    await expect(enforceRegionalPrice(context(), stripe, 'ee', subscription('p50'))).resolves.toBe(true)
    expect(update).toHaveBeenCalledWith('sub_1', expect.objectContaining({ items: [{ id: 'si_1', price: 'price_solo_m' }] }))
  })

  it('accepts USD where Stripe does not sell the local currency', async () => {
    const { stripe, update } = fakeStripe('GH', 'GH', subscription('p50', { currency: 'usd' }))
    await expect(enforceRegionalPrice(context(), stripe, 'ee', subscription('p50'))).resolves.toBe(false)
    expect(update).not.toHaveBeenCalled()
  })

  it('decides on the live subscription when the event is stale', async () => {
    const { stripe, update } = fakeStripe('DE', null, subscription(null))
    await expect(enforceRegionalPrice(context(), stripe, 'ee', subscription('p50'))).resolves.toBe(false)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_1')
    expect(update).not.toHaveBeenCalled()
  })

  it('offers the tier of the most expensive known country', () => {
    expect(getRequestPriceTier(context('IN'))).toBe('p50')
    expect(getRequestPriceTier(context('IN'), ['FR'])).toBe('p70')
    expect(getRequestPriceTier(context(null))).toBe('p100')
  })

  it('sells a regional price only in its region\'s currency, or USD where Stripe lacks it', () => {
    expect(isRegionalCurrency(['FR'], 'p70', 'eur', SOLD_CURRENCIES)).toBe(true)
    expect(isRegionalCurrency(['FR'], 'p70', 'usd', SOLD_CURRENCIES)).toBe(false)
    expect(isRegionalCurrency(['GH'], 'p50', 'usd', SOLD_CURRENCIES)).toBe(true)
    expect(isRegionalCurrency(['GH'], 'p50', 'eur', SOLD_CURRENCIES)).toBe(false)
    // Without the sold currencies, USD only passes for countries without a known currency.
    expect(isRegionalCurrency(['GH'], 'p50', 'usd', null)).toBe(false)
    expect(isRegionalCurrency(['US'], 'p100', 'eur', SOLD_CURRENCIES)).toBe(true)
    // The country granting the tier decides: an Indian card does not make EUR regional for France.
    expect(priceTierForCurrency(['IN', 'FR'], 'eur', SOLD_CURRENCIES)).toBe('p70')
    expect(priceTierForCurrency(['IN', 'FR'], 'inr', SOLD_CURRENCIES)).toBe('p100')
  })

  it('reads the country of cards and debit mandates', () => {
    expect(paymentMethodCountry({ card: { country: 'BR' } } as any)).toBe('BR')
    expect(paymentMethodCountry({ sepa_debit: { country: 'ES' } } as any)).toBe('ES')
    expect(paymentMethodCountry({ billing_details: { address: { country: 'PT' } } } as any)).toBe('PT')
    expect(paymentMethodCountry('pm_1')).toBeNull()
  })
})
