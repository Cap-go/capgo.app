import { beforeEach, describe, expect, it, vi } from 'vitest'
import { completeCurrencyTransition, previewCurrencyTransition } from '../supabase/functions/_backend/utils/billing_currency_transition'
const mocks = vi.hoisted(() => ({ fullPrice: vi.fn(), query: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({ getCheckoutPlanPrice: mocks.fullPrice }))
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({ servicePrincipal: {}, withRlsContext: (_c: unknown, _p: unknown, run: (client: unknown) => unknown) => run({ query: mocks.query }) }))
const stripe = {
  customers: { retrieve: vi.fn(), update: vi.fn() }, prices: { retrieve: vi.fn() }, paymentMethods: { retrieve: vi.fn() },
  subscriptions: { retrieve: vi.fn(), list: vi.fn(), create: vi.fn() }, invoices: { createPreview: vi.fn() },
}
const ctx = { currentSubscriptionId: 'sub_old', customerId: 'cus_example', stripe, billingAccount: 'us', publishableKey: '' } as any
let sub: any
beforeEach(() => {
  vi.resetAllMocks()
  sub = {
    id: 'sub_old', customer: 'cus_example', status: 'canceled', currency: 'eur', ended_at: 1893456000,
    metadata: { capgo_currency_transition: 'usd', capgo_currency_transition_end: '1893456000', org_id: 'org_example' },
    collection_method: 'charge_automatically', default_payment_method: 'pm_example', automatic_tax: { enabled: true },
    discounts: ['di_example'], default_tax_rates: [],
    items: { data: [{ price: { id: 'price_main', recurring: { interval: 'year' } }, quantity: 2, current_period_end: 1893456000, tax_rates: [] }] },
  }
  stripe.subscriptions.retrieve.mockResolvedValue(sub)
  stripe.subscriptions.list.mockResolvedValue({ data: [sub], has_more: false })
  stripe.subscriptions.create.mockResolvedValue({ id: 'sub_new' })
  stripe.prices.retrieve.mockResolvedValue({ id: 'price_main', active: true, currency: 'usd', currency_options: { eur: {} }, metadata: {}, recurring: { interval: 'year' } })
  stripe.customers.retrieve.mockResolvedValue({ id: 'cus_example', metadata: { capgo_billing_currency: 'usd' }, address: { country: 'AR' }, invoice_settings: {} })
  stripe.paymentMethods.retrieve.mockResolvedValue({ card: { country: 'AR' } })
  stripe.invoices.createPreview.mockResolvedValue({ total: 28000 })
})
describe('automatic currency replacement', () => {
  it('automatically creates the replacement with the selected currency, existing quantities, interval, discounts and saved payment method', async () => {
    expect(await completeCurrencyTransition({} as any, ctx, sub)).toBe(true)
    expect(stripe.subscriptions.create).toHaveBeenCalledWith(expect.objectContaining({
      customer: 'cus_example', currency: 'usd', items: [{ price: 'price_main', quantity: 2 }],
      payment_behavior: 'allow_incomplete', off_session: true, default_payment_method: 'pm_example', discounts: [{ discount: 'di_example' }],
      metadata: { org_id: 'org_example', capgo_currency_replaces: 'sub_old' }, proration_behavior: 'none',
    }), { idempotencyKey: 'currency-replacement:sub_old' })
  })
  it('does not charge again when a replacement exists, including after the idempotency window', async () => {
    stripe.subscriptions.list.mockResolvedValue({ data: [{ id: 'sub_new', status: 'canceled', metadata: { capgo_currency_replaces: sub.id } }] })
    expect(await completeCurrencyTransition({} as any, ctx, sub)).toBe(true)
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
  })
  it('survives a lost create response and retries without another charge', async () => {
    stripe.subscriptions.create.mockImplementationOnce(async () => {
      stripe.subscriptions.list.mockResolvedValue({ data: [{ id: 'sub_new', metadata: { capgo_currency_replaces: sub.id } }] })
      throw new Error('response lost')
    })
    await expect(completeCurrencyTransition({} as any, ctx, sub)).rejects.toThrow('response lost')
    expect(await completeCurrencyTransition({} as any, ctx, sub)).toBe(true)
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1)
  })
  it.each(['payment_failed', 'payment_disputed'])('never restarts a subscription canceled for %s', async (reason) => {
    sub.cancellation_details = { reason }
    expect(await completeCurrencyTransition({} as any, ctx, sub)).toBe(false)
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
  })
  it('never restarts an early cancellation or a deleted customer', async () => {
    sub.ended_at--
    expect(await completeCurrencyTransition({} as any, ctx, sub)).toBe(false)
    sub.ended_at++
    stripe.customers.retrieve.mockResolvedValue({ deleted: true })
    expect(await completeCurrencyTransition({} as any, ctx, sub)).toBe(false)
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
  })
  it('uses live metadata so a stale deletion event cannot revive an abandoned transition', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue({ ...sub, metadata: {} })
    expect(await completeCurrencyTransition({} as any, ctx, sub)).toBe(false)
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
  })
  it('does not add a second subscription after another checkout', async () => {
    stripe.subscriptions.list.mockResolvedValue({ data: [sub, { id: 'sub_other', status: 'active', metadata: {} }] })
    expect(await completeCurrencyTransition({} as any, ctx, sub)).toBe(false)
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
  })
  it('previews the future renewal and detects changed prices in its confirmation token', async () => {
    const first = await previewCurrencyTransition({} as any, ctx, sub, 'usd')
    expect(first).toMatchObject({ currency: 'usd', amount: 28000, interval: 'year', subscriptionId: sub.id })
    expect(stripe.invoices.createPreview).toHaveBeenCalledWith(expect.objectContaining({ subscription_details: expect.objectContaining({ start_date: 1893456000 }) }))
    stripe.invoices.createPreview.mockResolvedValue({ total: 29000 })
    expect((await previewCurrencyTransition({} as any, ctx, sub, 'usd')).quoteId).not.toBe(first.quoteId)
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
  })
  it('falls back to standard pricing when the card country does not match the billing country', async () => {
    stripe.prices.retrieve.mockResolvedValue({ id: 'price_regional', product: 'prod_example', active: true, currency: 'ars', currency_options: {}, recurring: { interval: 'year' }, metadata: { capgo_tier: 'p50' } })
    stripe.paymentMethods.retrieve.mockResolvedValue({ card: { country: 'US' } })
    mocks.fullPrice.mockResolvedValue({ id: 'price_standard', active: true, currency: 'ars' })
    await previewCurrencyTransition({} as any, ctx, sub, 'ars')
    expect(mocks.fullPrice).toHaveBeenCalled()
    expect(stripe.invoices.createPreview).toHaveBeenCalledWith(expect.objectContaining({ subscription_details: expect.objectContaining({ items: [{ price: 'price_standard', quantity: 2 }] }) }))
  })
})

