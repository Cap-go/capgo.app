import { afterEach, describe, expect, it, vi } from 'vitest'
import { setReplicationLagHeader } from '../supabase/functions/_backend/utils/pg.ts'

function makeContext(databaseSource: string) {
  const headers = new Headers()
  return {
    context: {
      req: { url: 'https://api.capgo.test/updates' },
      res: new Response(null),
      get: (key: string) => {
        if (key === 'databaseSource')
          return databaseSource
        if (key === 'requestId')
          return `req-${databaseSource}`
        return undefined
      },
      header: (name: string, value: string) => {
        headers.set(name, value)
      },
    },
    headers,
  }
}

describe('replication lag header cache', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reuses replication lag for one minute before querying again', async () => {
    vi.stubGlobal('caches', undefined)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-01T12:00:00Z'))

    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ upstream_lag_seconds: '12.4', primary_commit_lag_seconds: null }] })
        .mockResolvedValueOnce({ rows: [{ upstream_lag_seconds: '25.1', primary_commit_lag_seconds: null }] }),
    }
    const source = `replica-cache-${crypto.randomUUID()}`

    const first = makeContext(source)
    await setReplicationLagHeader(first.context as any, pool as any)
    expect(first.headers.get('X-Replication-Lag')).toBe('ok')
    expect(first.headers.get('X-Replication-Lag-Seconds')).toBe('12')

    const second = makeContext(source)
    await setReplicationLagHeader(second.context as any, pool as any)
    expect(second.headers.get('X-Replication-Lag-Seconds')).toBe('12')
    expect(pool.query).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-05-01T12:01:01Z'))

    const third = makeContext(source)
    await setReplicationLagHeader(third.context as any, pool as any)
    expect(third.headers.get('X-Replication-Lag-Seconds')).toBe('25')
    expect(pool.query).toHaveBeenCalledTimes(2)
  })

  it('emits cached zero-second lag values', async () => {
    vi.stubGlobal('caches', undefined)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-01T12:00:00Z'))

    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ upstream_lag_seconds: '0', primary_commit_lag_seconds: null }] }),
    }
    const source = `replica-zero-${crypto.randomUUID()}`

    const first = makeContext(source)
    await setReplicationLagHeader(first.context as any, pool as any)
    expect(first.headers.get('X-Replication-Lag')).toBe('ok')
    expect(first.headers.get('X-Replication-Lag-Seconds')).toBe('0')

    const second = makeContext(source)
    await setReplicationLagHeader(second.context as any, pool as any)
    expect(second.headers.get('X-Replication-Lag-Seconds')).toBe('0')
    expect(pool.query).toHaveBeenCalledTimes(1)
  })
})
