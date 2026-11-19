import type { Context } from 'hono'
import { Hono } from 'hono/tiny'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reserveCaptchaFallbackQuota } from '../supabase/functions/_backend/utils/rate_limit.ts'

const CAPTCHA_FALLBACK_EMAIL_LIMIT = 4

type CacheStore = Map<string, Response>

let previousCaches: typeof globalThis.caches | undefined

function installMemoryCache() {
  const store: CacheStore = new Map()
  const cache = {
    match: async (request: Request) => store.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => {
      store.set(request.url, response.clone())
    },
  }

  previousCaches = globalThis.caches
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      open: async () => cache,
    },
  })

  return store
}

async function withContext<T>(handler: (c: Context) => Promise<T>, ip: string) {
  const app = new Hono()
  app.get('/', async (c) => {
    c.set('requestId', 'captcha-fallback-rate-limit-test')
    const result = await handler(c)
    return c.json(result ?? { ok: true })
  })

  const response = await app.request('http://rate-limit.test/', {
    headers: {
      'cf-connecting-ip': ip,
    },
  })

  return await response.json<T>()
}

describe('captcha fallback quota reserve', () => {
  beforeEach(() => {
    installMemoryCache()
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: previousCaches,
    })
  })

  it('increments before enforcing the per-email limit', async () => {
    const email = 'quota-user@example.com'
    for (let attempt = 0; attempt < CAPTCHA_FALLBACK_EMAIL_LIMIT; attempt++) {
      const result = await withContext(c => reserveCaptchaFallbackQuota(c, email), `198.51.100.${attempt + 1}`)
      expect(result.limited).toBe(false)
    }

    const blocked = await withContext(c => reserveCaptchaFallbackQuota(c, email), '203.0.113.4')
    expect(blocked.limited).toBe(true)
    expect(blocked.reason).toBe('captcha_fallback_email_rate_limit')
  })
})
