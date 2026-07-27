import { jwtVerify } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startBuild } from '../supabase/functions/_backend/public/build/start.ts'

const { mockSupabaseAdmin, mockSupabaseApikey, mockCheckPermission, mockGetEnv, mockReserveNativeBuildSlot, mockSendEventToTracking } = vi.hoisted(() => ({
  mockSupabaseAdmin: vi.fn(),
  mockSupabaseApikey: vi.fn(),
  mockCheckPermission: vi.fn(),
  mockGetEnv: vi.fn(),
  mockReserveNativeBuildSlot: vi.fn(),
  mockSendEventToTracking: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: mockSupabaseAdmin,
  supabaseApikey: mockSupabaseApikey,
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: mockCheckPermission,
}))

vi.mock('../supabase/functions/_backend/public/build/concurrency.ts', async () => {
  const { HTTPException } = await import('hono/http-exception')
  return {
    reserveNativeBuildSlot: mockReserveNativeBuildSlot,
    isNativeBuildConcurrencyLimitError: (error: unknown) => {
      return error instanceof HTTPException
        && error.status === 429
        && !!(error.cause && typeof error.cause === 'object' && 'error' in error.cause
          && (error.cause as { error?: unknown }).error === 'native_build_concurrency_limit_exceeded')
    },
  }
})

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: mockGetEnv,
}))

vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: mockSendEventToTracking,
}))

