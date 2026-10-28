import { beforeEach, describe, expect, it, vi } from 'vitest'

const getPgClientMock = vi.fn()
const closeClientMock = vi.fn()

vi.mock('../supabase/functions/_backend/utils/pg.ts', async () => ({
  ...(await vi.importActual<typeof import('../supabase/functions/_backend/utils/pg.ts')>('../supabase/functions/_backend/utils/pg.ts')),
  getPgClient: (...args: unknown[]) => getPgClientMock(...args),
  closeClient: (...args: unknown[]) => closeClientMock(...args),
}))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', async () => ({
  ...(await vi.importActual<typeof import('../supabase/functions/_backend/utils/pg_rls.ts')>('../supabase/functions/_backend/utils/pg_rls.ts')),
  // One fake transaction per read: record overlap on the same client.
  withRlsTransaction: async (pg: any, _principal: unknown, run: (client: unknown) => Promise<unknown>) => {
    if (pg.open)
      pg.interleaved = true
    pg.open = true
    pg.active.count++
    pg.active.max = Math.max(pg.active.max, pg.active.count)
    await new Promise(resolve => setTimeout(resolve, 5))
    try {
      return await run({})
    }
    finally {
      pg.active.count--
      pg.open = false
    }
  },
  queryJson: async () => [{ ok: true }],
}))

const { statisticsTestUtils } = await import('../supabase/functions/_backend/public/statistics/index.ts')

describe('statistics db lanes', () => {
  const active = { count: 0, max: 0 }
  const clients: any[] = []

  beforeEach(() => {
    active.count = 0
    active.max = 0
    clients.length = 0
    getPgClientMock.mockReset().mockImplementation(async () => {
      const pg = { open: false, interleaved: false, active }
      clients.push(pg)
      return pg
    })
    closeClientMock.mockReset()
  })

  it('runs concurrent reads on at most four clients without interleaving one client', async () => {
    const c = {} as any
    await statisticsTestUtils.withStatsDb(c, { kind: 'service' }, db =>
      Promise.all(Array.from({ length: 12 }, (_, i) => db('SELECT $1', [i]))))

    expect(clients).toHaveLength(4)
    expect(active.max).toBe(4)
    expect(clients.some(pg => pg.interleaved)).toBe(false)
    expect(closeClientMock).toHaveBeenCalledTimes(4)
  })

  it('reuses one client for sequential reads', async () => {
    const c = {} as any
    await statisticsTestUtils.withStatsDb(c, { kind: 'service' }, async (db) => {
      await db('SELECT 1', [])
      await db('SELECT 2', [])
    })

    expect(clients).toHaveLength(1)
    expect(closeClientMock).toHaveBeenCalledTimes(1)
  })

  it('opens a fresh connection after one fails to connect', async () => {
    getPgClientMock.mockRejectedValueOnce(new Error('connect failed'))
    const c = {} as any
    await statisticsTestUtils.withStatsDb(c, { kind: 'service' }, async (db) => {
      await expect(db('SELECT 1', [])).rejects.toThrow('connect failed')
      await expect(db('SELECT 2', [])).resolves.toEqual([{ ok: true }])
    })

    expect(getPgClientMock).toHaveBeenCalledTimes(2)
    expect(closeClientMock).toHaveBeenCalledTimes(1)
  })
})
