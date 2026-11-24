import { beforeEach, describe, expect, it, vi } from 'vitest'

// Cancel flow routes of private/stripe_billing: what they forward to the save offer
// helpers and to Stripe, and what they return. Auth and Stripe are mocked.
const mocks = vi.hoisted(() => ({
  org: vi.fn(), permission: vi.fn(), context: vi.fn(),
  accept: vi.fn(), decline: vi.fn(), complete: vi.fn(), cancel: vi.fn(), summary: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/hono_jwt.ts', () => ({
  middlewareAuth: async (c: any, next: () => Promise<void>) => {
    c.set('authorization', 'Bearer test')
    c.set('auth', { userId: 'user_example' })
    await next()
  },
}))
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  authPrincipal: vi.fn(), queryJsonOne: mocks.org,
  withRlsContext: async (_c: unknown, _principal: unknown, run: (client: unknown) => Promise<unknown>) => run({}),
}))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: mocks.permission }))
vi.mock('../supabase/functions/_backend/utils/stripe_in_app.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/stripe_in_app.ts')>(),
  getInAppBillingContext: mocks.context,
  getSubscriptionSummary: mocks.summary,
  scheduleSubscriptionCancel: mocks.cancel,
}))
vi.mock('../supabase/functions/_backend/utils/stripe_trial_plan.ts', () => ({}))
vi.mock('../supabase/functions/_backend/utils/cancel_save_offer.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/cancel_save_offer.ts')>(),
  acceptCancelSaveOffer: mocks.accept,
  declineCancelSaveOffer: mocks.decline,
  completeCreditsOfferAfterCancel: mocks.complete,
}))
const { app } = await import('../supabase/functions/_backend/private/stripe_billing')

const OFFER_ID = '00000000-0000-4000-8000-000000000002'
const ctx = { customerId: 'cus_resolved', billingAccount: 'us' }

function request(path: string, body: Record<string, unknown>) {
  return app.request(`/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: 'org_example', ...body }) })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.org.mockResolvedValue({ customer_id: 'cus_resolved' })
  mocks.permission.mockResolvedValue(true)
  mocks.context.mockResolvedValue(ctx)
  mocks.summary.mockResolvedValue({ status: 'active', cancelAtPeriodEnd: true })
})

describe('cancel-offer/accept', () => {
  it('forwards the trimmed comment and returns the credits result with the subscription', async () => {
    mocks.accept.mockResolvedValue({ type: 'credits', credits: 29 })
    const res = await request('cancel-offer/accept', { offerId: OFFER_ID, comment: '  only one app left  ' })
    expect(res.status).toBe(200)
    expect(mocks.accept).toHaveBeenCalledWith(expect.anything(), ctx, OFFER_ID, 'only one app left')
    expect(await res.json()).toEqual({ type: 'credits', credits: 29, subscription: { status: 'active', cancelAtPeriodEnd: true } })
  })

  it('returns the discount result unchanged', async () => {
    mocks.accept.mockResolvedValue({ type: 'discount', discountEnd: '2027-02-24T00:00:00.000Z' })
    const res = await request('cancel-offer/accept', { offerId: OFFER_ID })
    expect(mocks.accept).toHaveBeenCalledWith(expect.anything(), ctx, OFFER_ID, undefined)
    expect(await res.json()).toMatchObject({ type: 'discount', discountEnd: '2027-02-24T00:00:00.000Z' })
  })
})

describe('cancel with a shown offer', () => {
  it('records the decline, cancels, then completes a granted credits switch', async () => {
    mocks.cancel.mockResolvedValue({ status: 'active', cancelAtPeriodEnd: true })
    const res = await request('cancel', { reason: 'unused', comment: 'bye', offerId: OFFER_ID })
    expect(res.status).toBe(200)
    expect(mocks.decline).toHaveBeenCalledWith(expect.anything(), ctx, OFFER_ID)
    expect(mocks.cancel).toHaveBeenCalledWith(expect.anything(), ctx, 'unused', 'bye')
    expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), ctx, OFFER_ID)
    expect(mocks.decline.mock.invocationCallOrder[0]).toBeLessThan(mocks.cancel.mock.invocationCallOrder[0])
    expect(mocks.cancel.mock.invocationCallOrder[0]).toBeLessThan(mocks.complete.mock.invocationCallOrder[0])
  })

  it('does not complete the credits switch when the cancel fails', async () => {
    mocks.cancel.mockRejectedValue(new Error('stripe down'))
    const res = await request('cancel', { reason: 'unused', offerId: OFFER_ID })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(mocks.complete).not.toHaveBeenCalled()
  })
})
