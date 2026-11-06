import type { Context } from 'hono'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setAPIKeyRateLimitHeaders, setFailedAuthRateLimitPolicyHeader } from '../supabase/functions/_backend/utils/rate_limit.ts'

function appWith(handler: (c: Context) => Response) {
  const app = new Hono()
  app.get('/', handler)
  return app
}

describe('RateLimit headers', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('reports the default API key quota, remaining requests and reset', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const response = await appWith((c) => {
      setAPIKeyRateLimitHeaders(c, 'default', { count: 5, resetAt: 1_000_000 + 42_000 })
      return c.json({ ok: true })
    }).request('/')
    expect(response.headers.get('RateLimit-Policy')).toBe('"apikey";q=2000;w=60')
    expect(response.headers.get('RateLimit')).toBe('"apikey";r=1995;t=42')
  })

  it('uses the upload quota and never reports negative remaining requests', async () => {
    const response = await appWith((c) => {
      setAPIKeyRateLimitHeaders(c, 'upload', { count: 30_000 })
      return c.json({ ok: true })
    }).request('/')
    expect(response.headers.get('RateLimit-Policy')).toBe('"apikey-upload";q=20000;w=60')
    expect(response.headers.get('RateLimit')).toBe('"apikey-upload";r=0;t=60')
  })

  it('honours the RATE_LIMIT_API_KEY override', async () => {
    vi.stubEnv('RATE_LIMIT_API_KEY', '100')
    const response = await appWith((c) => {
      setAPIKeyRateLimitHeaders(c, 'default', { count: 1 })
      return c.json({ ok: true })
    }).request('/')
    expect(response.headers.get('RateLimit-Policy')).toBe('"apikey";q=100;w=60')
  })

  it('honours the RATE_LIMIT_API_KEY_UPLOAD override', async () => {
    vi.stubEnv('RATE_LIMIT_API_KEY_UPLOAD', '500')
    const response = await appWith((c) => {
      setAPIKeyRateLimitHeaders(c, 'upload', { count: 499 })
      return c.json({ ok: true })
    }).request('/')
    expect(response.headers.get('RateLimit-Policy')).toBe('"apikey-upload";q=500;w=60')
    expect(response.headers.get('RateLimit')).toBe('"apikey-upload";r=1;t=60')
  })

  it('advertises the failed-auth policy', async () => {
    const response = await appWith((c) => {
      setFailedAuthRateLimitPolicyHeader(c)
      return c.json({ error: 'no_key_provided' }, 401)
    }).request('/')
    expect(response.headers.get('RateLimit-Policy')).toBe('"failed-auth";q=20;w=900')
  })
})
