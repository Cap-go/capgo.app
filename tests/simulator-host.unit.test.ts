import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordStoppedSimulatorDevices, simulatorMaxSessionStopIso, simulatorRecordedDeviceStopIso } from '../supabase/functions/_backend/public/build/simulator_host.ts'

const { mockGetPgClient, mockCloseClient, mockGetEnv, mockLogErr } = vi.hoisted(() => ({
  mockGetPgClient: vi.fn(),
  mockCloseClient: vi.fn(),
  mockGetEnv: vi.fn(),
  mockLogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', async () => ({
  ...(await import('./helpers/pg-checkout-release-mocks.ts')),
  closeClient: mockCloseClient,
  getPgClient: mockGetPgClient,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: mockGetEnv,
  trimTrailingSlashes: (value: string) => value.replace(/\/+$/, ''),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: mockLogErr,
}))

const orgId = '91f8cce5-76bc-48f7-8c0e-f4ca64fa2f57'
const idle = '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4'
const busy = '7b1e0d3f-2c50-4f9b-8d44-1c8f6e3b22d5'
const maxed = '8d3e1f2a-9c4b-4e5f-a6b7-c8d9e0f1a2b3'
const busyStartedAt = '2026-11-09T12:05:00.000Z'
const maxedStartedAt = '2026-11-09T11:00:00.000Z'
const syncNow = Date.parse('2026-11-09T12:10:00.000Z')
const context = { get: () => 'req-simulator-host' } as any

describe('stopped simulator devices', () => {
  const queries: Array<{ sql: string, params?: unknown[] }> = []

  beforeEach(() => {
    queries.length = 0
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    mockGetEnv.mockImplementation((_c: unknown, key: string) => key === 'SIMULATOR_ACCESS_KEY' ? 'access-key' : key === 'SIMULATOR_ORIGIN' ? 'https://sim.example.test/' : undefined)
    mockGetPgClient.mockResolvedValue({
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params })
          if (sql.includes('SELECT id, emulator_id'))
            return {
              rows: [
                { id: idle, emulator_id: idle, started_at: fiveMinutesAgo, created_at: fiveMinutesAgo, max_duration_minutes: 40 },
                { id: busy, emulator_id: busy, started_at: fiveMinutesAgo, created_at: fiveMinutesAgo, max_duration_minutes: 40 },
              ],
            }
          if (sql.includes('device_stopped_at = COALESCE'))
            return { rows: [{ device_stopped_at: params?.[1] }] }
          return { rows: [] }
        },
        release: () => {},
      }),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    mockGetEnv.mockReset()
    mockGetPgClient.mockReset()
    mockLogErr.mockReset()
  })

  it('records the stop time of a device the host stopped, caps a session at its maximum, and leaves a fresh one alone', async () => {
    vi.useFakeTimers()
    try {
    vi.setSystemTime(syncNow)
    mockGetPgClient.mockResolvedValue({
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params })
          if (sql.includes('SELECT id, emulator_id'))
            return {
              rows: [
                { id: idle, emulator_id: idle, started_at: '2026-11-09T11:55:00.000Z', created_at: '2026-11-09T11:55:00.000Z', max_duration_minutes: 40 },
                { id: busy, emulator_id: busy, started_at: busyStartedAt, created_at: busyStartedAt, max_duration_minutes: 40 },
                { id: maxed, emulator_id: maxed, started_at: maxedStartedAt, created_at: maxedStartedAt, max_duration_minutes: 40 },
              ],
            }
          if (sql.includes('device_stopped_at = COALESCE'))
            return { rows: [{ device_stopped_at: params?.[1] }] }
          return { rows: [] }
        },
        release: () => {},
      }),
    })
    const fetchMock = vi.fn(async (url: string) => {
      if (url === `https://sim.example.test/v2/device-run-sessions/${idle}`)
        return Response.json({ data: { id: idle, url: 'u', status: 'stopped', finishedAt: '2026-11-09T12:07:00.000Z' } })
      return Response.json({ data: { id: busy, url: 'u', status: 'in-progress', finishedAt: null } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await recordStoppedSimulatorDevices(context, orgId)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const stops = queries.filter(query => query.sql.includes('device_stopped_at = COALESCE'))
    expect(stops).toHaveLength(2)
    expect(stops.map(stop => stop.params)).toEqual(expect.arrayContaining([
      [maxed, '2026-11-09T11:40:00.000Z'],
      [idle, '2026-11-09T12:07:00.000Z'],
    ]))
    expect(stops.some(stop => stop.params?.[0] === busy)).toBe(false)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('keeps the host idle stop when sync runs after the maximum', () => {
    expect(simulatorRecordedDeviceStopIso('2026-11-09T11:07:00.000Z', '2026-11-09T11:40:00.000Z')).toBe('2026-11-09T11:07:00.000Z')
    expect(simulatorRecordedDeviceStopIso('2026-11-09T12:45:00.000Z', '2026-11-09T11:40:00.000Z')).toBe('2026-11-09T11:40:00.000Z')
  })

  it('returns the maximum stop instant only once the session cap is reached', () => {
    const openedAt = '2026-11-09T11:00:00.000Z'
    expect(simulatorMaxSessionStopIso(openedAt, 40, Date.parse('2026-11-09T11:39:59.000Z'))).toBeUndefined()
    expect(simulatorMaxSessionStopIso(openedAt, 40, Date.parse('2026-11-09T11:40:00.000Z'))).toBe('2026-11-09T11:40:00.000Z')
    expect(simulatorMaxSessionStopIso('2026-11-09T11:00:00.123Z', 40, Date.parse('2026-11-09T11:40:01.000Z'))).toBe('2026-11-09T11:40:00.123Z')
  })

  it('never blocks the caller when the host is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))
    await expect(recordStoppedSimulatorDevices(context, orgId)).resolves.toBeUndefined()
    expect(queries.some(query => query.sql.includes('device_stopped_at = COALESCE'))).toBe(false)
    expect(mockLogErr).toHaveBeenCalled()
  })

  it('does nothing when the simulator is not configured', async () => {
    mockGetEnv.mockReturnValue(undefined)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await recordStoppedSimulatorDevices(context, orgId)
    expect(mockGetPgClient).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
