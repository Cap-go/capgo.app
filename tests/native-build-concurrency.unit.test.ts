import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertNativeBuildConcurrencyAvailable,
  buildNativeBuildConcurrencyErrorMessage,
  getPlansUpgradeUrl,
  occupiedBuilderSlotsSql,
  reserveNativeBuildSlot,
  reserveSimulatorSlot,
} from '../supabase/functions/_backend/public/build/concurrency.ts'

const { mockCloseClient, mockGetPgClient, mockLogPgError, mockGetEnv, mockSendEventToTracking } = vi.hoisted(() => ({
  mockCloseClient: vi.fn(),
  mockGetPgClient: vi.fn(),
  mockLogPgError: vi.fn(),
  mockGetEnv: vi.fn(),
  mockSendEventToTracking: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', async () => ({
  ...(await import('./helpers/pg-checkout-release-mocks.ts')),
  closeClient: mockCloseClient,
  getPgClient: mockGetPgClient,
  logPgError: mockLogPgError,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: mockGetEnv,
  trimTrailingSlashes: (value: string) => {
    let end = value.length
    while (end > 0 && value[end - 1] === '/')
      end -= 1
    return value.slice(0, end)
  },
}))

vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: mockSendEventToTracking,
}))

describe('native build concurrency limits', () => {
  const context = {
    get: vi.fn((key: string) => key === 'requestId' ? 'req-native-build-concurrency' : undefined),
  }

  const input = {
    buildRequestId: 'db70bda5-99a9-49e2-a671-e62327e9737f',
    orgId: '91f8cce5-76bc-48f7-8c0e-f4ca64fa2f57',
    appId: 'com.test.native.concurrency',
    jobId: 'job-native-build-concurrency',
    userId: 'user-native-build-concurrency',
  }

  beforeEach(() => {
    mockCloseClient.mockReset()
    mockGetPgClient.mockReset()
    mockLogPgError.mockReset()
    mockGetEnv.mockReset()
    mockSendEventToTracking.mockReset()
    mockGetEnv.mockImplementation((_c: unknown, key: string) => key === 'WEBAPP_URL' ? 'https://console.capgo.app/' : undefined)
    mockSendEventToTracking.mockResolvedValue(undefined)
  })

  it('builds a customer-facing concurrency upgrade message', () => {
    expect(buildNativeBuildConcurrencyErrorMessage({
      activeBuilds: 2,
      limit: 2,
      planName: 'Solo',
      upgradeUrl: 'https://console.capgo.app/settings/organization/plans',
    })).toContain('Your Solo plan allows 2 concurrent native builds')
    expect(getPlansUpgradeUrl(context as any)).toBe('https://console.capgo.app/settings/organization/plans')
  })

  it('reserves a slot when the org is below its plan limit', async () => {
    const { client, pool } = mockPgClient({
      activeCount: 2,
      planLimit: 3,
      planName: 'Maker',
      reservationStatus: 'starting',
    })

    const result = await reserveNativeBuildSlot(context as any, input)

    expect(result).toEqual({
      activeBuilds: 2,
      limit: 3,
      planName: 'Maker',
      upgradeUrl: 'https://console.capgo.app/settings/organization/plans',
      status: 'starting',
    })
    expect(client.query).toHaveBeenCalledWith('BEGIN')
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    expect(client.query).not.toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledTimes(2)
    expect(mockCloseClient).toHaveBeenCalledWith(context, pool)
    expect(mockSendEventToTracking).not.toHaveBeenCalled()
  })

  it('rejects starts when active builds already reached the plan limit', async () => {
    const { client } = mockPgClient({
      activeCount: 2,
      planLimit: 2,
      planName: 'Solo',
    })

    await expect(reserveNativeBuildSlot(context as any, input)).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining('Your Solo plan allows 2 concurrent native builds'),
      cause: expect.objectContaining({
        error: 'native_build_concurrency_limit_exceeded',
        moreInfo: expect.objectContaining({
          activeBuilds: 2,
          limit: 2,
          planName: 'Solo',
          upgrade_url: 'https://console.capgo.app/settings/organization/plans',
          reason: 'native_build_concurrency',
        }),
      }),
    })

    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE public.build_requests'), expect.anything())
    expect(client.release).toHaveBeenCalledTimes(2)
    expect(mockSendEventToTracking).toHaveBeenCalledWith(context, expect.objectContaining({
      event: 'Native build concurrency limit reached',
      sentToBento: true,
      bento: expect.objectContaining({
        event: 'user:native_build_concurrency_limit',
        preferenceKey: 'usage_limit',
        data: expect.objectContaining({
          active_builds: 2,
          limit: 2,
          plan_name: 'Solo',
          upgrade_url: 'https://console.capgo.app/settings/organization/plans',
        }),
      }),
    }))
  })

  it('uses the native build concurrency limit returned from the plans table', async () => {
    const { client } = mockPgClient({
      activeCount: 4,
      planLimit: 6,
      planName: 'Enterprise',
      reservationStatus: 'starting',
    })

    const result = await reserveNativeBuildSlot(context as any, input)

    expect(result.limit).toBe(6)
    expect(result.planName).toBe('Enterprise')
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('current_plan.native_build_concurrency'), [input.orgId])
  })

  it('prechecks concurrency before request creates a builder job', async () => {
    mockPgClient({
      activeCount: 3,
      planLimit: 3,
      planName: 'Maker',
      mode: 'assert',
    })

    await expect(assertNativeBuildConcurrencyAvailable(context as any, {
      orgId: input.orgId,
      appId: input.appId,
      userId: input.userId,
    })).rejects.toMatchObject({
      status: 429,
      cause: expect.objectContaining({
        error: 'native_build_concurrency_limit_exceeded',
      }),
    })

    expect(mockSendEventToTracking).toHaveBeenCalledWith(context, expect.objectContaining({
      event: 'Native build concurrency limit reached',
      sentToBento: true,
      bento: expect.objectContaining({
        event: 'user:native_build_concurrency_limit',
        preferenceKey: 'usage_limit',
      }),
    }))
  })

  it('treats one running simulator plus one build as two builder slots', async () => {
    const { client } = mockPgClient({
      activeCount: 2,
      planLimit: 2,
      planName: 'Solo',
      mode: 'assert',
    })

    await expect(reserveSimulatorSlot(context as any, {
      orgId: input.orgId,
      appId: input.appId,
      userId: input.userId,
      platform: 'ios',
      name: 'Checkout',
    })).rejects.toMatchObject({ status: 429 })

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('public.simulator_sessions'), expect.anything())
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO public.simulator_sessions'), expect.anything())
    expect(occupiedBuilderSlotsSql()).toContain('public.simulator_sessions')
  })

  it('reserves a simulator slot when one slot is still free', async () => {
    mockPgClient({
      activeCount: 1,
      planLimit: 2,
      planName: 'Maker',
      mode: 'assert',
    })

    const result = await reserveSimulatorSlot(context as any, {
      orgId: input.orgId,
      appId: input.appId,
      userId: input.userId,
      platform: 'android',
    })

    expect(result).toEqual({
      id: '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4',
      activeBuilds: 1,
      limit: 2,
      planName: 'Maker',
      upgradeUrl: 'https://console.capgo.app/settings/organization/plans',
    })
  })

  it('does not reserve a simulator after the app moved to another organization', async () => {
    mockPgClient({
      activeCount: 0,
      planLimit: 2,
      planName: 'Maker',
      mode: 'assert',
      appOwnerOrg: '11111111-1111-4111-8111-111111111111',
    })

    await expect(reserveSimulatorSlot(context as any, {
      orgId: input.orgId,
      appId: input.appId,
      userId: input.userId,
      platform: 'ios',
    })).rejects.toMatchObject({ status: 409 })
  })
})

