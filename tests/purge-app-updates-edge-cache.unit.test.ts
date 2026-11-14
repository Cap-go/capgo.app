import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const drainMock = vi.hoisted(() => vi.fn(async () => ({ purgedApps: 1, purgedAppIds: ['com.claimed.app'] })))
const hasTargetMock = vi.hoisted(() => vi.fn(() => true))
const queryMock = vi.hoisted(() => vi.fn(async () => ({ rows: [] })))
const getPgClientMock = vi.hoisted(() => vi.fn(async () => ({ query: queryMock })))
const closeClientMock = vi.hoisted(() => vi.fn())

vi.mock('../supabase/functions/_backend/triggers/updates_cache_purge.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../supabase/functions/_backend/triggers/updates_cache_purge.ts')>()
  return {
    ...original,
    nudgeUpdatesCachePurgeDrain: drainMock,
    hasPurgeTarget: hasTargetMock,
  }
})

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: getPgClientMock,
  closeClient: closeClientMock,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: vi.fn(),
  serializeError: (error: unknown) => String(error),
}))

const { purgeAppUpdatesCache } = await import('../supabase/functions/_backend/utils/purgeAppUpdatesCache.ts')

function makeContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'req-purge-app' : undefined,
    env: {},
  } as any
}

describe('purgeAppUpdatesCache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hasTargetMock.mockReturnValue(true)
    drainMock.mockResolvedValue({ purgedApps: 1, purgedAppIds: ['com.claimed.app'] })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('enqueues and nudges the shared drain', async () => {
    await expect(purgeAppUpdatesCache(makeContext(), 'com.claimed.app')).resolves.toEqual({
      nudged: true,
      purgedApps: 1,
      purged: true,
    })
    expect(queryMock).toHaveBeenCalledWith(
      'SELECT public.notify_updates_edge_cache_purge($1::text[], $2::text)',
      [['com.claimed.app'], 'app'],
    )
    expect(drainMock).toHaveBeenCalledOnce()
  })

  it('sets purged false when the app was not in the claimed batch', async () => {
    drainMock.mockResolvedValueOnce({ purgedApps: 2, purgedAppIds: ['com.other.app'] })
    await expect(purgeAppUpdatesCache(makeContext(), 'com.waiting.app')).resolves.toEqual({
      nudged: true,
      purgedApps: 2,
      purged: false,
    })
  })

  it('returns nudged false when purge is not configured', async () => {
    hasTargetMock.mockReturnValue(false)
    await expect(purgeAppUpdatesCache(makeContext(), 'com.local.app')).resolves.toEqual({
      nudged: false,
      purgedApps: 0,
      purged: false,
    })
    expect(queryMock).not.toHaveBeenCalled()
    expect(drainMock).not.toHaveBeenCalled()
  })
})