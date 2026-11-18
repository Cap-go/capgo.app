import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordStoppedSimulatorDevices } from '../supabase/functions/_backend/public/build/simulator_host.ts'

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
const context = { get: () => 'req-simulator-host' } as any

describe('stopped simulator devices', () => {
  const queries: Array<{ sql: string, params?: unknown[] }> = []

  beforeEach(() => {
    queries.length = 0
    mockGetEnv.mockImplementation((_c: unknown, key: string) => key === 'SIMULATOR_ACCESS_KEY' ? 'access-key' : key === 'SIMULATOR_ORIGIN' ? 'https://sim.example.test/' : undefined)
    mockGetPgClient.mockResolvedValue({
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params })
          if (sql.includes('SELECT id, emulator_id'))
            return { rows: [{ id: idle, emulator_id: idle }, { id: busy, emulator_id: busy }] }
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

  it('records the stop time of a device the host stopped, and leaves a running one alone', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === `https://sim.example.test/v2/device-run-sessions/${idle}`)
        return Response.json({ data: { id: idle, url: 'u', status: 'stopped', finishedAt: '2026-11-09T12:07:00.000Z' } })
      return Response.json({ data: { id: busy, url: 'u', status: 'in-progress', finishedAt: null } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await recordStoppedSimulatorDevices(context, orgId)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const stops = queries.filter(query => query.sql.includes('device_stopped_at = COALESCE'))
    expect(stops).toHaveLength(1)
    expect(stops[0]?.params).toEqual([idle, '2026-11-09T12:07:00.000Z'])
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
