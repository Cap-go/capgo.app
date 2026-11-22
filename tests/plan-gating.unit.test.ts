import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requireEnterprisePlan, requirePaidPlan } from '../supabase/functions/_backend/utils/plan-gating.ts'

const mocks = vi.hoisted(() => ({ single: vi.fn(), subscription: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  getCurrentPlanNameOrg: vi.fn(),
}))
// mocks.single answers each lookup in order with a supabase-js style `{ data }`.
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  servicePrincipal: { kind: 'service' },
  withRlsContext: async (_c: unknown, _principal: unknown, run: (client: unknown) => Promise<unknown>) => run({
    query: async () => {
      const { data } = await mocks.single()
      return { rows: data ? [data] : [] }
    },
  }),
}))
const stripeMocks = vi.hoisted(() => ({
  findLatestOpenSubscriptionInvoice: vi.fn(),
  isOpenSubscriptionInvoicePaymentProcessing: vi.fn(),
  isStripeConfiguredForAccount: vi.fn(() => true),
}))
vi.mock('../supabase/functions/_backend/utils/stripe_billing.ts', () => ({
  isStripeConfiguredForAccount: stripeMocks.isStripeConfiguredForAccount,
  normalizeBillingAccount: (account: string | null) => account ?? 'ee',
}))
vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({
  getSubscriptionData: mocks.subscription,
  planProductIdOrFilter: (productId: string) => `stripe_id.eq.${productId},stripe_id_us.eq.${productId}`,
  findLatestOpenSubscriptionInvoice: stripeMocks.findLatestOpenSubscriptionInvoice,
  getStripe: vi.fn(() => ({})),
  isOpenSubscriptionInvoicePaymentProcessing: stripeMocks.isOpenSubscriptionInvoicePaymentProcessing,
}))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlog: vi.fn(), cloudlogErr: vi.fn() }))
const context = { get: () => 'request-id' } as unknown as Context
const paidPlan = { status: 'succeeded', is_good_plan: true, product_id: 'enterprise-product', subscription_id: 'subscription-id', paid_at: '2026-01-01T00:00:00Z', past_due_at: null }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.subscription.mockResolvedValue({ ok: true, data: { status: 'active', productId: 'enterprise-product' } })
  stripeMocks.findLatestOpenSubscriptionInvoice.mockResolvedValue(null)
  stripeMocks.isOpenSubscriptionInvoicePaymentProcessing.mockResolvedValue(false)
})
function billing(info: Partial<Omit<typeof paidPlan, 'paid_at' | 'past_due_at'> & { paid_at: string | null, past_due_at: string | null, billing_account?: string | null }>, plan = 'Enterprise') {
  mocks.single.mockResolvedValueOnce({ data: { customer_id: 'customer-id' } })
    .mockResolvedValueOnce({ data: { ...paidPlan, billing_account: 'ee', ...info } })
    .mockResolvedValueOnce({ data: { name: plan } })
}

describe('paid Enterprise feature gating', () => {
  it('allows a paid Enterprise organization in good standing', async () => {
    billing({})
    await expect(requireEnterprisePlan(context, 'org-id', 'Custom domains', true)).resolves.toBeUndefined()
  })

  it.each([
    ['overdue subscription', { past_due_at: '2026-01-02T00:00:00Z' }],
    ['canceled subscription', { status: 'canceled' }],
    ['failed payment', { status: 'failed' }],
    ['bad standing', { is_good_plan: false }],
  ])('rejects %s even with an Enterprise product', async (_label, info) => {
    billing(info)
    await expect(requireEnterprisePlan(context, 'org-id', 'Custom domains', true)).rejects.toMatchObject({ status: 403 })
  })

  it.each(['trialing', 'past_due', 'canceled', 'incomplete', undefined])('rejects a live subscription with status %s', async (status) => {
    billing({})
    mocks.subscription.mockResolvedValueOnce(status ? { ok: true, data: { status, productId: 'enterprise-product' } } : { ok: false, reason: 'not_found' })
    await expect(requireEnterprisePlan(context, 'org-id', 'Custom domains', true)).rejects.toMatchObject({ status: 403 })
  })

  it('rejects a stale Enterprise billing row when the live subscription has another product', async () => {
    billing({})
    mocks.subscription.mockResolvedValueOnce({ ok: true, data: { status: 'active', productId: 'team-product' } })
    await expect(requireEnterprisePlan(context, 'org-id', 'Custom domains', true)).rejects.toMatchObject({ status: 403 })
  })

  it('allows legacy paid subscriptions without a paid_at timestamp', async () => {
    billing({ paid_at: null })
    await expect(requireEnterprisePlan(context, 'org-id', 'Custom domains', true)).resolves.toBeUndefined()
  })

  it('rejects a paid non-Enterprise plan', async () => {
    billing({}, 'Team')
    await expect(requireEnterprisePlan(context, 'org-id', 'Custom domains', true)).rejects.toMatchObject({ status: 403 })
  })

  it('keeps existing Enterprise features on their original active-plan policy', async () => {
    billing({ paid_at: null })
    await expect(requireEnterprisePlan(context, 'org-id')).resolves.toBeUndefined()
    expect(mocks.subscription).not.toHaveBeenCalled()
  })
})


describe('past-due renewal payment processing exemption', () => {
  it('allows requirePaidPlan when renewal payment is processing', async () => {
    billing({ past_due_at: '2026-01-02T00:00:00Z' })
    stripeMocks.findLatestOpenSubscriptionInvoice.mockResolvedValueOnce({ id: 'in_1' })
    stripeMocks.isOpenSubscriptionInvoicePaymentProcessing.mockResolvedValueOnce(true)
    await expect(requirePaidPlan(context, 'org-id', 'AI recommendations')).resolves.toBeUndefined()
  })

  it('rejects requirePaidPlan when past due without processing payment', async () => {
    billing({ past_due_at: '2026-01-02T00:00:00Z' })
    stripeMocks.findLatestOpenSubscriptionInvoice.mockResolvedValueOnce({ id: 'in_1' })
    stripeMocks.isOpenSubscriptionInvoicePaymentProcessing.mockResolvedValueOnce(false)
    await expect(requirePaidPlan(context, 'org-id', 'AI recommendations')).rejects.toMatchObject({ status: 403 })
  })

  it('rejects requirePaidPlan when renewal processing lookup fails', async () => {
    billing({ past_due_at: '2026-01-02T00:00:00Z' })
    stripeMocks.findLatestOpenSubscriptionInvoice.mockRejectedValueOnce(new Error('stripe unavailable'))
    await expect(requirePaidPlan(context, 'org-id', 'AI recommendations')).rejects.toMatchObject({ status: 403 })
  })
})

describe('paid AI feature gating', () => {
  it.each(['Solo', 'Maker', 'Team', 'Enterprise'])('allows paid %s plans', async (name) => {
    billing({}, name)
    await expect(requirePaidPlan(context, 'org-id', 'AI recommendations')).resolves.toBeUndefined()
  })
  it.each(['trialing', 'past_due', 'canceled', 'incomplete'])('rejects live %s subscriptions', async (status) => {
    billing({})
    mocks.subscription.mockResolvedValueOnce({ ok: true, data: { status, productId: 'enterprise-product' } })
    await expect(requirePaidPlan(context, 'org-id', 'AI recommendations')).rejects.toMatchObject({ status: 403 })
  })
  it('fails closed when Stripe cannot verify a paid subscription', async () => {
    billing({})
    mocks.subscription.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    await expect(requirePaidPlan(context, 'org-id', 'AI recommendations')).rejects.toMatchObject({ status: 403 })
  })
})