describe('build start direct log token', () => {
  const requestId = 'req-build-start-log-token'
  const jobId = 'job-log-token-123'
  const appId = 'com.test.build.logs'
  const userId = '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5'
  const jwtSecret = 'super-secret-jwt-key'
  const publicUrl = 'https://api.capgo.test'
  const builderUrl = 'https://builder.capgo.test'
  const builderApiKey = 'builder-api-key'

  // Mock the CAS update chain: .update(...).eq(...).eq(...).eq(...).select('id')
  // Returns { data, error } from .select(); `data` shape decides whether
  // emitBuildTransitionEvent fires. `mockReturnThis()` on .eq() lets the chain
  // accept any number of guards (builder_job_id + app_id + status, currently).
  function configureUpdateMock(selectResult: { data: Array<{ id: string }> | null, error: { message: string } | null }) {
    const updateBuilder = {
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue(selectResult),
    }

    mockSupabaseAdmin.mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        expect(table).toBe('build_requests')
        return {
          update: vi.fn().mockReturnValue(updateBuilder),
        }
      }),
    })

    return updateBuilder
  }

  beforeEach(() => {
    mockSupabaseAdmin.mockReset()
    mockSupabaseApikey.mockReset()
    mockCheckPermission.mockReset()
    mockGetEnv.mockReset()
    mockReserveNativeBuildSlot.mockReset()
    mockSendEventToTracking.mockReset()
    mockSendEventToTracking.mockResolvedValue(undefined)

    const selectBuilder = {
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: '3eb4f870-720d-46b9-843f-2e6d57d54000',
          app_id: appId,
          owner_org: '3eb4f870-720d-46b9-843f-2e6d57d54001',
          requested_by: userId,
          status: 'pending',
          platform: 'ios',
          build_mode: 'release',
        },
        error: null,
      }),
    }

    mockSupabaseApikey.mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        expect(table).toBe('build_requests')
        return {
          select: vi.fn().mockReturnValue(selectBuilder),
        }
      }),
    })

    // Default: CAS guard succeeds, one row returned, lifecycle event should fire.
    configureUpdateMock({ data: [{ id: 'row-1' }], error: null })

    mockCheckPermission.mockResolvedValue(true)
    mockReserveNativeBuildSlot.mockResolvedValue({
      activeBuilds: 0,
      limit: 2,
      planName: 'Solo',
      upgradeUrl: 'https://console.capgo.app/settings/organization/plans',
      status: 'starting',
    })
    mockGetEnv.mockImplementation((_, key: string) => {
      if (key === 'BUILDER_URL')
        return builderUrl
      if (key === 'BUILDER_API_KEY')
        return builderApiKey
      if (key === 'JWT_SECRET')
        return jwtSecret
      if (key === 'PUBLIC_URL')
        return publicUrl
      return ''
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a verifiable direct log token for the builder', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'running',
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    }))

    const context = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'requestId')
          return requestId
        return undefined
      }),
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), {
        status,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    }

    try {
      const response = await startBuild(
        context as any,
        jobId,
        appId,
        {
          key: 'cli-api-key',
          user_id: userId,
        } as any,
      )

      expect(response.status).toBe(200)
      const body = await response.json() as {
        status: string
        job_id: string
        logs_url?: string
        logs_token?: string
      }

      expect(body.status).toBe('running')
      expect(body.job_id).toBe(jobId)
      expect(body.logs_url).toBe(`${publicUrl}/build_logs_direct/${jobId}`)
      expect(body.logs_token).toBeTruthy()

      const verification = await jwtVerify(
        body.logs_token!,
        new TextEncoder().encode(jwtSecret),
        {
          issuer: 'capgo',
          audience: 'build-logs',
          subject: userId,
        },
      )

      expect(verification.protectedHeader).toMatchObject({
        alg: 'HS256',
        typ: 'JWT',
      })
      expect(verification.payload.job_id).toBe(jobId)
      expect(verification.payload.app_id).toBe(appId)
      expect(typeof verification.payload.iat).toBe('number')
      expect(typeof verification.payload.exp).toBe('number')
      expect(verification.payload.exp).toBeGreaterThan(verification.payload.iat!)

      expect(fetchMock).toHaveBeenCalledWith(`${builderUrl}/jobs/${jobId}/start`, {
        method: 'POST',
        headers: {
          'x-api-key': builderApiKey,
        },
      })
      expect(mockReserveNativeBuildSlot).toHaveBeenCalledWith(context, {
        buildRequestId: '3eb4f870-720d-46b9-843f-2e6d57d54000',
        orgId: '3eb4f870-720d-46b9-843f-2e6d57d54001',
        appId,
        jobId,
        userId,
      })

      expect(mockSendEventToTracking).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ event: 'Build Started' }),
      )
    }
    finally {
      fetchMock.mockRestore()
    }
  })

  it('emits Build Failed when the builder rejects the start request', async () => {
    // Builder rejection (start.ts:213) calls markBuildAsFailed, which now:
    //  1. fetches the row to capture previousStatus + platform/build_mode/owner_org
    //  2. updates status to 'failed' with a CAS guard
    //  3. emits 'Build Failed' lifecycle event
    // Without step 3 (the bug this guards against), the builder-rejection path
    // would silently update status='failed' but never appear in the lifecycle funnel.

    // Override the admin mock to handle BOTH operations markBuildAsFailed performs:
    //  - `.from('build_requests').select(...)` to read the row
    //  - `.from('build_requests').update(...)` for the CAS write
    const updateBuilder = {
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: 'row-1' }], error: null }),
    }
    const adminSelectChain = {
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          status: 'pending',
          platform: 'ios',
          build_mode: 'release',
          owner_org: '3eb4f870-720d-46b9-843f-2e6d57d54001',
          requested_by: userId,
        },
        error: null,
      }),
    }
    mockSupabaseAdmin.mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        expect(table).toBe('build_requests')
        return {
          update: vi.fn().mockReturnValue(updateBuilder),
          select: vi.fn().mockReturnValue(adminSelectChain),
        }
      }),
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('builder is offline', {
      status: 500,
    }))

    const context = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'requestId')
          return requestId
        return undefined
      }),
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), {
        status,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    }

    try {
      await expect(
        startBuild(context as any, jobId, appId, { key: 'cli-api-key', user_id: userId } as any),
      ).rejects.toThrow()

      // Lifecycle funnel must include the terminal Build Failed transition.
      expect(mockSendEventToTracking).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          event: 'Build Failed',
          tags: expect.objectContaining({
            app_id: appId,
            platform: 'ios',
            build_mode: 'release',
            failure_category: expect.any(String),
          }),
        }),
      )
    }
    finally {
      fetchMock.mockRestore()
    }
  })

  it('marks the build failed when concurrency limit is reached', async () => {
    const { HTTPException } = await import('hono/http-exception')
    const concurrencyMessage = 'Your Solo plan allows 2 concurrent native builds. You already have 2 active. Wait for a build to finish, or upgrade your plan: https://console.capgo.app/settings/organization/plans'
    mockReserveNativeBuildSlot.mockRejectedValue(new HTTPException(429, {
      message: concurrencyMessage,
      cause: {
        error: 'native_build_concurrency_limit_exceeded',
        message: concurrencyMessage,
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

    const updateBuilder = {
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: 'row-1' }], error: null }),
    }
    const updateMock = vi.fn().mockReturnValue(updateBuilder)
    const adminSelectChain = {
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          status: 'pending',
          platform: 'ios',
          build_mode: 'release',
          owner_org: '3eb4f870-720d-46b9-843f-2e6d57d54001',
          requested_by: userId,
        },
        error: null,
      }),
    }
    mockSupabaseAdmin.mockReturnValue({
      from: vi.fn().mockImplementation((table: string) => {
        expect(table).toBe('build_requests')
        return {
          update: updateMock,
          select: vi.fn().mockReturnValue(adminSelectChain),
        }
      }),
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const context = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'requestId')
          return requestId
        return undefined
      }),
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), {
        status,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    }

    try {
      await expect(
        startBuild(context as any, jobId, appId, { key: 'cli-api-key', user_id: userId } as any),
      ).rejects.toMatchObject({
        status: 429,
        message: concurrencyMessage,
      })

      expect(fetchMock).not.toHaveBeenCalled()
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed',
        last_error: concurrencyMessage,
      }))
      expect(updateBuilder.select).toHaveBeenCalled()
      expect(mockSendEventToTracking).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          event: 'Build Failed',
          tags: expect.objectContaining({
            app_id: appId,
          }),
        }),
      )
    }
    finally {
      fetchMock.mockRestore()
    }
  })

  it('skips Build Started emission when CAS guard finds no matching row (lost race)', async () => {
    // Override the default update mock: zero rows returned from .select('id')
    // simulates another writer having already advanced the row's status before
    // this request's UPDATE landed. The CAS guard `.eq('status', previousStatus)`
    // matched no rows, so emitBuildTransitionEvent must NOT be called — the
    // winning writer is responsible for emitting.
    configureUpdateMock({ data: [], error: null })

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'running',
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    }))

    const context = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'requestId')
          return requestId
        return undefined
      }),
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), {
        status,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    }

    try {
      const response = await startBuild(
        context as any,
        jobId,
        appId,
        {
          key: 'cli-api-key',
          user_id: userId,
        } as any,
      )

      // Request still succeeds end-to-end — the CAS loss is silent.
      expect(response.status).toBe(200)
      const body = await response.json() as { status: string, job_id: string }
      expect(body.status).toBe('running')
      expect(body.job_id).toBe(jobId)

      // Lifecycle event must NOT fire on the CAS-lost branch.
      expect(mockSendEventToTracking).not.toHaveBeenCalled()
    }
    finally {
      fetchMock.mockRestore()
    }
  })
})