function mockPgClient(options: {
  activeCount: number
  planLimit: number
  planName: string
  reservationStatus?: string
  mode?: 'reserve' | 'assert'
  appOwnerOrg?: string
}) {
  const mode = options.mode ?? 'reserve'
  const client = {
    query: vi.fn(async (query: string, params?: unknown[]) => {
      if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK')
        return { rowCount: null, rows: [] }

      if (query.includes('expire_simulator_sessions'))
        return { rowCount: 1, rows: [{ expire_simulator_sessions: 0 }] }

      if (query.includes('SELECT id FROM public.orgs')) {
        expect(params).toEqual(['91f8cce5-76bc-48f7-8c0e-f4ca64fa2f57'])
        return { rowCount: 1, rows: [{ id: '91f8cce5-76bc-48f7-8c0e-f4ca64fa2f57' }] }
      }

      if (query.includes('current_plan.native_build_concurrency')) {
        expect(params).toEqual(['91f8cce5-76bc-48f7-8c0e-f4ca64fa2f57'])
        return {
          rowCount: 1,
          rows: [{
            native_build_concurrency: options.planLimit,
            plan_name: options.planName,
          }],
        }
      }

      if (query.includes('AS active_count')) {
        expect(query).toContain('public.simulator_sessions')
        expect(query).toContain('max_duration_minutes')
        expect(query).toContain('public.build_requests')
        if (mode === 'assert') {
          expect(params).toEqual([
            '91f8cce5-76bc-48f7-8c0e-f4ca64fa2f57',
            ['pending', 'succeeded', 'failed', 'expired', 'released', 'cancelled', 'canceled'],
          ])
        }
        else {
          expect(params).toEqual([
            '91f8cce5-76bc-48f7-8c0e-f4ca64fa2f57',
            'db70bda5-99a9-49e2-a671-e62327e9737f',
            ['pending', 'succeeded', 'failed', 'expired', 'released', 'cancelled', 'canceled'],
          ])
        }
        return { rowCount: 1, rows: [{ active_count: String(options.activeCount) }] }
      }

      if (query.includes('SELECT owner_org FROM public.apps')) {
        expect(params).toEqual(['com.test.native.concurrency'])
        return { rowCount: 1, rows: [{ owner_org: options.appOwnerOrg ?? '91f8cce5-76bc-48f7-8c0e-f4ca64fa2f57' }] }
      }

      if (query.includes('INSERT INTO public.simulator_sessions')) {
        return { rowCount: 1, rows: [{ id: '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4' }] }
      }

      if (query.includes('UPDATE public.build_requests')) {
        expect(params).toEqual([
          'db70bda5-99a9-49e2-a671-e62327e9737f',
          '91f8cce5-76bc-48f7-8c0e-f4ca64fa2f57',
          'com.test.native.concurrency',
          'job-native-build-concurrency',
          ['succeeded', 'failed', 'expired', 'released', 'cancelled', 'canceled'],
        ])
        return { rowCount: 1, rows: [{ status: options.reservationStatus ?? 'starting' }] }
      }

      throw new Error(`Unexpected query: ${query}`)
    }),
    release: vi.fn(),
  }
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  }
  mockGetPgClient.mockReturnValue(pool)
  return { client, pool }
}
