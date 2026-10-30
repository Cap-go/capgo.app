import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_STORAGE_KEY } from '../src/services/consoleAuth'
import { createConsoleClient, FunctionsFetchError, FunctionsHttpError } from '../src/services/consoleClient'
import { fakeJwt, memoryStorage } from './console-auth-fixtures'

const fetchMock = vi.fn()

function client(token: string | null = 'session-jwt') {
  const storage = memoryStorage()
  if (token)
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ access_token: fakeJwt({ sub: 'user-1' }), refresh_token: 'refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1' } }))
  vi.stubGlobal('localStorage', storage)
  return createConsoleClient()
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  vi.stubEnv('VITE_API_HOST', 'https://api.example.com')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('console client transport', () => {
  it('replays a recorded table query through the Capgo API with the session bearer', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'app-1' }], error: null, count: 1, status: 200 }))
    const result = await client().from('apps').select('id', { count: 'exact' }).eq('owner_org', 'org-1').order('name').limit(10)

    expect(result).toEqual({ data: [{ id: 'app-1' }], error: null, count: 1, status: 200 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.example.com/private/console/query')
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${fakeJwt({ sub: 'user-1' })}`)
    expect(JSON.parse(init.body)).toEqual({
      kind: 'table',
      name: 'apps',
      args: [],
      operations: [
        { method: 'select', args: ['id', { count: 'exact' }] },
        { method: 'eq', args: ['owner_org', 'org-1'] },
        { method: 'order', args: ['name'] },
        { method: 'limit', args: [10] },
      ],
    })
  })

  it('drops trailing undefined arguments so server defaults still apply', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [], error: null, count: null, status: 200 }))
    await client().from('apps').select('id', undefined as any).order('name', undefined as any).range(0, 9)
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body).operations).toEqual([
      { method: 'select', args: ['id'] },
      { method: 'order', args: ['name'] },
      { method: 'range', args: [0, 9] },
    ])
  })

  it('sends rpc arguments and forwards the abort signal', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: true, error: null, count: null, status: 200 }))
    const controller = new AbortController()
    const result = await client().rpc('is_paying_org', { orgid: 'org-1' }).abortSignal(controller.signal)

    expect(result.data).toBe(true)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.signal).toBe(controller.signal)
    expect(JSON.parse(init.body)).toMatchObject({ kind: 'rpc', name: 'is_paying_org', args: [{ orgid: 'org-1' }] })
  })

  it('keeps PostgREST error details so callers can match codes', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: null, error: { message: 'duplicate key', code: '23505', details: null, hint: null }, count: null, status: 409 }))
    const result = await client().from('apps').insert({ app_id: 'dup' } as any)
    expect(result.data).toBeNull()
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error).toMatchObject({ message: 'duplicate key', code: '23505' })
  })

  it('throws on throwOnError like the SDK', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: null, error: { message: 'denied', code: '42501' }, count: null, status: 403 }))
    await expect(client().from('apps').select('id').throwOnError()).rejects.toMatchObject({ code: '42501' })
  })

  it('surfaces API failures as FunctionsHttpError and network failures as FunctionsFetchError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unsupported_query' }, 403))
    const denied = await client().from('secret_table' as any).select('*')
    expect(denied.error).toBeInstanceOf(FunctionsHttpError)
    expect(denied.status).toBe(403)

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const offline = await client().functions.invoke('private/anything', { body: { a: 1 } })
    expect(offline.error).toBeInstanceOf(FunctionsFetchError)
  })

  it('retries read queries after a network drop or a 503, never mutations', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ error: 'booting' }, 503))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'org-1' }], error: null, count: null, status: 200 }))
    const read = await client().rpc('get_orgs_v7')
    expect(read.data).toEqual([{ id: 'org-1' }])
    expect(fetchMock).toHaveBeenCalledTimes(3)

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'booting' }, 503))
    const write = await client().from('apps').update({ name: 'x' } as any).eq('id', 'app-1')
    expect(write.error).toBeInstanceOf(FunctionsHttpError)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // An RPC that mutates is never replayed either, whatever its arguments.
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'booting' }, 503))
    const rpcWrite = await client().rpc('transfer_app', { p_app_id: 'app-1' } as any)
    expect(rpcWrite.error).toBeInstanceOf(FunctionsHttpError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('omits the bearer when there is no session', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: true, error: null, count: null, status: 200 }))
    await client(null).rpc('is_not_deleted', { email_check: 'a@b.c' })
    const [, init] = fetchMock.mock.calls[0]
    expect(new Headers(init.headers).has('Authorization')).toBe(false)
  })

  it('routes storage calls to the image endpoints with raw bytes for uploads', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { signedUrl: 'https://api.example.com/private/console/images/read?path=a&token=t' }, error: null }))
    const signed = await client().storage.from('images').createSignedUrl('org/logo.png', 60)
    expect(signed.data?.signedUrl).toContain('/private/console/images/read')
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/private/console/images/sign')

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { path: 'org/logo.png' }, error: null }))
    const blob = new Blob(['png-bytes'], { type: 'image/png' })
    await client().storage.from('images').upload('org/logo.png', blob, { contentType: 'image/png', upsert: true })
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('https://api.example.com/private/console/images/upload')
    expect(init.body).toBe(blob)
    const headers = new Headers(init.headers)
    expect(headers.get('x-image-path')).toBe('org/logo.png')
    expect(headers.get('x-image-upsert')).toBe('true')
    expect(headers.get('Content-Type')).toBe('image/png')

    expect(() => client().storage.from('other')).toThrow('Unsupported console storage bucket')
  })

  it('reconnects the events stream after a retryable 503 and stops when no events backend exists', async () => {
    vi.useFakeTimers()
    try {
      const statuses: string[] = []
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: 'events_retryable' }, 503))
        .mockResolvedValueOnce(jsonResponse({ error: 'events_unavailable' }, 503))
      client().channel('cli-events:org:org-1').on('broadcast', { event: 'cli-activity' }, () => {}).subscribe(status => statuses.push(status))
      await vi.advanceTimersByTimeAsync(5_000)

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/private/console/events?org_id=org-1')
      expect(statuses).toEqual(['CHANNEL_ERROR', 'CHANNEL_ERROR'])
    }
    finally {
      vi.useRealTimers()
    }
  })
})
