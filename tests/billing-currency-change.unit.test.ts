import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectiveBillingCurrency } from '../supabase/functions/_backend/utils/billing_currency'
import { changeBillingCurrency, getBillingCurrencyState } from '../supabase/functions/_backend/utils/stripe_billing_currency'

const mocks = vi.hoisted(() => ({ plans: vi.fn(), sync: vi.fn(), syncSubscription: vi.fn(), query: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  authPrincipal: vi.fn(), servicePrincipal: {}, queryJson: mocks.plans,
  withRlsContext: (_c: unknown, _principal: unknown, run: (client: unknown) => unknown) => run({ query: mocks.query }),
}))
vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({ syncSubscriptionData: mocks.syncSubscription }))
vi.mock('../supabase/functions/_backend/utils/stripe_billing_profile_sync.ts', () => ({ syncBillingProfile: mocks.sync }))
const customer = { id: 'cus_example', currency: 'eur', metadata: {} as Record<string, string> }
const stripe = {
  customers: { retrieve: vi.fn(), update: vi.fn() },
  prices: { retrieve: vi.fn() },
  subscriptions: { list: vi.fn(), update: vi.fn() },
  subscriptionSchedules: { list: vi.fn() },
  checkout: { sessions: { list: vi.fn(), expire: vi.fn() } },
}
const ctx = { stripe, customerId: customer.id, billingAccount: 'us' } as any
const sub = { id: 'sub_example', status: 'active', currency: 'eur', cancel_at_period_end: false, items: { data: [{ current_period_end: 1893456000 }] } }
beforeEach(() => {
  vi.resetAllMocks()
  customer.metadata = {}
  stripe.customers.retrieve.mockResolvedValue(customer)
  stripe.customers.update.mockImplementation(async (_id, data) => { customer.metadata = data.metadata; return customer })
  stripe.prices.retrieve.mockResolvedValue({ active: true, currency: 'usd', currency_options: { eur: {} } })
  stripe.subscriptions.list.mockResolvedValue({ data: [], has_more: false })
  stripe.subscriptionSchedules.list.mockResolvedValue({ data: [], has_more: false })
  stripe.checkout.sessions.list.mockResolvedValue({ data: [], has_more: false })
  mocks.plans.mockResolvedValue([{ price_m_id: 'price_ee_m', price_y_id: 'price_ee_y', price_m_id_us: 'price_us_m', price_y_id_us: 'price_us_y' }])
})

describe('self-service billing currency', () => {
  it('saves an unsubscribed customer preference in Stripe and synchronizes the database without creating a charge', async () => {
    const result = await changeBillingCurrency({} as any, ctx, 'usd', null)
    expect(result.currency).toBe('usd')
    expect(stripe.customers.update).toHaveBeenCalledWith('cus_example', { metadata: { capgo_billing_currency: 'usd' } })
    expect(mocks.sync).toHaveBeenCalled()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(stripe.prices.retrieve).toHaveBeenCalledWith('price_us_m', expect.anything())
  })
  it('requires confirmation for the exact live subscription before any mutation', async () => {
    stripe.subscriptions.list.mockResolvedValue({ data: [sub] })
    await expect(changeBillingCurrency({} as any, ctx, 'usd', 'sub_stale')).rejects.toThrow()
    expect(stripe.customers.update).not.toHaveBeenCalled()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
  })
  it('ends at the paid period boundary and exposes the pending currency', async () => {
    stripe.subscriptions.list.mockResolvedValue({ data: [sub] })
    stripe.subscriptions.update.mockImplementation(async () => {
      stripe.subscriptions.list.mockResolvedValue({ data: [{ ...sub, cancel_at_period_end: true }] })
    })
    const result = await changeBillingCurrency({} as any, ctx, 'usd', sub.id)
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(sub.id, { cancel_at_period_end: true, proration_behavior: 'none' })
    expect(result).toMatchObject({ currency: 'eur', pendingCurrency: 'usd', endsAt: '2030-01-01T00:00:00.000Z' })
    expect(mocks.syncSubscription).toHaveBeenCalled()
  })
  it('only applies the selected currency to credits and checkout once the old subscription has ended', async () => {
    customer.metadata.capgo_billing_currency = 'usd'
    stripe.subscriptions.list.mockResolvedValue({ data: [sub] })
    expect(await effectiveBillingCurrency(stripe as any, customer as any)).toBe('eur')
    stripe.subscriptions.list.mockResolvedValue({ data: [{ ...sub, status: 'canceled' }] })
    expect(await effectiveBillingCurrency(stripe as any, customer as any)).toBe('usd')
  })
  it('does not display a pending cancellation after the customer resumes', async () => {
    customer.metadata.capgo_billing_currency = 'usd'
    stripe.subscriptions.list.mockResolvedValue({ data: [sub] })
    expect((await getBillingCurrencyState({} as any, ctx)).pendingCurrency).toBeNull()
  })
  it('expires stale checkouts before saving the new currency', async () => {
    stripe.checkout.sessions.list.mockResolvedValue({ data: [{ id: 'cs_example' }] })
    await changeBillingCurrency({} as any, ctx, 'usd', null)
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_example')
    expect(stripe.checkout.sessions.expire.mock.invocationCallOrder[0]).toBeLessThan(stripe.customers.update.mock.invocationCallOrder[0])
  })
  it('fails closed when subscription state is unavailable', async () => {
    stripe.subscriptions.list.mockRejectedValue(new Error('unavailable'))
    await expect(changeBillingCurrency({} as any, ctx, 'usd', null)).rejects.toThrow()
    expect(stripe.customers.update).not.toHaveBeenCalled()
  })
  it('does not report success on cancellation failure and keeps billing in the active currency', async () => {
    stripe.subscriptions.list.mockResolvedValue({ data: [sub] })
    stripe.subscriptions.update.mockRejectedValue(new Error('unavailable'))
    await expect(changeBillingCurrency({} as any, ctx, 'usd', sub.id)).rejects.toThrow()
    expect(await effectiveBillingCurrency(stripe as any, customer as any)).toBe('eur')
    expect(mocks.sync).not.toHaveBeenCalled()
  })
  it.each(['jpy', 'USD', '', undefined])('rejects currency not in this account catalog: %s', async (currency) => {
    await expect(changeBillingCurrency({} as any, ctx, currency, null)).rejects.toThrow()
    expect(stripe.customers.update).not.toHaveBeenCalled()
  })
  it('does not change a scheduled trial behind the customer’s back', async () => {
    stripe.subscriptionSchedules.list.mockResolvedValue({ data: [{ status: 'not_started' }] })
    await expect(changeBillingCurrency({} as any, ctx, 'usd', null)).rejects.toThrow()
    expect(stripe.customers.update).not.toHaveBeenCalled()
  })
})
