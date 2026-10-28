import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  cloudlogErrMock,
  cloudlogMock,
  getCurrentPlanNameOrgMock,
  getPlanUsageAndFitUncachedMock,
  getPlanUsagePercentMock,
  isGoodPlanOrgMock,
  isOnboardedOrgMock,
  isOnboardingNeededMock,
  getTotalStatsMock,
  isTrialOrgMock,
  rpcMock,
  sendEventToTrackingMock,
  sendNotifToOrgMembersMock,
  sendNotifToOrgMembersOnceMock,
  supabaseAdminMock,
} = vi.hoisted(() => ({
  cloudlogErrMock: vi.fn(),
  cloudlogMock: vi.fn(),
  getCurrentPlanNameOrgMock: vi.fn(async () => 'Solo'),
  getPlanUsageAndFitUncachedMock: vi.fn(),
  getPlanUsagePercentMock: vi.fn(),
  isGoodPlanOrgMock: vi.fn(async () => false),
  isOnboardedOrgMock: vi.fn(async (_c: unknown, orgId: string) => !orgId.includes('onboarding')),
  isOnboardingNeededMock: vi.fn(async (_c: unknown, orgId: string) => orgId.includes('onboarding')),
  getTotalStatsMock: vi.fn(),
  isTrialOrgMock: vi.fn(async () => 0),
  rpcMock: vi.fn(),
  sendEventToTrackingMock: vi.fn(async () => undefined),
  sendNotifToOrgMembersMock: vi.fn(async () => true),
  sendNotifToOrgMembersOnceMock: vi.fn(async (_c: unknown, _event: string, _pref: string, _data: unknown, orgId: string) => !orgId.includes('already-claimed')),
  supabaseAdminMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  quickError: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: cloudlogMock,
  cloudlogErr: cloudlogErrMock,
}))

vi.mock('../supabase/functions/_backend/utils/org_email_notifications.ts', () => ({
  sendNotifToOrgMembers: sendNotifToOrgMembersMock,
  sendNotifToOrgMembersOnce: sendNotifToOrgMembersOnceMock,
}))

vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({
  syncSubscriptionData: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  getCurrentPlanNameOrg: getCurrentPlanNameOrgMock,
  getOrgExtraMau: vi.fn(async () => 0),
  getPlanUsageAndFit: vi.fn(),
  getPlanUsageAndFitUncached: getPlanUsageAndFitUncachedMock,
  getPlanUsagePercent: getPlanUsagePercentMock,
  getTotalStats: getTotalStatsMock,
  isGoodPlanOrg: isGoodPlanOrgMock,
  isOnboardedOrg: isOnboardedOrgMock,
  isOnboardingNeeded: isOnboardingNeededMock,
  isTrialOrg: isTrialOrgMock,
  set_bandwidth_exceeded: vi.fn(),
  set_build_time_exceeded: vi.fn(),
  set_mau_exceeded: vi.fn(),
  set_storage_exceeded: vi.fn(),
  supabaseAdmin: supabaseAdminMock,
}))

vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: sendEventToTrackingMock,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: vi.fn((_c: unknown, key: string) => key === 'WEBAPP_URL' ? 'https://console.capgo.app/' : undefined),
  isStripeConfigured: vi.fn(),
  trimTrailingSlashes: (value: string) => {
    let end = value.length
    while (end > 0 && value[end - 1] === '/')
      end -= 1
    return value.slice(0, end)
  },
}))

// plans.ts now runs SQL directly (through pg_rls or the caller's drizzle client). Replay each
// statement on the supabase-js style supabaseAdminMock so the cases keep their meaning.
async function unwrapSingle(result: Promise<{ data: unknown, error: unknown }> | { data: unknown, error: unknown }) {
  const { data, error } = await result
  if (error)
    throw error
  return data
}

