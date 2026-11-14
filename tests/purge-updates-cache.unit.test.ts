import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const drainMock = vi.hoisted(() => vi.fn(async () => ({ purgedApps: 1 })))
const hasTargetMock = vi.hoisted(() => vi.fn(() => true))

vi.mock('../supabase/functions/_backend/triggers/updates_cache_purge.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../supabase/functions/_backend/triggers/updates_cache_purge.ts')>()
  return {
    ...original,
    nudgeUpdatesCachePurgeDrain: drainMock,
    hasPurgeTarget: hasTargetMock,
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
    hasTargetMock.mockReturnValue(true)
    drainMock.mockResolvedValue({ purgedApps: 1 })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('nudges the shared updates cache purge drain', async () => {
    await expect(purgeUpdatesCache(makeContext(), 'com.Example.App')).resolves.toEqual({ purged: true })
    expect(drainMock).toHaveBeenCalledOnce()
  })

  it('returns drain_failed without throwing', async () => {
    drainMock.mockRejectedValueOnce(new Error('drain failed'))
    await expect(purgeUpdatesCache(makeContext(), 'com.fail.app')).resolves.toEqual({ purged: false, reason: 'drain_failed' })
  })

  it('returns not_configured when purge env is absent', async () => {
    hasTargetMock.mockReturnValue(false)
    await expect(purgeUpdatesCache(makeContext(), 'com.local.app')).resolves.toEqual({ purged: false, reason: 'not_configured' })
    expect(drainMock).not.toHaveBeenCalled()
  })

  it('dedupes multiple calls for the same app on one context by default', async () => {
    const c = makeContext()
    await purgeUpdatesCache(c, 'com.dedupe.app')
    await expect(purgeUpdatesCache(c, 'com.dedupe.app')).resolves.toEqual({ purged: false, reason: 'deduped' })
    expect(drainMock).toHaveBeenCalledOnce()
  })

  it('allows repeated manual purges when dedupe is false', async () => {
    const c = makeContext()
    await purgeUpdatesCache(c, 'com.manual.app', { dedupe: false })
    await expect(purgeUpdatesCache(c, 'com.manual.app', { dedupe: false })).resolves.toEqual({ purged: true })
    expect(drainMock).toHaveBeenCalledTimes(2)
  })

  it('returns invalid_app_id for blank input', async () => {
    await expect(purgeUpdatesCache(makeContext(), '   ')).resolves.toEqual({ purged: false, reason: 'invalid_app_id' })
  })
})