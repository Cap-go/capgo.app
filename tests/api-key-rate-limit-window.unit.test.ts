import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'

// In-memory stand-in for the Cloudflare cache that backs the rate limit counters.
const store = new Map<string, unknown>()
vi.mock('../supabase/functions/_backend/utils/cache.ts', () => ({
  CacheHelper: class {
    buildRequest(path: string, params: Record<string, string> = {}) {
      return new Request(`https://cache.local${path}?${new URLSearchParams(params)}`)
    }

    async matchJson<T>(key: Request): Promise<T | null> {
      return (store.get(key.url) as T | undefined) ?? null
    }

    async putJson(key: Request, payload: unknown) {
      store.set(key.url, payload)
    }
  },
}))

const { isAPIKeyRateLimited, isIPRateLimited, recordAPIKeyUsage, recordFailedAuth } = await import('../supabase/functions/_backend/utils/rate_limit.ts')

function context(): Context {
  return {
    env: {},
    get: () => 'test-request',
    req: { header: (name: string) => (name === 'cf-connecting-ip' ? '203.0.113.7' : undefined) },
  } as unknown as Context
}

afterEach(() => {
  store.clear()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('API key rate limit window', () => {
  it('allows exactly the advertised quota per window', async () => {
    vi.stubEnv('RATE_LIMIT_API_KEY', '3')
    const c = context()
    const results: boolean[] = []
    for (let i = 0; i < 4; i++) {
      await recordAPIKeyUsage(c, 1)
      results.push((await isAPIKeyRateLimited(c, 1)).limited)
    }
    expect(results).toEqual([false, false, false, true])
  })

  it('keeps a fixed window: calls do not extend it, and the quota recovers when it ends', async () => {
    vi.stubEnv('RATE_LIMIT_API_KEY', '2')
    vi.useFakeTimers({ now: 1_000_000 })
    const c = context()
    const first = await recordAPIKeyUsage(c, 1)
    expect(first.resetAt).toBe(1_060_000)

    vi.setSystemTime(1_030_000)
    const second = await recordAPIKeyUsage(c, 1)
    expect(second).toEqual({ count: 2, resetAt: 1_060_000 })
    await recordAPIKeyUsage(c, 1)
    expect((await isAPIKeyRateLimited(c, 1)).limited).toBe(true)

    vi.setSystemTime(1_060_001)
    const next = await recordAPIKeyUsage(c, 1)
    expect(next).toEqual({ count: 1, resetAt: 1_120_001 })
    expect((await isAPIKeyRateLimited(c, 1)).limited).toBe(false)
  })
})

describe('failed-auth IP limit', () => {
  it('still blocks once the 20th failed attempt is recorded', async () => {
    const c = context()
    for (let i = 0; i < 19; i++)
      await recordFailedAuth(c)
    expect((await isIPRateLimited(c)).limited).toBe(false)
    await recordFailedAuth(c)
    expect((await isIPRateLimited(c)).limited).toBe(true)
  })
})
