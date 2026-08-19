import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  backgroundTaskMock,
  cloudlogErrMock,
  drizzleClientMock,
  pgClientEndMock,
  pgClientMock,
  logsnagTrackMock,
  notifToOrgMembersMock,
  posthogMock,
} = vi.hoisted(() => ({
  backgroundTaskMock: vi.fn(),
  cloudlogErrMock: vi.fn(),
  drizzleClientMock: { mocked: true },
  logsnagTrackMock: vi.fn(),
  notifToOrgMembersMock: vi.fn(),
  pgClientEndMock: vi.fn().mockResolvedValue(undefined),
  pgClientMock: { mocked: true, end: vi.fn().mockResolvedValue(undefined) },
  posthogMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  backgroundTask: backgroundTaskMock,
}))

vi.mock('../supabase/functions/_backend/utils/logsnag.ts', () => ({
  logsnag: () => ({
    track: logsnagTrackMock,
  }),
}))

vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({
  trackPosthogEvent: posthogMock,
}))

vi.mock('../supabase/functions/_backend/utils/org_email_notifications.ts', () => ({
  sendNotifToOrgMembers: notifToOrgMembersMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getDrizzleClient: vi.fn(() => drizzleClientMock),
  getPgClient: vi.fn(() => ({ ...pgClientMock, end: pgClientEndMock })),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: cloudlogErrMock,
  serializeError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
}))

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
    req: {
      header: (name: string) => name === 'x-forwarded-for' ? '1.2.3.4, 5.6.7.8' : undefined,
    },
  } as any
}

beforeEach(() => {
  backgroundTaskMock.mockImplementation((_c: unknown, promise: Promise<unknown>) => promise)
  notifToOrgMembersMock.mockResolvedValue(true)
  pgClientEndMock.mockResolvedValue(undefined)
  logsnagTrackMock.mockResolvedValue(true)
  posthogMock.mockResolvedValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  backgroundTaskMock.mockReset()
  notifToOrgMembersMock.mockReset()
  pgClientEndMock.mockReset()
  logsnagTrackMock.mockReset()
  posthogMock.mockReset()
  cloudlogErrMock.mockReset()
})

describe('sendEventToTracking', () => {
  it('uses the authenticated API key ID instead of a caller-provided tag', async () => {
    const { addAuthenticatedApiKeyIdToTrackingPayload } = await import('../supabase/functions/_backend/utils/tracking.ts')

    const payload = addAuthenticatedApiKeyIdToTrackingPayload({
      channel: 'usage',
      event: 'Tracked Event',
      notify: false,
      tags: { apikey_id: 'caller-supplied', app_id: 'app-id' },
    }, 87015)

    expect(payload.tags).toEqual({ app_id: 'app-id' })
    expect(payload.nonPersonTags).toEqual({ apikey_id: 87015 })
  })

  it('does not allow callers without an API key to report an API key ID', async () => {
    const { addAuthenticatedApiKeyIdToTrackingPayload } = await import('../supabase/functions/_backend/utils/tracking.ts')

    const payload = addAuthenticatedApiKeyIdToTrackingPayload({
      channel: 'usage',
      event: 'Tracked Event',
      notify: false,
      tags: { apikey_id: 'caller-supplied', app_id: 'app-id' },
      nonPersonTags: { apikey_id: 'caller-supplied', cli_version: '8.31.3' },
    }, undefined)

    expect(payload.tags).toEqual({ app_id: 'app-id' })
    expect(payload.nonPersonTags).toEqual({ cli_version: '8.31.3' })
  })

  it('runs all tracking providers in the background by default', async () => {
    const { sendEventToTracking } = await import('../supabase/functions/_backend/utils/tracking.ts')

    await sendEventToTracking(createContext(), {
      bento: {
        cron: '* * * * *',
        data: { org_id: 'org-id' },
        event: 'org:tracked',
        preferenceKey: 'onboarding',
        uniqId: 'org:tracked',
      },
      channel: 'usage',
      event: 'Tracked Event',
      user_id: 'org-id',
      description: 'test description',
      notify: false,
      sentToBento: true,
      tags: { app_id: 'app-id' },
      nonPersonTags: { apikey_id: 87015 },
    })

    expect(backgroundTaskMock).toHaveBeenCalledTimes(2)
    expect(logsnagTrackMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'Tracked Event' }))
    expect(posthogMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'Tracked Event',
      ip: '1.2.3.4',
      nonPersonTags: { apikey_id: 87015 },
      user_id: 'org-id',
    }))
    expect(notifToOrgMembersMock).toHaveBeenCalledWith(
      expect.anything(),
      'org:tracked',
      'onboarding',
      { org_id: 'org-id' },
      'org-id',
      'org:tracked',
      '* * * * *',
      expect.anything(),
      undefined,
    )
  })

  it('can run inline and keeps other providers running when one fails', async () => {
    logsnagTrackMock.mockRejectedValueOnce(new Error('logsnag failed'))
    const { sendEventToTracking } = await import('../supabase/functions/_backend/utils/tracking.ts')

    await sendEventToTracking(createContext(), {
      channel: 'usage',
      event: 'Inline Event',
      user_id: 'org-id',
      notify: true,
    }, {
      background: false,
    })

    expect(backgroundTaskMock).not.toHaveBeenCalled()
    expect(posthogMock).toHaveBeenCalledOnce()
    expect(cloudlogErrMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'sendEventToTracking provider failed',
      provider: 'logsnag',
    }))
  })

  it('preserves a numeric frontend event timestamp when sending to PostHog', async () => {
    const { sendEventToTracking } = await import('../supabase/functions/_backend/utils/tracking.ts')

    await sendEventToTracking(createContext(), {
      channel: 'onboarding',
      event: 'onboarding_step_viewed',
      notify: false,
      timestamp: 1_755_600_000_000,
      user_id: 'user-id',
    }, { background: false })

    expect(posthogMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      timestamp: '2025-08-19T10:40:00.000Z',
    }))
  })

  it('can skip PostHog while preserving LogSnag and Bento delivery', async () => {
    const { sendEventToTracking } = await import('../supabase/functions/_backend/utils/tracking.ts')

    await sendEventToTracking(createContext(), {
      bento: {
        data: { app_id: 'com.example.app' },
        event: 'app:ai_instructions_copied',
        preferenceKey: 'onboarding',
        uniqId: 'app:ai_instructions_copied:com.example.app:attempt-id',
      },
      channel: 'onboarding',
      event: 'onboarding_ai_instructions_copied',
      notify: false,
      sentToBento: true,
      user_id: 'org-id',
    }, { background: false, posthog: false })

    expect(logsnagTrackMock).toHaveBeenCalledOnce()
    expect(posthogMock).not.toHaveBeenCalled()
    expect(notifToOrgMembersMock).toHaveBeenCalledOnce()
  })
})
