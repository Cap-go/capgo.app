import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { updatesAppCacheTag } from '../supabase/functions/_backend/plugin_runtime/utils/updatesCacheTag.ts'

const purgeTagsMock = vi.hoisted(() => vi.fn(async () => ({
  configured: true,
  calls: 1,
  failed: 0,
  retryAfterSeconds: 0,
})))

vi.mock('../supabase/functions/_backend/triggers/updates_cache_purge.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../supabase/functions/_backend/triggers/updates_cache_purge.ts')>()
  return {
    ...original,
    purgeUpdatesCacheTags: purgeTagsMock,
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
    purgeTagsMock.mockResolvedValue({ configured: true, calls: 1, failed: 0, retryAfterSeconds: 0 })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('requests purge of the capgo-updates app tag', async () => {
    await purgeUpdatesCache(makeContext(), 'com.Example.App')
    expect(purgeTagsMock).toHaveBeenCalledWith(expect.anything(), [updatesAppCacheTag('com.Example.App')])
  })

  it('does not throw when purge fails', async () => {
    purgeTagsMock.mockResolvedValueOnce({ configured: true, calls: 1, failed: 1, retryAfterSeconds: 5 })
    await expect(purgeUpdatesCache(makeContext(), 'com.fail.app')).resolves.toBeUndefined()
  })

  it('skips when purge is not configured', async () => {
    purgeTagsMock.mockResolvedValueOnce({ configured: false, calls: 0, failed: 0, retryAfterSeconds: 0 })
    await purgeUpdatesCache(makeContext(), 'com.local.app')
    expect(purgeTagsMock).toHaveBeenCalledOnce()
  })

  it('dedupes multiple calls for the same app in one request', async () => {
    const c = makeContext()
    await purgeUpdatesCache(c, 'com.dedupe.app')
    await purgeUpdatesCache(c, 'com.dedupe.app')
    expect(purgeTagsMock).toHaveBeenCalledOnce()
  })
})