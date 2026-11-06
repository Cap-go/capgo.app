import { describe, expect, it } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'

describe('public API failed-auth rate limit policy', () => {
  it.each(['/app/', '/channel/', '/bundle/'])('advertises the failed-auth policy on a 401 from %s', async (path) => {
    const response = await apiWorker.fetch(new Request(`https://api.capgo.app${path}`))
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'no_key_provided' })
    expect(response.headers.get('RateLimit-Policy')).toBe('"failed-auth";q=20;w=900')
  })
})
