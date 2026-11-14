import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const drainMock = vi.hoisted(() => vi.fn(async () => ({ purgedApps: 1, purgedAppIds: ['com.Example.App'] })))
const enqueueMock = vi.hoisted(() => vi.fn(async () => true))
const hasTargetMock = vi.hoisted(() => vi.fn(() => true))

vi.mock('../supabase/functions/_backend/triggers/updates_cache_purge.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../supabase/functions/_backend/triggers/updates_cache_purge.ts')>()
  return {
    ...original,
    nudgeUpdatesCachePurgeDrain: drainMock,
    enqueueUpdatesEdgeCachePurge: enqueueMock,
    hasPurgeTarget: hasTargetMock,
  }
})

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  serializeError: (error: unknown) => String(error),
}))

const { purgeUpdatesCache } = await import('../supabase/functions/_backend/utils/purgeUpdatesCache.ts')

function makeContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'req-purge-helper' : undefined,
    env: {},
  } as any
}

describe('purgeUpdatesCache helper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hasTargetMock.mockReturnValue(true)
    enqueueMock.mockResolvedValue(true)
    drainMock.mockResolvedValue({ purgedApps: 1, purgedAppIds: ['com.Example.App'] })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('enqueues then nudges the shared drain', async () => {
    await expect(purgeUpdatesCache(makeContext(), 'com.Example.App')).resolves.toEqual({
      nudged: true,
      purgedApps: 1,
      purged: true,
      enqueued: true,
    })
    expect(enqueueMock).toHaveBeenCalledWith(expect.anything(), 'com.Example.App', 'app')
    expect(drainMock).toHaveBeenCalledOnce()
  })

  it('sets purged only when this app_id was in the drained batch', async () => {
    drainMock.mockResolvedValueOnce({ purgedApps: 2, purgedAppIds: ['com.other.a', 'com.other.b'] })
    await expect(purgeUpdatesCache(makeContext(), 'com.target.app')).resolves.toEqual({
      nudged: true,
      purgedApps: 2,
      purged: false,
      enqueued: true,
      reason: 'queued',
    })
  })

  it('enqueues on an empty queue then purges when this app is claimed', async () => {
    drainMock.mockResolvedValueOnce({ purgedApps: 1, purgedAppIds: ['com.manual.empty'] })
    await expect(purgeUpdatesCache(makeContext(), 'com.manual.empty', { dedupe: false })).resolves.toMatchObject({
      enqueued: true,
      purged: true,
      nudged: true,
    })
    expect(enqueueMock).toHaveBeenCalledBefore(drainMock)
  })

  it('returns drain_failed without throwing', async () => {
    drainMock.mockRejectedValueOnce(new Error('drain failed'))
    await expect(purgeUpdatesCache(makeContext(), 'com.fail.app')).resolves.toEqual({
      nudged: false,
      purgedApps: 0,
      purged: false,
      enqueued: true,
      reason: 'drain_failed',
    })
  })

  it('returns not_configured when purge env is absent', async () => {
    hasTargetMock.mockReturnValue(false)
    await expect(purgeUpdatesCache(makeContext(), 'com.local.app')).resolves.toEqual({
      nudged: false,
      purgedApps: 0,
      purged: false,
      enqueued: true,
      reason: 'not_configured',
    })
    expect(drainMock).not.toHaveBeenCalled()
  })

  it('returns enqueue_failed when the queue insert fails', async () => {
    enqueueMock.mockResolvedValueOnce(false)
    await expect(purgeUpdatesCache(makeContext(), 'com.enqueue.fail')).resolves.toEqual({
      nudged: false,
      purgedApps: 0,
      purged: false,
      enqueued: false,
      reason: 'enqueue_failed',
    })
    expect(drainMock).not.toHaveBeenCalled()
  })

  it('dedupes multiple calls for the same app on one context by default', async () => {
    const c = makeContext()
    await purgeUpdatesCache(c, 'com.dedupe.app')
    await expect(purgeUpdatesCache(c, 'com.dedupe.app')).resolves.toEqual({
      nudged: false,
      purgedApps: 0,
      purged: false,
      enqueued: false,
      reason: 'deduped',
    })
    expect(drainMock).toHaveBeenCalledOnce()
  })

  it('allows repeated manual purges when dedupe is false', async () => {
    const c = makeContext()
    drainMock
      .mockResolvedValueOnce({ purgedApps: 1, purgedAppIds: ['com.manual.app'] })
      .mockResolvedValueOnce({ purgedApps: 1, purgedAppIds: ['com.manual.app'] })
    await purgeUpdatesCache(c, 'com.manual.app', { dedupe: false })
    await expect(purgeUpdatesCache(c, 'com.manual.app', { dedupe: false })).resolves.toMatchObject({ purged: true })
    expect(drainMock).toHaveBeenCalledTimes(2)
  })

  it('returns invalid_app_id for blank input', async () => {
    await expect(purgeUpdatesCache(makeContext(), '   ')).resolves.toEqual({
      nudged: false,
      purgedApps: 0,
      purged: false,
      enqueued: false,
      reason: 'invalid_app_id',
    })
  })
})