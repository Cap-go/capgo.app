import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runQueryToCFAMock, getPgClientMock, closeClientMock, getRuntimeKeyMock } = vi.hoisted(() => ({
  runQueryToCFAMock: vi.fn(),
  getPgClientMock: vi.fn(),
  closeClientMock: vi.fn(),
  getRuntimeKeyMock: vi.fn(() => 'node'),
}))

vi.mock('../supabase/functions/_backend/utils/cloudflare.ts', () => ({
  escapeSqlString: (value: string) => value.replace(/'/g, '\'\''),
  formatDateCF: (value: string) => value.replace('T', ' ').replace('Z', ''),
  runQueryToCFA: runQueryToCFAMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: getPgClientMock,
  closeClient: closeClientMock,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: vi.fn(),
  serializeError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
}))

vi.mock('hono/adapter', () => ({
  getRuntimeKey: () => getRuntimeKeyMock(),
}))

const { getAdminChannelSurfing } = await import('../supabase/functions/_backend/utils/channel_surfing.ts')

describe('getAdminChannelSurfing', () => {
  beforeEach(() => {
    runQueryToCFAMock.mockReset()
    getPgClientMock.mockReset()
    closeClientMock.mockReset()
    getRuntimeKeyMock.mockReset()
    getRuntimeKeyMock.mockReturnValue('node')
  })

  it('aggregates setChannel adoption from postgres when analytics engine is unavailable', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ total_events: '12', unique_devices: '5', unique_apps: '2' }],
      })
      .mockResolvedValueOnce({
        rows: [
          { date: '2026-08-01', events: '4', devices: '2', apps: '1' },
          { date: '2026-08-02', events: '8', devices: '4', apps: '2' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { app_id: 'com.demo.app', events: '7', devices: '3' },
          { app_id: 'com.other.app', events: '5', devices: '2' },
        ],
      })

    getPgClientMock.mockReturnValue({ query })
    closeClientMock.mockResolvedValue(undefined)

    const result = await getAdminChannelSurfing(
      { get: () => 'req', env: {} } as any,
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )

    expect(result).toEqual({
      total_events: 12,
      unique_devices: 5,
      unique_apps: 2,
      by_day: [
        { date: '2026-08-01', events: 4, devices: 2, apps: 1 },
        { date: '2026-08-02', events: 8, devices: 4, apps: 2 },
      ],
      top_apps: [
        { app_id: 'com.demo.app', events: 7, devices: 3 },
        { app_id: 'com.other.app', events: 5, devices: 2 },
      ],
    })

    expect(query).toHaveBeenCalledTimes(3)
    expect(String(query.mock.calls[0][0])).toContain(`action = 'setChannel'`)
    expect(runQueryToCFAMock).not.toHaveBeenCalled()
    expect(closeClientMock).toHaveBeenCalledTimes(1)
  })

  it('queries Cloudflare app_log for setChannel when analytics engine is available', async () => {
    getRuntimeKeyMock.mockReturnValue('workerd')
    runQueryToCFAMock
      .mockResolvedValueOnce([{ total_events: 9, unique_devices: 4, unique_apps: 2 }])
      .mockResolvedValueOnce([{ date: '2026-08-01', events: 9, devices: 4, apps: 2 }])
      .mockResolvedValueOnce([{ app_id: 'com.demo.app', events: 9, devices: 4 }])

    const result = await getAdminChannelSurfing(
      { get: () => 'req', env: { APP_LOG: {} } } as any,
      '2026-08-01T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',
      'com.demo.app',
    )

    expect(result).toEqual({
      total_events: 9,
      unique_devices: 4,
      unique_apps: 2,
      by_day: [{ date: '2026-08-01', events: 9, devices: 4, apps: 2 }],
      top_apps: [{ app_id: 'com.demo.app', events: 9, devices: 4 }],
    })
    expect(runQueryToCFAMock).toHaveBeenCalledTimes(3)
    expect(String(runQueryToCFAMock.mock.calls[0][1])).toContain(`blob2 = 'setChannel'`)
    expect(String(runQueryToCFAMock.mock.calls[0][1])).toContain(`index1 = 'com.demo.app'`)
    expect(getPgClientMock).not.toHaveBeenCalled()
  })

  it('returns empty stats when the analytics path throws', async () => {
    getRuntimeKeyMock.mockReturnValue('workerd')
    runQueryToCFAMock.mockRejectedValue(new Error('cfa down'))

    const result = await getAdminChannelSurfing(
      { get: () => 'req', env: { APP_LOG: {} } } as any,
      '2026-08-01T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',
    )

    expect(result).toEqual({
      total_events: 0,
      unique_devices: 0,
      unique_apps: 0,
      by_day: [],
      top_apps: [],
    })
  })
})
