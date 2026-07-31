import { describe, expect, it, vi } from 'vitest'

const {
  cloudlogErrMock,
  cloudlogMock,
  isGoodPlanOrgMock,
  isOnboardedOrgMock,
  isOnboardingNeededMock,
  isTrialOrgMock,
  sendEventToTrackingMock,
  sendNotifToOrgMembersMock,
  sendNotifToOrgMembersOnceMock,
  supabaseAdminMock,
} = vi.hoisted(() => ({
  cloudlogErrMock: vi.fn(),
  cloudlogMock: vi.fn(),
  isGoodPlanOrgMock: vi.fn(async () => false),
  isOnboardedOrgMock: vi.fn(async (_c: unknown, orgId: string) => !orgId.includes('onboarding')),
  isOnboardingNeededMock: vi.fn(async (_c: unknown, orgId: string) => orgId.includes('onboarding')),
  isTrialOrgMock: vi.fn(async () => 0),
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
  getCurrentPlanNameOrg: vi.fn(),
  getPlanUsageAndFit: vi.fn(),
  getPlanUsageAndFitUncached: vi.fn(),
  getPlanUsagePercent: vi.fn(),
  getTotalStats: vi.fn(),
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
}))

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
      {
        total_percent: 0,
        mau_percent: 0,
        bandwidth_percent: 0,
        storage_percent: 0,
        build_time_percent: 0,
      },
      {} as any,
    )

    expect(result).toBe(false)
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
      {
        total_percent: 0,
        mau_percent: 0,
        bandwidth_percent: 0,
        storage_percent: 0,
        build_time_percent: 0,
      },
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

    expect(result).toBe(true)
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

    expect(result).toBe(true)
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
