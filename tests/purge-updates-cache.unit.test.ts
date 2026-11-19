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

const { purgeAppUpdatesCache, purgeUpdatesCache } = await import('../supabase/functions/_backend/utils/purgeUpdatesCache.ts')

function makeContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'req-purge-helper' : undefined,
    env: {},
  } as any
}

describe('purgeAppUpdatesCache', () => {
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
    await expect(purgeAppUpdatesCache(makeContext(), 'com.Example.App')).resolves.toEqual({
      nudged: true,
      purgedApps: ['com.Example.App'],
      purged: true,
    })
    expect(enqueueMock).toHaveBeenCalledWith(expect.anything(), 'com.Example.App', 'app')
    expect(drainMock).toHaveBeenCalledOnce()
  })

  it('sets purged only when this app_id is in purgedApps', async () => {
    drainMock.mockResolvedValueOnce({ purgedApps: 2, purgedAppIds: ['com.other.a', 'com.other.b'] })
    await expect(purgeAppUpdatesCache(makeContext(), 'com.target.app')).resolves.toEqual({
      nudged: true,
      purgedApps: ['com.other.a', 'com.other.b'],
      purged: false,
    })
  })

  it('enqueues on an empty queue then purges when this app is claimed', async () => {
    drainMock.mockResolvedValueOnce({ purgedApps: 1, purgedAppIds: ['com.manual.empty'] })
    await expect(purgeAppUpdatesCache(makeContext(), 'com.manual.empty')).resolves.toEqual({
      nudged: true,
      purgedApps: ['com.manual.empty'],
      purged: true,
    })
    expect(enqueueMock).toHaveBeenCalledBefore(drainMock)
  })

  it('returns zeros when the queue insert fails', async () => {
    enqueueMock.mockResolvedValueOnce(false)
    await expect(purgeAppUpdatesCache(makeContext(), 'com.enqueue.fail')).resolves.toEqual({
      nudged: false,
      purgedApps: [],
      purged: false,
    })
    expect(drainMock).not.toHaveBeenCalled()
  })

  it('skips drain when purge env is absent', async () => {
    hasTargetMock.mockReturnValue(false)
    await expect(purgeAppUpdatesCache(makeContext(), 'com.local.app')).resolves.toEqual({
      nudged: false,
      purgedApps: [],
      purged: false,
    })
    expect(enqueueMock).toHaveBeenCalledOnce()
    expect(drainMock).not.toHaveBeenCalled()
  })
})

describe('purgeUpdatesCache trigger wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hasTargetMock.mockReturnValue(true)
    enqueueMock.mockResolvedValue(true)
    drainMock.mockResolvedValue({ purgedApps: 1, purgedAppIds: ['com.dedupe.app'] })
  })

  it('dedupes multiple calls for the same app on one context by default', async () => {
    const c = makeContext()
    await purgeUpdatesCache(c, 'com.dedupe.app')
    await expect(purgeUpdatesCache(c, 'com.dedupe.app')).resolves.toMatchObject({ reason: 'deduped' })
    expect(drainMock).toHaveBeenCalledOnce()
  })

  it('allows repeated manual purges when dedupe is false', async () => {
    const c = makeContext()
    drainMock
      .mockResolvedValueOnce({ purgedApps: 1, purgedAppIds: ['com.manual.app'] })
      .mockResolvedValueOnce({ purgedApps: 1, purgedAppIds: ['com.manual.app'] })
    await purgeUpdatesCache(c, 'com.manual.app', { dedupe: false })
    await purgeUpdatesCache(c, 'com.manual.app', { dedupe: false })
    expect(drainMock).toHaveBeenCalledTimes(2)
  })
})