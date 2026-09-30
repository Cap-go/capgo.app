import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  cloudlogErrMock,
  getCurrentPlanNameOrgMock,
  getTotalStatsMock,
  rpcMock,
  supabaseAdminMock,
} = vi.hoisted(() => ({
  cloudlogErrMock: vi.fn(),
  getCurrentPlanNameOrgMock: vi.fn(async () => 'Solo'),
  getTotalStatsMock: vi.fn(),
  rpcMock: vi.fn(),
  supabaseAdminMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  quickError: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: cloudlogErrMock,
}))

vi.mock('../supabase/functions/_backend/utils/org_email_notifications.ts', () => ({
  sendNotifToOrgMembers: vi.fn(async () => false),
  sendNotifToOrgMembersOnce: vi.fn(async () => false),
}))

vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({
  syncSubscriptionData: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  getCurrentPlanNameOrg: getCurrentPlanNameOrgMock,
  getPlanUsageAndFit: vi.fn(),
  getPlanUsageAndFitUncached: vi.fn(),
  getPlanUsagePercent: vi.fn(),
  getTotalStats: getTotalStatsMock,
  isGoodPlanOrg: vi.fn(async () => false),
  isOnboardedOrg: vi.fn(async () => true),
  isOnboardingNeeded: vi.fn(async () => false),
  isTrialOrg: vi.fn(async () => 0),
  supabaseAdmin: supabaseAdminMock,
}))

vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: vi.fn(() => undefined),
  isStripeConfigured: vi.fn(() => false),
  trimTrailingSlashes: (value: string) => value,
}))

const PLAN = {
  id: 'plan-solo',
  name: 'Solo',
  mau: 1000,
  storage: 1000,
  bandwidth: 1000,
  build_time_unit: 1000,
}

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
  } as any
}

function payingOrg() {
  return {
    customer_id: 'cus_overage_cycle_test',
    has_usage_credits: true,
    name: 'Overage Cycle Org',
    stripe_info: {
      status: 'succeeded' as const,
      subscription_id: 'sub_overage_cycle_test',
      subscription_anchor_end: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      trial_at: null,
    },
  }
}

const ZERO_USAGE = {
  total_percent: 0,
  mau_percent: 0,
  bandwidth_percent: 0,
  storage_percent: 0,
  build_time_percent: 0,
}

function rpcNames() {
  return (rpcMock.mock.calls as unknown[][]).map(call => call[0])
}

describe('userAbovePlan overage billing cycle', () => {
  beforeEach(() => {
    rpcMock.mockReset()
    cloudlogErrMock.mockClear()
    getTotalStatsMock.mockResolvedValue({
      mau: 1500,
      storage: 0,
      bandwidth: 0,
      build_time_unit: 0,
      get: 0,
      fail: 0,
      install: 0,
      uninstall: 0,
    })
    supabaseAdminMock.mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(async () => ({ data: PLAN, error: null })),
          })),
        })),
      })),
      rpc: rpcMock,
    })
  })

  it('skips overage application instead of using a calendar-month key when the cycle RPC fails', async () => {
    rpcMock.mockImplementation((name: string) => ({
      single: vi.fn(async () => name === 'get_cycle_info_org'
        ? { data: null, error: { message: 'cycle lookup failed' } }
        : { data: null, error: null }),
    }))

    const { handleOrgNotificationsAndEvents } = await import('../supabase/functions/_backend/utils/plans.ts')

    await expect(handleOrgNotificationsAndEvents(createContext(), payingOrg(), 'org-cycle-error', false, ZERO_USAGE, {} as any))
      .rejects
      .toThrow('billing_cycle_unavailable')
    expect(rpcNames()).toContain('get_cycle_info_org')
    expect(rpcNames()).not.toContain('apply_usage_overage')
    expect(cloudlogErrMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'userAbovePlan skipped overage: billing cycle unavailable',
      orgId: 'org-cycle-error',
    }))
  })

  it('applies overage with the exact SQL billing cycle as the key', async () => {
    const cycle = {
      subscription_anchor_start: '2026-02-28T14:00:00+00:00',
      subscription_anchor_end: '2026-03-31T14:00:00+00:00',
    }
    rpcMock.mockImplementation((name: string) => ({
      single: vi.fn(async () => {
        if (name === 'get_cycle_info_org')
          return { data: cycle, error: null }
        return {
          data: {
            overage_amount: 500,
            credits_required: 1,
            credits_applied: 1,
            credits_remaining: 10,
            overage_covered: 500,
            overage_unpaid: 0,
            credit_step_id: 1,
          },
          error: null,
        }
      }),
    }))

    const { handleOrgNotificationsAndEvents } = await import('../supabase/functions/_backend/utils/plans.ts')
    const result = await handleOrgNotificationsAndEvents(createContext(), payingOrg(), 'org-cycle-ok', false, ZERO_USAGE, {} as any)

    expect(result.finalIsGoodPlan).toBe(true)
    expect(rpcMock).toHaveBeenCalledWith('apply_usage_overage', expect.objectContaining({
      p_org_id: 'org-cycle-ok',
      p_metric: 'mau',
      p_overage_amount: 500,
      p_billing_cycle_start: cycle.subscription_anchor_start,
      p_billing_cycle_end: cycle.subscription_anchor_end,
    }))
  })
})