async function replayOnAdminMock(text: string, values: unknown[] = []): Promise<unknown[]> {
  const admin = supabaseAdminMock()
  if (text.includes('find_best_plan_v3')) {
    const [mau, bandwidth, storage, build_time_unit] = values
    return [{ plan: await unwrapSingle(admin.rpc('find_best_plan_v3', { mau, bandwidth, storage, build_time_unit }).single()) }]
  }
  if (text.includes('get_cycle_info_org')) {
    const data = await unwrapSingle(admin.rpc('get_cycle_info_org', { orgid: values[0] }).single())
    return data ? [data] : []
  }
  if (text.includes('apply_usage_overage')) {
    const [p_org_id, p_metric, p_overage_amount, p_billing_cycle_start, p_billing_cycle_end, p_details, p_included_amount] = values
    const data = await unwrapSingle(admin.rpc('apply_usage_overage', {
      p_org_id,
      p_metric,
      p_overage_amount,
      p_billing_cycle_start,
      p_billing_cycle_end,
      p_details: JSON.parse(p_details as string),
      p_included_amount,
    }).single())
    return data ? [data] : []
  }
  if (text.includes('FROM public.plans')) {
    const data = await unwrapSingle(admin.from('plans').select('*').eq('name', values[0]).single())
    return data ? [data] : []
  }
  if (text.includes('FROM public.orgs')) {
    const data = await unwrapSingle(admin.from('orgs').select('*').eq('id', values[0]).maybeSingle())
    return data ? [data] : []
  }
  throw new Error(`unexpected query ${text}`)
}

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  servicePrincipal: { kind: 'service' },
  withRlsContext: async (_c: unknown, _principal: unknown, run: (client: unknown) => Promise<unknown>) => run({
    query: async (text: string, values?: unknown[]) => ({ rows: await replayOnAdminMock(text, values) }),
  }),
  queryJson: async (client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }, text: string, values?: unknown[]) => (await client.query(text, values)).rows,
}))

const replayDrizzle = {
  execute: async (query: SQL) => {
    const { sql: text, params } = new PgDialect().sqlToQuery(query)
    return { rows: (await replayOnAdminMock(text, params)).map(row => ({ row })) }
  },
}

const ZERO_USAGE = {
  total_percent: 0,
  mau_percent: 0,
  bandwidth_percent: 0,
  storage_percent: 0,
  build_time_percent: 0,
}

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
  } as any
}

function orgNotificationCalls(mock: typeof sendNotifToOrgMembersMock, orgId: string) {
  return (mock.mock.calls as unknown[][]).filter(call => call[4] === orgId && call[5] === orgId)
}

function trackingCalls(orgId: string) {
  return (sendEventToTrackingMock.mock.calls as unknown[][])
    .filter(([, event]) => (event as { user_id?: string } | undefined)?.user_id === orgId)
}

describe('handleOrgNotificationsAndEvents onboarding reminder', () => {
  it.concurrent('sends the trial-expired onboarding reminder only through the one-time helper with org context', async () => {
    const { handleOrgNotificationsAndEvents } = await import('../supabase/functions/_backend/utils/plans.ts')
    const orgId = 'org-onboarding-reminder'

    const result = await handleOrgNotificationsAndEvents(
      createContext(),
      {
        customer_id: null,
        name: 'Acme Mobile',
        stripe_info: null,
        website: 'https://acme.example/',
      },
      orgId,
      false,
      ZERO_USAGE,
      {} as any,
    )

    expect(result).toEqual({
      exceededFlags: null,
      finalIsGoodPlan: false,
    })
    expect(orgNotificationCalls(sendNotifToOrgMembersMock, orgId)).toHaveLength(0)
    expect(sendNotifToOrgMembersOnceMock).toHaveBeenCalledWith(
      expect.anything(),
      'user:need_onboarding',
      'onboarding',
      expect.objectContaining({
        org_id: orgId,
        org_name: 'Acme Mobile',
        org_website: 'https://acme.example/',
        onboarding_intent: 'unknown',
        onboarding_url: 'https://console.capgo.app/apps',
        onboarding_url_ota: 'https://console.capgo.app/app/new',
        onboarding_url_builder: 'https://console.capgo.app/apps',
      }),
      orgId,
      orgId,
      expect.anything(),
    )
    expect(trackingCalls(orgId)).toEqual([
      [
        expect.anything(),
        expect.objectContaining({
          channel: 'usage',
          event: 'User need onboarding',
          user_id: orgId,
        }),
      ],
    ])
  })

  it.concurrent('does not re-emit User need onboarding when the once-helper finds an existing claim', async () => {
    const { handleOrgNotificationsAndEvents } = await import('../supabase/functions/_backend/utils/plans.ts')
    const orgId = 'org-onboarding-already-claimed'

    await handleOrgNotificationsAndEvents(
      createContext(),
      {
        customer_id: null,
        name: 'Acme Mobile',
        website: 'https://acme.example/',
        onboarding: null,
      },
      orgId,
      false,
      ZERO_USAGE,
      {} as any,
    )

    expect(trackingCalls(orgId)).toHaveLength(0)
  })

  it.concurrent('does not send plan usage alerts from stale total percent alone', async () => {
    const { handleOrgNotificationsAndEvents } = await import('../supabase/functions/_backend/utils/plans.ts')
    const orgId = 'org-usage-stale'

    const result = await handleOrgNotificationsAndEvents(
      createContext(),
      {
        customer_id: 'cus_123',
        name: 'Acme Mobile',
        stripe_info: null,
        website: 'https://acme.example/',
      },
      orgId,
      true,
      {
        total_percent: 51,
        mau_percent: 20,
        bandwidth_percent: 0,
        storage_percent: 0,
        build_time_percent: 0,
      },
      {} as any,
    )

    expect(result).toEqual({
      exceededFlags: {
        bandwidth_exceeded: false,
        build_time_exceeded: false,
        mau_exceeded: false,
        storage_exceeded: false,
      },
      finalIsGoodPlan: true,
    })
    expect(orgNotificationCalls(sendNotifToOrgMembersMock, orgId)).toHaveLength(0)
    expect(trackingCalls(orgId)).toHaveLength(0)
  })

  it.concurrent('sends plan usage alerts with the metric that crossed the threshold', async () => {
    const { handleOrgNotificationsAndEvents } = await import('../supabase/functions/_backend/utils/plans.ts')
    const orgId = 'org-usage-storage'

    const result = await handleOrgNotificationsAndEvents(
      createContext(),
      {
        customer_id: 'cus_123',
        name: 'Acme Mobile',
        stripe_info: null,
        website: 'https://acme.example/',
      },
      orgId,
      true,
      {
        total_percent: 20,
        mau_percent: 20,
        bandwidth_percent: 0,
        storage_percent: 51,
        build_time_percent: 0,
      },
      {} as any,
    )

    expect(result).toEqual({
      exceededFlags: {
        bandwidth_exceeded: false,
        build_time_exceeded: false,
        mau_exceeded: false,
        storage_exceeded: false,
      },
      finalIsGoodPlan: true,
    })
    expect(sendNotifToOrgMembersMock).toHaveBeenCalledWith(
      expect.anything(),
      'user:usage_50_percent_of_plan',
      'usage_limit',
      {
        metric: 'storage',
        metric_percent: 51,
        percent: {
          total_percent: 51,
          mau_percent: 20,
          bandwidth_percent: 0,
          storage_percent: 51,
          build_time_percent: 0,
        },
        threshold: 50,
      },
      orgId,
      orgId,
      '0 0 1 * *',
      expect.anything(),
    )
    expect(sendEventToTrackingMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: 'usage',
        event: 'User is at 50% of plan usage',
        user_id: orgId,
        tags: {
          metric: 'storage',
          metric_percent: '51',
          threshold: '50',
        },
      }),
    )
  })
})