it('treats authentication-required payments as the existing replacement, not a reason to charge again', async () => {
  stripe.subscriptions.create.mockImplementationOnce(async () => {
    const replacement = { id: 'sub_new', status: 'incomplete', metadata: { capgo_currency_replaces: sub.id } }
    stripe.subscriptions.list.mockResolvedValue({ data: [replacement] })
    return replacement
  })
  expect(await completeCurrencyTransition({} as any, ctx, sub)).toBe(true)
  expect(await completeCurrencyTransition({} as any, ctx, sub)).toBe(true)
  expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1)
})

it('does not restart an obsolete subscription after Capgo has moved to a different one', async () => {
  expect(await completeCurrencyTransition({} as any, { ...ctx, currentSubscriptionId: 'sub_later' }, sub)).toBe(false)
  expect(stripe.subscriptions.create).not.toHaveBeenCalled()
})

it('completes the confirmed transition even if saving the customer preference previously failed', async () => {
  stripe.customers.retrieve.mockResolvedValue({ metadata: {}, invoice_settings: {} })
  expect(await completeCurrencyTransition({} as any, ctx, sub)).toBe(true)
  expect(stripe.customers.update).toHaveBeenCalledWith('cus_example', { metadata: { capgo_billing_currency: 'usd' } })
})
