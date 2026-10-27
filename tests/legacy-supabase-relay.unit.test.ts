import { Hono } from 'hono/tiny'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app as legacySupabase } from '../supabase/functions/_backend/private/legacy_supabase.ts'

// The Supabase edge runtime serves the private function under /functions/v1, so the
// legacy host itself contains /functions/v1/ before the relay's own prefix.
function edgeApp() {
  const root = new Hono()
  root.route('/functions/v1/private/legacy_supabase', legacySupabase)
  return root
}

describe('legacy_supabase /functions/v1 relay', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('relays a released CLI call made through the edge-runtime host', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('PUBLIC_URL', 'https://api.example.com')
    const response = await edgeApp().request('http://kong:8000/functions/v1/private/legacy_supabase/functions/v1/app?x=1', {
      method: 'POST',
      headers: { capgkey: 'key-1', authorization: 'Bearer anon' },
      body: '{}',
    })
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(target).toBe('https://api.example.com/app?x=1')
    expect(new Headers(init.headers).get('authorization')).toBe('key-1')
  })

  it('refuses a relay that points back at the legacy host', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const response = await edgeApp().request('http://kong:8000/functions/v1/private/legacy_supabase/functions/v1/private/legacy_supabase/functions/v1/app', { method: 'GET' })
    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
