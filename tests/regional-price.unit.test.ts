import type Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enforceRegionalPrice, getRequestPriceTier, paymentMethodCountry } from '../supabase/functions/_backend/utils/regional_price.ts'

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
    customer: 'cus_1',
    default_payment_method: 'pm_1',
    items: { data: [{ id: 'si_1', price: { id: tier ? `price_solo_m_${tier}` : 'price_solo_m', product: 'prod_solo', recurring: { interval: 'month', usage_type: 'licensed' }, metadata: tier ? { capgo_tier: tier } : {} } }] },
    ...overrides,
  } as unknown as Stripe.Subscription
}

function fakeStripe(cardCountry: string | null, addressCountry: string | null = null, live?: Stripe.Subscription) {
  const update = vi.fn(async () => ({}))
  const retrieve = vi.fn(async (id: string) => live ?? subscription('p50', { id }))
  const stripe = {
    customers: { retrieve: vi.fn(async () => ({ id: 'cus_1', currency: 'eur', address: addressCountry ? { country: addressCountry } : null, invoice_settings: { default_payment_method: null } })) },
    paymentMethods: { retrieve: vi.fn(async () => ({ id: 'pm_1', card: cardCountry ? { country: cardCountry } : null, billing_details: { address: null } })) },
    subscriptions: { update, retrieve },
  } as unknown as Stripe
  return { stripe, update }
}

describe('regional price guard', () => {
  beforeEach(() => {
    findPlanByProductId.mockReset()
    findPlanByProductId.mockResolvedValue({ data: solo, error: null })
  })

  it('raises a discount paid with a card from a more expensive country and invoices the difference', async () => {
    const { stripe, update } = fakeStripe('DE')
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

  it('reads the country of cards and debit mandates', () => {
    expect(paymentMethodCountry({ card: { country: 'BR' } } as any)).toBe('BR')
    expect(paymentMethodCountry({ sepa_debit: { country: 'ES' } } as any)).toBe('ES')
    expect(paymentMethodCountry({ billing_details: { address: { country: 'PT' } } } as any)).toBe('PT')
    expect(paymentMethodCountry('pm_1')).toBeNull()
  })
})
