import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import { getCreditQuote, resolveCreditQuote } from '../supabase/functions/_backend/utils/credit_currency'

const price = { active: true, type: 'one_time', billing_scheme: 'per_unit', currency: 'usd', unit_amount: 100, currency_options: { eur: { unit_amount: 92 }, jpy: { unit_amount: 150 }, kwd: { unit_amount_decimal: '310.5' } } } as unknown as Stripe.Price
const customer = (currency: string | null, country = 'DE') => ({ currency, address: { country } }) as Stripe.Customer

describe('credit currency price selection', () => {
  it.concurrent('uses the existing currency even after a move to another country', () => {
    expect(resolveCreditQuote(price, customer('eur', 'US'))).toEqual({ currency: 'eur', unitAmount: 92, unitPrice: 0.92 })
  })
  it.concurrent('selects the billing country currency for a new customer', () => {
    expect(resolveCreditQuote(price, customer(null))).toMatchObject({ currency: 'eur', unitPrice: 0.92 })
  })
  it.concurrent('supports zero-decimal and fractional three-decimal prices', () => {
    expect(resolveCreditQuote(price, customer('jpy')).unitPrice).toBe(150)
    expect(resolveCreditQuote(price, customer('kwd')).unitPrice).toBe(0.3105)
  })
  it.concurrent('rejects unavailable locked currencies instead of charging USD', () => {
    expect(() => resolveCreditQuote(price, customer('gbp'))).toThrow()
  })
  it.concurrent.each([
    { active: false }, { billing_scheme: 'tiered' }, { transform_quantity: { divide_by: 10 } },
    { type: 'recurring' }, { unit_amount: null },
  ])('rejects prices whose quantity is not a single credit: %j', (override) => {
    expect(() => resolveCreditQuote({ ...price, ...override } as Stripe.Price, customer('usd'))).toThrow()
  })
})


vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  servicePrincipal: { kind: 'service' },
  withRlsContext: (_c: unknown, _p: unknown, run: (client: unknown) => unknown) => run({}),
  queryJsonOne: async () => ({ credit_id: 'prod_credit_ee', price_m_id: 'price_full_ee', price_m_id_us: 'price_full_us' }),
}))
it.concurrent('converts a USD-only US credit price using the standard US plan catalog, preserving the credit product', async () => {
  const retrieve = vi.fn(async (id: string) => id === 'price_credit'
    ? { ...price, product: 'prod_credit_us', currency_options: {} }
    : { active: true, currency: 'usd', unit_amount: 1400, currency_options: { eur: { unit_amount: 1288 } } })
  const stripe = { subscriptions: { list: async () => ({ data: [] }) }, customers: { retrieve: async () => customer('eur') }, prices: { retrieve } } as unknown as Stripe
  const quote = await getCreditQuote(stripe, 'cus_example', 'price_credit', {} as any)
  expect(quote).toMatchObject({ currency: 'eur', unitAmount: 92, unitPrice: 0.92, priceData: { product: 'prod_credit_us', currency: 'eur', unit_amount_decimal: '92' } })
  expect(retrieve).toHaveBeenCalledWith('price_full_us', { expand: ['currency_options'] })
})

it.concurrent.each(['active', 'canceled'])('quotes credits using the saved currency only after subscription status becomes %s', async (status) => {
  const saved = { ...customer('eur'), id: 'cus_example', metadata: { capgo_billing_currency: 'usd' } }
  const stripe = {
    customers: { retrieve: async () => saved }, prices: { retrieve: async () => price },
    subscriptions: { list: async () => ({ data: [{ status, currency: 'eur' }] }) },
  } as unknown as Stripe
  expect((await getCreditQuote(stripe, saved.id, 'price_example')).currency).toBe(status === 'active' ? 'eur' : 'usd')
})
