import { Hono } from 'hono/tiny'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app as legacySupabase, setLegacyApiDispatcher } from '../supabase/functions/_backend/private/legacy_supabase.ts'

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
    setLegacyApiDispatcher(null)
  })

  it('replays in-process on Workers with the caller\'s IP, and sends /files over the network', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const dispatched: Request[] = []
    setLegacyApiDispatcher((request) => {
      dispatched.push(request)
      return new Response('{"ok":true}', { status: 200 })
    })
    const root = new Hono()
    root.route('/private/legacy_supabase', legacySupabase)
    const headers = { 'capgkey': 'key-1', 'authorization': 'Bearer anon', 'cf-connecting-ip': '203.0.113.7' }
    const response = await root.request('https://api.example.com/private/legacy_supabase/functions/v1/channel?app_id=x', { method: 'GET', headers })
    expect(response.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].url).toBe('https://api.example.com/channel?app_id=x')
    expect(dispatched[0].headers.get('cf-connecting-ip')).toBe('203.0.113.7')
    expect(dispatched[0].headers.get('authorization')).toBe('key-1')

    await root.request('https://api.example.com/private/legacy_supabase/functions/v1/files/upload_link', { method: 'POST', headers: { ...headers, 'x-forwarded-for': '198.51.100.9' }, body: '{}' })
    expect(dispatched).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The network hop carries the trusted caller address, not the client-supplied one.
    const sent = new Headers((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers)
    expect(sent.get('cf-connecting-ip')).toBe('203.0.113.7')
    expect(sent.get('x-forwarded-for')).toBe('203.0.113.7')
    expect(sent.get('x-real-ip')).toBe('203.0.113.7')
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
