import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectiveBillingCurrency } from '../supabase/functions/_backend/utils/billing_currency'
import { changeBillingCurrency, getBillingCurrencyState } from '../supabase/functions/_backend/utils/stripe_billing_currency'

const mocks = vi.hoisted(() => ({ eligibility: vi.fn(), plans: vi.fn(), sync: vi.fn(), syncSubscription: vi.fn(), query: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  authPrincipal: vi.fn(), queryJsonOne: mocks.eligibility, servicePrincipal: {}, queryJson: mocks.plans,
  withRlsContext: (_c: unknown, _principal: unknown, run: (client: unknown) => unknown) => run({ query: mocks.query }),
}))
vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({ syncSubscriptionData: mocks.syncSubscription }))
vi.mock('../supabase/functions/_backend/utils/stripe_billing_profile_sync.ts', () => ({ syncBillingProfile: mocks.sync }))
vi.mock('../supabase/functions/_backend/utils/billing_currency_transition.ts', () => ({
  CURRENCY_TRANSITION_KEY: 'capgo_currency_transition', CURRENCY_TRANSITION_END_KEY: 'capgo_currency_transition_end',
  previewCurrencyTransition: async () => ({ quoteId: 'quote_example' }),
}))
const customer = { id: 'cus_example', currency: 'eur', metadata: {} as Record<string, string> }
const stripe = {
  customers: { retrieve: vi.fn(), update: vi.fn() },
  prices: { retrieve: vi.fn() },
  subscriptions: { list: vi.fn(), update: vi.fn(), retrieve: vi.fn() },
  subscriptionSchedules: { list: vi.fn() },
  checkout: { sessions: { list: vi.fn(), expire: vi.fn() } },
}
const ctx = { stripe, customerId: customer.id, billingAccount: 'us' } as any
const sub = { id: 'sub_example', status: 'active', currency: 'eur', cancel_at_period_end: false, items: { data: [{ current_period_end: 1893456000 }] } }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.eligibility.mockResolvedValue({ trial: false, plan_name: 'Team' })
  customer.metadata = {}
  stripe.customers.retrieve.mockResolvedValue(customer)
  stripe.customers.update.mockImplementation(async (_id, data) => { customer.metadata = data.metadata; return customer })
  stripe.prices.retrieve.mockResolvedValue({ active: true, currency: 'usd', currency_options: { eur: {} } })
  stripe.subscriptions.retrieve.mockResolvedValue(sub)
  stripe.subscriptions.list.mockResolvedValue({ data: [], has_more: false })
  stripe.subscriptionSchedules.list.mockResolvedValue({ data: [], has_more: false })
  stripe.checkout.sessions.list.mockResolvedValue({ data: [], has_more: false })
  mocks.plans.mockResolvedValue([{ price_m_id: 'price_ee_m', price_y_id: 'price_ee_y', price_m_id_us: 'price_us_m', price_y_id_us: 'price_us_y' }])
})

describe('self-service billing currency', () => {
  it('saves an unsubscribed customer preference in Stripe and synchronizes the database without creating a charge', async () => {
    const result = await changeBillingCurrency({} as any, ctx, 'usd', null)
    expect(result.currency).toBe('usd')
    expect(stripe.customers.update).toHaveBeenCalledWith('cus_example', { metadata: { capgo_billing_currency: 'usd' } }, expect.anything())
    expect(mocks.sync).toHaveBeenCalled()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(stripe.prices.retrieve).toHaveBeenCalledWith('price_us_m', expect.anything(), expect.anything())
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
      stripe.subscriptions.list.mockResolvedValue({ data: [{ ...sub, cancel_at_period_end: true, metadata: { capgo_currency_transition: 'usd' } }] })
    })
    const result = await changeBillingCurrency({} as any, ctx, 'usd', sub.id, 'quote_example')
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(sub.id, { cancel_at_period_end: true, proration_behavior: 'none', metadata: { capgo_currency_transition: 'usd', capgo_currency_transition_end: '1893456000' } })
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
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_example', {}, expect.anything())
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
    await expect(changeBillingCurrency({} as any, ctx, 'usd', sub.id, 'quote_example')).rejects.toThrow()
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

it('rejects an unreviewed or stale renewal quote before mutating Stripe', async () => {
  stripe.subscriptions.list.mockResolvedValue({ data: [sub] })
  await expect(changeBillingCurrency({} as any, ctx, 'usd', sub.id, 'old_quote')).rejects.toThrow()
  expect(stripe.customers.update).not.toHaveBeenCalled()
})

it.each([
  { live: false, trial: false, plan: 'Solo', expected: false },
  { live: true, trial: false, plan: 'Solo', expected: true },
  { live: false, trial: true, plan: 'Team', expected: true },
  { live: true, trial: true, plan: 'Team', expected: false },
])('only explains regional discounts for a current trial or Solo plan: %j', async ({ live, trial, plan, expected }) => {
  mocks.eligibility.mockResolvedValue({ trial, plan_name: plan })
  stripe.subscriptions.list.mockResolvedValue({ data: live ? [sub] : [] })
  expect((await getBillingCurrencyState({} as any, ctx)).regionalDiscountEligible).toBe(expected)
})

it('checks later pages and prefers the live currency even without saved metadata', async () => {
  stripe.subscriptions.list.mockResolvedValueOnce({ data: [{ id: 'sub_historical', status: 'canceled' }], has_more: true }).mockResolvedValueOnce({ data: [{ ...sub, currency: 'usd' }], has_more: false })
  expect(await effectiveBillingCurrency(stripe as any, customer as any)).toBe('usd')
  expect(stripe.subscriptions.list).toHaveBeenLastCalledWith(expect.objectContaining({ starting_after: 'sub_historical' }))
})
it('rejects the current currency while a transition is pending, before expiring checkouts', async () => {
  stripe.subscriptions.list.mockResolvedValue({ data: [{ ...sub, metadata: { capgo_currency_transition: 'usd' } }] })
  await expect(changeBillingCurrency({} as any, ctx, 'eur', sub.id)).rejects.toThrow('Keep my plan')
  expect(stripe.checkout.sessions.list).not.toHaveBeenCalled()
  expect(stripe.customers.update).not.toHaveBeenCalled()
})

it('ignores plans missing account prices and inactive prices in the currency catalog', async () => {
  mocks.plans.mockResolvedValue([
    { price_m_id_us: null, price_y_id_us: null },
    { price_m_id_us: 'price_us_m', price_y_id_us: 'price_us_y' },
    { price_m_id_us: 'price_archived', price_y_id_us: 'price_archived' },
  ])
  stripe.prices.retrieve.mockImplementation(async id => ({ active: id !== 'price_archived', currency: 'usd', currency_options: { eur: {} } }))
  expect((await getBillingCurrencyState({} as any, ctx)).currencies).toEqual(['eur', 'usd'])
  expect(stripe.prices.retrieve.mock.calls.every(([id]) => !!id)).toBe(true)
})

it('rechecks live subscriptions after closing a concurrent checkout', async () => {
  stripe.subscriptions.list.mockResolvedValueOnce({ data: [], has_more: false }).mockResolvedValueOnce({ data: [sub], has_more: false })
  await expect(changeBillingCurrency({} as any, ctx, 'usd', null)).rejects.toThrow('checkout completed')
  expect(stripe.customers.update).not.toHaveBeenCalled()
})
