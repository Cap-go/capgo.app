import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userId: 'user_example' as string | null,
  org: vi.fn(), permission: vi.fn(), context: vi.fn(),
  profile: vi.fn(), update: vi.fn(), add: vi.fn(), remove: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/hono_jwt.ts', () => ({
  middlewareAuth: async (c: any, next: () => Promise<void>) => {
    c.set('authorization', 'Bearer test')
    c.set('auth', { userId: mocks.userId })
    await next()
  },
}))
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  authPrincipal: vi.fn(), queryJsonOne: mocks.org,
  withRlsContext: async (_c: unknown, _principal: unknown, run: (client: unknown) => Promise<unknown>) => run({}),
}))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: mocks.permission }))
vi.mock('../supabase/functions/_backend/utils/stripe_in_app.ts', () => ({ getInAppBillingContext: mocks.context }))
vi.mock('../supabase/functions/_backend/utils/stripe_trial_plan.ts', () => ({}))
vi.mock('../supabase/functions/_backend/utils/cancel_save_offer.ts', () => ({}))
vi.mock('../supabase/functions/_backend/utils/stripe_billing_profile.ts', () => ({
  getBillingProfile: mocks.profile, updateBillingDetails: mocks.update, addBillingTaxId: mocks.add, removeBillingTaxId: mocks.remove,
}))
const { app } = await import('../supabase/functions/_backend/private/stripe_billing')
app.onError((_err, c) => c.json({ error: 'rejected' }, 400))
const operations = [
  { path: 'profile', permission: 'org.read_billing', action: mocks.profile },
  { path: 'profile/update', permission: 'org.update_billing', action: mocks.update },
  { path: 'tax-id/add', permission: 'org.update_billing', action: mocks.add },
  { path: 'tax-id/remove', permission: 'org.update_billing', action: mocks.remove },
]
function request(path: string, body: Record<string, unknown> = {}) {
  return app.request(`/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: 'org_example', ...body }) })
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.userId = 'user_example'
  mocks.org.mockResolvedValue({ customer_id: 'cus_resolved' })
  mocks.permission.mockResolvedValue(true)
  mocks.context.mockResolvedValue({ customerId: 'cus_resolved', billingAccount: 'us' })
  for (const operation of operations)
    operation.action.mockResolvedValue({ status: 'ok' })
})
describe.each(operations)('$path authorization', ({ path, permission, action }) => {
  it('requires organization billing permission before accessing Stripe', async () => {
    mocks.permission.mockResolvedValue(false)
    expect((await request(path)).status).toBe(400)
    expect(mocks.permission).toHaveBeenCalledWith(expect.anything(), permission, { orgId: 'org_example' })
    expect(mocks.context).not.toHaveBeenCalled()
    expect(action).not.toHaveBeenCalled()
  })
  it('rejects an organization hidden by RLS', async () => {
    mocks.org.mockResolvedValue(null)
    expect((await request(path)).status).toBe(400)
    expect(action).not.toHaveBeenCalled()
  })
  it('rejects callers without a user identity', async () => {
    mocks.userId = null
    expect((await request(path)).status).toBe(400)
    expect(action).not.toHaveBeenCalled()
  })
  it('uses the server-resolved customer and account, ignoring client-supplied replacements', async () => {
    expect((await request(path, { customerId: 'cus_other', billingAccount: 'ee', taxIdId: 'txi_example' })).status).toBe(200)
    expect(mocks.context).toHaveBeenCalledWith(expect.anything(), 'cus_resolved')
    expect(action.mock.calls[0][0]).toEqual({ customerId: 'cus_resolved', billingAccount: 'us' })
  })
})
