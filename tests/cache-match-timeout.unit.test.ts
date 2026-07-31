import { afterEach, describe, expect, it, vi } from 'vitest'
import { CACHE_MATCH_TIMEOUT_MS, CACHE_PUT_TIMEOUT_MS, CacheHelper } from '../supabase/functions/_backend/plugin_runtime/utils/cache.ts'

function makeContext() {
  return {
    req: { url: 'https://api.capgo.test/updates' },
    get: (key: string) => key === 'requestId' ? 'req-cache-timeout' : undefined,
  } as any
}

function stubCaches(api: { match: ReturnType<typeof vi.fn>, put?: ReturnType<typeof vi.fn>, delete?: ReturnType<typeof vi.fn> }) {
  const cache = {
    match: api.match,
    put: api.put ?? vi.fn(),
    delete: api.delete ?? vi.fn(),
  }
  vi.stubGlobal('caches', {
    default: cache,
    open: vi.fn().mockResolvedValue(cache),
  })
}

describe('CacheHelper.matchJson timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('returns cached JSON when Cache API is fast', async () => {
    stubCaches({
      match: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 'cloud' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    })

    const helper = new CacheHelper(makeContext())
    const key = helper.buildRequest('/.app-status-v3', { app_id: 'com.test.app' })
    await expect(helper.matchJson<{ status: string }>(key)).resolves.toEqual({ status: 'cloud' })
  })

  it('fails open with null when Cache API stalls past timeout', async () => {
    vi.useFakeTimers()
    stubCaches({
      match: vi.fn().mockImplementation(() => new Promise(() => {})),
    })

    const helper = new CacheHelper(makeContext())
    const key = helper.buildRequest('/.app-status-v3', { app_id: 'com.test.app' })
    const pending = helper.matchJson(key, { timeoutMs: CACHE_MATCH_TIMEOUT_MS })
    await vi.advanceTimersByTimeAsync(CACHE_MATCH_TIMEOUT_MS + 1)
    await expect(pending).resolves.toBeNull()
  })

  it('fails open with null when ensureCache open stalls', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('caches', {
      open: vi.fn().mockImplementation(() => new Promise(() => {})),
    })

    const helper = new CacheHelper(makeContext())
    const key = helper.buildRequest('/.app-status-v3', { app_id: 'com.test.app' })
    const pending = helper.matchJson(key, { timeoutMs: 15 })
    await vi.advanceTimersByTimeAsync(16)
    await expect(pending).resolves.toBeNull()
  })

  it('fails open with null when caches.open rejects', async () => {
    vi.stubGlobal('caches', {
      open: vi.fn().mockRejectedValue(new Error('cache open failed')),
    })

    const helper = new CacheHelper(makeContext())
    const key = helper.buildRequest('/.app-status-v3', { app_id: 'com.test.app' })
    await expect(helper.matchJson(key)).resolves.toBeNull()
  })
})

describe('CacheHelper.putJson timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('writes when Cache API put is fast', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    stubCaches({
      match: vi.fn(),
      put,
    })

    const helper = new CacheHelper(makeContext())
    const key = helper.buildRequest('/.track-device-cache', { app_id: 'com.test.app', device_id: 'd1' })
    await helper.putJson(key, { ok: true }, 60)
    expect(put).toHaveBeenCalledOnce()
  })

  it('fails open when Cache API put stalls past timeout', async () => {
    vi.useFakeTimers()
    const put = vi.fn().mockImplementation(() => new Promise(() => {}))
    stubCaches({
      match: vi.fn(),
      put,
    })

    const helper = new CacheHelper(makeContext())
    const key = helper.buildRequest('/.track-device-cache', { app_id: 'com.test.app', device_id: 'd1' })
    const pending = helper.putJson(key, { ok: true }, 60)
    await vi.advanceTimersByTimeAsync(CACHE_PUT_TIMEOUT_MS + 1)
    await expect(pending).resolves.toBeUndefined()
  })
})
