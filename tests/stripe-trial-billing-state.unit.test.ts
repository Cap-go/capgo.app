import { beforeEach, expect, it, vi } from 'vitest'
import { scheduleTrialPlan, startTrialPlanNow } from '../supabase/functions/_backend/utils/stripe_trial_plan'

const mocks = vi.hoisted(() => ({ billing: vi.fn(), assertHeld: vi.fn(), lockLost: false }))
vi.mock('../supabase/functions/_backend/utils/regional_price.ts', async (original) => ({
  ...await original<typeof import('../supabase/functions/_backend/utils/regional_price')>(), getCustomerBilling: mocks.billing,
}))
vi.mock('../supabase/functions/_backend/utils/billing_profile_lock.ts', () => ({
  billingRequestOptions: { timeout: 10000, maxNetworkRetries: 1 },
  withBillingProfileLock: (_c: unknown, _account: string, _customer: string, run: (assertHeld: () => Promise<void>) => unknown) => run(mocks.assertHeld),
}))
vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({ getStripe: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({ syncBentoSubscriberTags: vi.fn(), trackBentoEvent: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  TRANSACTION_IDLE_TIMEOUT_MS: 10000,
  getPgClient: vi.fn(), checkoutPgClient: async () => ({ query: async () => ({ rows: [] }) }), releasePgClient: vi.fn(), closeClient: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  servicePrincipal: {}, withRlsContext: (_c: unknown, _p: unknown, run: (client: unknown) => unknown) => run({ query: async () => ({ rows: [] }) }),
  queryJson: async (_client: unknown, sql: string) => sql.includes('stripe_info') ? [{ product_id: 'prod_solo', trial_at: '2100-01-01', status: null, subscription_id: null }] : [],
}))
vi.mock('../supabase/functions/_backend/utils/stripe_billing.ts', async (original) => ({
  ...await original<typeof import('../supabase/functions/_backend/utils/stripe_billing')>(),
  getRequestCountry: () => 'IN',
  findPlanByProductId: async () => ({ data: { name: 'Solo', stripe_id: 'prod_solo', price_m_id: 'price_full', regional_price_ids: { p50: { price_m_id: 'price_regional' } } } }),
}))
const stripe = {
  customers: { retrieve: vi.fn(), update: vi.fn() },
  subscriptions: { list: vi.fn(), create: vi.fn() },
  subscriptionSchedules: { list: vi.fn(), create: vi.fn(), cancel: vi.fn() },
  prices: { retrieve: vi.fn() },
}
const c = { get: () => undefined } as any
const ctx = { customerId: 'cus_trial_example', stripe, billingAccount: 'ee' } as any
beforeEach(() => {
  vi.resetAllMocks()
  mocks.lockLost = false
  mocks.assertHeld.mockImplementation(async () => { if (mocks.lockLost) throw new Error('billing lock lost') })
  mocks.billing.mockResolvedValue({ countries: ['IN'], currency: 'inr' })
  stripe.customers.retrieve.mockResolvedValue({ address: { country: 'IN' }, invoice_settings: { default_payment_method: 'pm_example' } })
  stripe.subscriptions.list.mockResolvedValue({ data: [] })
  stripe.subscriptionSchedules.list.mockResolvedValue({ data: [] })
  stripe.subscriptionSchedules.create.mockResolvedValue({ id: 'sched_new' })
  stripe.prices.retrieve.mockResolvedValue({ id: 'price_full', currency: 'inr', unit_amount: 1000, currency_options: { inr: { unit_amount: 1000 }, usd: { unit_amount: 1400 } } })
})

it.each([scheduleTrialPlan, startTrialPlanNow])('rejects a currency change between the price snapshot and the billing lock: %s', async (run) => {
  mocks.billing.mockResolvedValueOnce({ countries: ['IN'], currency: 'inr' }).mockResolvedValue({ countries: ['IN'], currency: 'usd' })
  await expect(run(c, ctx, 'org_example')).rejects.toThrow('billing currency changed')
  expect(mocks.billing).toHaveBeenCalledTimes(2)
  expect(stripe.subscriptions.create).not.toHaveBeenCalled()
  expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled()
})

it.each([scheduleTrialPlan, startTrialPlanNow])('does not create a plan if the billing lock is lost during the live subscription lookup: %s', async (run) => {
  stripe.subscriptions.list.mockImplementation(async () => { mocks.lockLost = true; return { data: [] } })
  await expect(run(c, ctx, 'org_example')).rejects.toThrow('billing lock lost')
  expect(stripe.subscriptions.create).not.toHaveBeenCalled()
  expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled()
})

it('does not create a schedule after losing the lock during the schedule lookup', async () => {
  stripe.subscriptionSchedules.list.mockImplementation(async () => { mocks.lockLost = true; return { data: [] } })
  await expect(scheduleTrialPlan(c, ctx, 'org_example')).rejects.toThrow('billing lock lost')
  expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled()
})

it('does not cancel another schedule if the billing lock is lost during cleanup reads', async () => {
  stripe.subscriptionSchedules.list.mockResolvedValueOnce({ data: [] }).mockImplementation(async () => {
    mocks.lockLost = true
    return { data: ['sched_new', 'sched_duplicate'].map((id, created) => ({ id, created, status: 'not_started', metadata: { capgo_trial_plan: 'true' } })) }
  })
  await expect(scheduleTrialPlan(c, ctx, 'org_example')).rejects.toThrow('billing lock lost')
  expect(stripe.subscriptionSchedules.create).toHaveBeenCalledTimes(1)
  expect(stripe.subscriptionSchedules.cancel).not.toHaveBeenCalled()
})

it.each([
  { currency: 'inr', countries: ['IN'], price: 'price_regional', billed: 'inr' },
  { currency: null, countries: ['US'], price: 'price_full', billed: 'usd' },
])('schedules the matching price and currency from an unchanged snapshot: %j', async ({ currency, countries, price, billed }) => {
  mocks.billing.mockResolvedValue({ currency, countries })
  await scheduleTrialPlan(c, ctx, 'org_example')
  expect(stripe.subscriptionSchedules.create).toHaveBeenCalledWith(expect.objectContaining({
    phases: [expect.objectContaining({ currency: billed, items: [{ price, quantity: 1 }] })],
  }), expect.anything())
})