describe('checkPlanStatusOnly failures', () => {
  it('rethrows when both fresh and fallback plan calculation fail', async () => {
    const calculationError = new Error('plan calculation failed')
    getPlanUsageAndFitUncachedMock.mockRejectedValueOnce(new Error('fresh plan calculation failed'))
    getPlanUsagePercentMock.mockRejectedValueOnce(calculationError)
    supabaseAdminMock.mockReturnValueOnce({
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data: {
                customer_id: 'cus_plan_calculation_failure',
                has_usage_credits: false,
                name: 'Plan Calculation Failure',
                onboarding: null,
                stripe_info: null,
                website: null,
              },
              error: null,
            })),
          })),
        })),
      })),
    })

    const { checkPlanStatusOnly } = await import('../supabase/functions/_backend/utils/plans.ts')
    const drizzleClient = { execute: vi.fn() }

    await expect(checkPlanStatusOnly(createContext(), 'org-plan-calculation-failure', drizzleClient as any))
      .rejects
      .toBe(calculationError)
    expect(drizzleClient.execute).not.toHaveBeenCalled()
    expect(cloudlogErrMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'calculatePlanStatus failed',
      orgId: 'org-plan-calculation-failure',
      error: calculationError,
    }))
  })
})

const PLAN = {
  id: 'plan-solo',
  name: 'Solo',
  mau: 1000,
  storage: 1000,
  bandwidth: 1000,
  build_time_unit: 1000,
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

    await expect(handleOrgNotificationsAndEvents(createContext(), payingOrg(), 'org-cycle-error', false, ZERO_USAGE, replayDrizzle as any))
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
    const result = await handleOrgNotificationsAndEvents(createContext(), payingOrg(), 'org-cycle-ok', false, ZERO_USAGE, replayDrizzle as any)

    expect(result.finalIsGoodPlan).toBe(true)
    expect(rpcMock).toHaveBeenCalledWith('apply_usage_overage', expect.objectContaining({
      p_org_id: 'org-cycle-ok',
      p_metric: 'mau',
      p_overage_amount: 500,
      p_billing_cycle_start: cycle.subscription_anchor_start,
      p_billing_cycle_end: cycle.subscription_anchor_end,
      p_included_amount: 1000,
    }))
  })
})
