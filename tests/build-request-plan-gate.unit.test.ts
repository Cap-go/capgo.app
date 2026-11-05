import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestBuild } from '../supabase/functions/_backend/public/build/request.ts'

const {
  mockRlsQuery,
  mockWithRlsContext,
  mockGetPgClient,
  mockCheckPermission,
  mockGetEnv,
  mockSendEventToTracking,
  mockAssertNativeBuildConcurrencyAvailable,
  mockGetPlansUpgradeUrl,
} = vi.hoisted(() => ({
  mockRlsQuery: vi.fn(),
  mockWithRlsContext: vi.fn(),
  mockGetPgClient: vi.fn(),
  mockCheckPermission: vi.fn(),
  mockGetEnv: vi.fn(),
  mockSendEventToTracking: vi.fn(),
  mockAssertNativeBuildConcurrencyAvailable: vi.fn(),
  mockGetPlansUpgradeUrl: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg_rls.ts')>()
  return { ...actual, withRlsContext: mockWithRlsContext }
})

vi.mock('../supabase/functions/_backend/utils/pg.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>()
  return { ...actual, getPgClient: mockGetPgClient, closeClient: vi.fn() }
})

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: mockCheckPermission,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: mockGetEnv,
}))

vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: mockSendEventToTracking,
}))

vi.mock('../supabase/functions/_backend/public/build/concurrency.ts', () => ({
  assertNativeBuildConcurrencyAvailable: mockAssertNativeBuildConcurrencyAvailable,
  getPlansUpgradeUrl: mockGetPlansUpgradeUrl,
}))

describe('native build request plan gate', () => {
  const requestId = 'req-build-plan-gate'
  const appId = 'com.test.native.build.plan'
  const orgId = 'org-native-build-plan'

  function createContext() {
    return {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'requestId')
          return requestId
        return undefined
      }),
    }
  }

  beforeEach(() => {
    mockRlsQuery.mockReset()
    mockWithRlsContext.mockReset()
    mockGetPgClient.mockReset()
    mockWithRlsContext.mockImplementation(async (_c: unknown, _principal: unknown, run: (client: unknown) => unknown) => run({ query: mockRlsQuery }))
    mockCheckPermission.mockReset()
    mockGetEnv.mockReset()
    mockSendEventToTracking.mockReset()
    mockAssertNativeBuildConcurrencyAvailable.mockReset()
    mockGetPlansUpgradeUrl.mockReset()

    mockCheckPermission.mockResolvedValue(true)
    mockAssertNativeBuildConcurrencyAvailable.mockResolvedValue({
      activeBuilds: 0,
      limit: 2,
      planName: 'Solo',
      upgradeUrl: 'https://console.capgo.app/settings/organization/plans',
    })
    mockGetPlansUpgradeUrl.mockReturnValue('https://console.capgo.app/settings/organization/plans')
  })

  function allowBuildTime(allowed: boolean) {
    mockRlsQuery.mockImplementation(async (text: string) => text.includes('FROM public.apps')
      ? { rows: [{ owner_org: orgId }] }
      : { rows: [{ allowed }] })
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('blocks builder job creation when build time action is over plan', async () => {
    allowBuildTime(false)

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }))

    try {
      await expect(requestBuild(
        createContext() as any,
        { app_id: appId, platform: 'ios' },
        { key: 'api-key-build-plan', user_id: 'user-native-build-plan' } as any,
      )).rejects.toMatchObject({
        status: 429,
        message: 'Cannot request native build, upgrade plan to continue to build: https://console.capgo.app/settings/organization/plans',
        cause: expect.objectContaining({
          error: 'need_plan_upgrade',
          moreInfo: expect.objectContaining({
            app_id: appId,
            org_id: orgId,
            reason: 'build_time',
            upgrade_url: 'https://console.capgo.app/settings/organization/plans',
          }),
        }),
      })

      expect(mockCheckPermission).toHaveBeenCalledWith(expect.anything(), 'app.build_native', { appId })
      expect(mockWithRlsContext).toHaveBeenCalledWith(expect.anything(), { kind: 'apikey', apikey: 'api-key-build-plan' }, expect.any(Function))
      expect(mockRlsQuery).toHaveBeenCalledWith('SELECT owner_org FROM public.apps WHERE app_id = $1', [appId])
      expect(mockRlsQuery).toHaveBeenCalledWith(
        expect.stringContaining('public.is_allowed_action_org_action(orgid => $1, actions => $2::public.action_type[], appid => $3)'),
        [orgId, ['build_time'], appId],
      )
      expect(mockAssertNativeBuildConcurrencyAvailable).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(mockGetPgClient).not.toHaveBeenCalled()
    }
    finally {
      fetchMock.mockRestore()
    }
  })

  it('blocks builder job creation when native build concurrency is already at the plan limit', async () => {
    const { HTTPException } = await import('hono/http-exception')
    allowBuildTime(true)
    mockAssertNativeBuildConcurrencyAvailable.mockRejectedValue(new HTTPException(429, {
      message: 'Your Solo plan allows 2 concurrent native builds. You already have 2 active. Wait for a build to finish, or upgrade your plan: https://console.capgo.app/settings/organization/plans',
      cause: {
        error: 'native_build_concurrency_limit_exceeded',
        message: 'Your Solo plan allows 2 concurrent native builds. You already have 2 active. Wait for a build to finish, or upgrade your plan: https://console.capgo.app/settings/organization/plans',
        moreInfo: {
          activeBuilds: 2,
          limit: 2,
          planName: 'Solo',
          upgrade_url: 'https://console.capgo.app/settings/organization/plans',
          reason: 'native_build_concurrency',
        },
        suppressDiscordAlert: true,
      },
    }))

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }))

    try {
      await expect(requestBuild(
        createContext() as any,
        { app_id: appId, platform: 'android' },
        { key: 'api-key-build-plan', user_id: 'user-native-build-plan' } as any,
      )).rejects.toMatchObject({
        status: 429,
        cause: expect.objectContaining({
          error: 'native_build_concurrency_limit_exceeded',
        }),
      })

      expect(mockAssertNativeBuildConcurrencyAvailable).toHaveBeenCalledWith(expect.anything(), {
        orgId,
        appId,
        userId: 'user-native-build-plan',
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(mockGetPgClient).not.toHaveBeenCalled()
    }
    finally {
      fetchMock.mockRestore()
    }
  })
})
