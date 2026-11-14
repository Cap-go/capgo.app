import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const drainMock = vi.hoisted(() => vi.fn(async () => ({ purgedApps: 1 })))

vi.mock('../supabase/functions/_backend/triggers/updates_cache_purge.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../supabase/functions/_backend/triggers/updates_cache_purge.ts')>()
  return {
    ...original,
    nudgeUpdatesCachePurgeDrain: drainMock,
  }
})

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  serializeError: (error: unknown) => String(error),
}))

const { purgeUpdatesCache, resetPurgeUpdatesCacheDedupe } = await import('../supabase/functions/_backend/utils/purgeUpdatesCache.ts')

function makeContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'req-purge-helper' : undefined,
    env: {},
  } as any
}

describe('purgeUpdatesCache helper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetPurgeUpdatesCacheDedupe()
    drainMock.mockResolvedValue({ purgedApps: 1 })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('nudges the shared updates cache purge drain', async () => {
    await purgeUpdatesCache(makeContext(), 'com.Example.App')
    expect(drainMock).toHaveBeenCalledOnce()
  })

  it('does not throw when drain fails', async () => {
    drainMock.mockRejectedValueOnce(new Error('drain failed'))
    await expect(purgeUpdatesCache(makeContext(), 'com.fail.app')).resolves.toBeUndefined()
  })

  it('dedupes multiple calls for the same app in one request context', async () => {
    const c = makeContext()
    await purgeUpdatesCache(c, 'com.dedupe.app')
    await purgeUpdatesCache(c, 'com.dedupe.app')
    expect(drainMock).toHaveBeenCalledOnce()
  })
})