import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requireEnterprisePlan } from '../supabase/functions/_backend/utils/plan-gating.ts'

const mocks = vi.hoisted(() => ({ single: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: () => ({ from: () => ({ select: () => ({ eq: () => ({ single: mocks.single }) }) }) }),
  getCurrentPlanNameOrg: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlog: vi.fn(), cloudlogErr: vi.fn() }))
const context = { get: () => 'request-id' } as unknown as Context
const paidPlan = { status: 'succeeded', is_good_plan: true, product_id: 'enterprise-product', paid_at: '2026-01-01T00:00:00Z', past_due_at: null }

beforeEach(() => vi.resetAllMocks())
function billing(info: Partial<Omit<typeof paidPlan, 'paid_at' | 'past_due_at'> & { paid_at: string | null, past_due_at: string | null }>, plan = 'Enterprise') {
  mocks.single.mockResolvedValueOnce({ data: { customer_id: 'customer-id' } })
    .mockResolvedValueOnce({ data: { ...paidPlan, ...info } })
    .mockResolvedValueOnce({ data: { name: plan } })
}

describe('paid Enterprise feature gating', () => {
  it('allows a paid Enterprise organization in good standing', async () => {
    billing({})
    await expect(requireEnterprisePlan(context, 'org-id', 'Custom domains', true)).resolves.toBeUndefined()
  })

  it.each([
    ['unpaid trial', { paid_at: null }],
    ['overdue subscription', { past_due_at: '2026-01-02T00:00:00Z' }],
    ['canceled subscription', { status: 'canceled' }],
    ['failed payment', { status: 'failed' }],
    ['bad standing', { is_good_plan: false }],
  ])('rejects %s even with an Enterprise product', async (_label, info) => {
    billing(info)
    await expect(requireEnterprisePlan(context, 'org-id', 'Custom domains', true)).rejects.toMatchObject({ status: 403 })
  })

  it('rejects a paid non-Enterprise plan', async () => {
    billing({}, 'Team')
    await expect(requireEnterprisePlan(context, 'org-id', 'Custom domains', true)).rejects.toMatchObject({ status: 403 })
  })

  it('keeps existing Enterprise features on their original active-plan policy', async () => {
    billing({ paid_at: null })
    await expect(requireEnterprisePlan(context, 'org-id')).resolves.toBeUndefined()
  })
})
