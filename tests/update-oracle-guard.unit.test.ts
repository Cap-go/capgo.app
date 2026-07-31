import { Hono } from 'hono/tiny'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isUpdateEnumerationLimited, recordUpdateEnumerationMiss, updateEnumerationLimitedResponse } from '../supabase/functions/_backend/plugin_runtime/utils/updateOracleGuard.ts'

type CacheKey = Request | string

function cacheKeyToString(key: CacheKey) {
  return typeof key === 'string' ? key : key.url
}

function createMemoryCache() {
  const store = new Map<string, Response>()
  return {
    match: vi.fn(async (key: CacheKey) => store.get(cacheKeyToString(key))?.clone()),
    put: vi.fn(async (key: CacheKey, response: Response) => {
      store.set(cacheKeyToString(key), response.clone())
    }),
  }
}

function createGuardApp() {
  const app = new Hono()
  app.post('/updates', async (c) => {
    const body = await c.req.json<{ app_id: string }>()
    if (body.app_id === 'com.real.app')
      return c.json({ status: 'known' })

    const limit = await recordUpdateEnumerationMiss(c, body.app_id)
    if (limit.limited)
      return updateEnumerationLimitedResponse(c)

    return c.json({ status: 'recorded' })
  })
  app.post('/limited', async (c) => {
    const limit = await isUpdateEnumerationLimited(c)
    if (limit.limited)
      return updateEnumerationLimitedResponse(c)

    return c.json({ status: 'not_limited' })
  })
  return app
}

describe('update enumeration guard', () => {
  let cache: ReturnType<typeof createMemoryCache>

  beforeEach(() => {
    cache = createMemoryCache()
    vi.stubGlobal('caches', {
      open: vi.fn(async () => cache),
    })
    process.env.RATE_LIMIT_UPDATE_ENUMERATION_MISSES = '2'
    process.env.RATE_LIMIT_UPDATE_ENUMERATION_HASH_SECRET = 'test-secret'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.RATE_LIMIT_UPDATE_ENUMERATION_MISSES
    delete process.env.RATE_LIMIT_UPDATE_ENUMERATION_HASH_SECRET
  })

  it('blocks missing app checks after distinct misses reach the configured limit', async () => {
    const app = createGuardApp()
    const headers = {
      'Content-Type': 'application/json',
      'cf-connecting-ip': '203.0.113.10',
    }

    const first = await app.fetch(new Request('http://localhost/updates', {
      method: 'POST',
      headers,
      body: JSON.stringify({ app_id: 'com.missing.first' }),
    }))
    expect(first.status).toBe(200)

    const blocked = await app.fetch(new Request('http://localhost/updates', {
      method: 'POST',
      headers,
      body: JSON.stringify({ app_id: 'com.missing.second' }),
    }))
    expect(blocked.status).toBe(429)
    await expect(blocked.json()).resolves.toMatchObject({ error: 'on_premise_app' })
  })

  it('does not block known apps behind the same IP before they are validated as misses', async () => {
    const app = createGuardApp()
    const headers = {
      'Content-Type': 'application/json',
      'cf-connecting-ip': '203.0.113.12',
    }

    await app.fetch(new Request('http://localhost/updates', {
      method: 'POST',
      headers,
      body: JSON.stringify({ app_id: 'com.missing.first' }),
    }))
    await app.fetch(new Request('http://localhost/updates', {
      method: 'POST',
      headers,
      body: JSON.stringify({ app_id: 'com.missing.second' }),
    }))

    const known = await app.fetch(new Request('http://localhost/updates', {
      method: 'POST',
      headers,
      body: JSON.stringify({ app_id: 'com.real.app' }),
    }))
    expect(known.status).toBe(200)
    await expect(known.json()).resolves.toMatchObject({ status: 'known' })
  })

  it('short-circuits already limited IPs before recording another app ID', async () => {
    const app = createGuardApp()
    const headers = {
      'Content-Type': 'application/json',
      'cf-connecting-ip': '203.0.113.13',
    }

    await app.fetch(new Request('http://localhost/updates', {
      method: 'POST',
      headers,
      body: JSON.stringify({ app_id: 'com.missing.first' }),
    }))
    await app.fetch(new Request('http://localhost/updates', {
      method: 'POST',
      headers,
      body: JSON.stringify({ app_id: 'com.missing.second' }),
    }))

    const blocked = await app.fetch(new Request('http://localhost/limited', {
      method: 'POST',
      headers,
    }))
    expect(blocked.status).toBe(429)
    await expect(blocked.json()).resolves.toMatchObject({ error: 'on_premise_app' })
  })

  it('checks bounded miss slots instead of scanning legacy buckets', async () => {
    const app = createGuardApp()
    const headers = {
      'Content-Type': 'application/json',
      'cf-connecting-ip': '203.0.113.14',
    }

    await app.fetch(new Request('http://localhost/updates', {
      method: 'POST',
      headers,
      body: JSON.stringify({ app_id: 'com.missing.single-bucket' }),
    }))

    const cacheReads = cache.match.mock.calls.map(([key]) => cacheKeyToString(key))
    const slotReads = cacheReads.filter(key => key.includes('/rate-limit/update-enumeration/slot'))
    const legacyBucketReads = cacheReads.filter(key => key.includes('/rate-limit/update-enumeration/bucket'))
    expect(slotReads).toHaveLength(8)
    expect(legacyBucketReads).toHaveLength(0)
  })

  it('does not increase the distinct miss count for repeated app IDs', async () => {
    process.env.RATE_LIMIT_UPDATE_ENUMERATION_MISSES = '3'
    const app = createGuardApp()
    const headers = {
      'Content-Type': 'application/json',
      'cf-connecting-ip': '203.0.113.11',
    }

    for (let i = 0; i < 3; i++) {
      const response = await app.fetch(new Request('http://localhost/updates', {
        method: 'POST',
        headers,
        body: JSON.stringify({ app_id: 'com.same.missing' }),
      }))
      expect(response.status).toBe(200)
    }

    const nextMiss = await app.fetch(new Request('http://localhost/updates', {
      method: 'POST',
      headers,
      body: JSON.stringify({ app_id: 'com.other.missing' }),
    }))
    expect(nextMiss.status).toBe(200)
  })
})
