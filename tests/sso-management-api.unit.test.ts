import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSSOProvider, deleteSSOProvider, restoreSSOProvider, snapshotSSOProvider, updateSSOProvider } from '../supabase/functions/_backend/utils/supabase-management.ts'

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_context: unknown, key: string) => ({
    SB_MANAGEMENT_API_TOKEN: 'management-token',
    MAIN_SUPABASE_DB_URL: 'postgresql://postgres@db.projectref.supabase.co:5432/postgres',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  } as Record<string, string>)[key] ?? '',
  trimTrailingSlashes: (value: string) => value.replace(/\/+$/, ''),
}))

const context = { get: vi.fn(() => 'request-id') } as unknown as Context

function mockFetch() {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ id: 'provider-id' }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function sentBody(fetchMock: ReturnType<typeof mockFetch>) {
  return JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('supabase Management API SSO provider calls', () => {
  it('creates providers with their domain and metadata', async () => {
    const fetchMock = mockFetch()

    await createSSOProvider(context, 'example.com', { metadata_url: 'https://idp.example.com/metadata' })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.supabase.com/v1/projects/projectref/config/auth/sso/providers')
    expect(sentBody(fetchMock)).toEqual({
      type: 'saml',
      domains: ['example.com'],
      metadata_url: 'https://idp.example.com/metadata',
    })
  })

  it('sends raw metadata XML when the IdP URL is not reachable', async () => {
    const fetchMock = mockFetch()

    await createSSOProvider(context, 'example.com', { metadata_xml: '<EntityDescriptor/>' })

    const body = sentBody(fetchMock)
    expect(body.metadata_xml).toBe('<EntityDescriptor/>')
    expect(body).not.toHaveProperty('metadata_url')
  })

  it('updates with PUT and forwards an empty domain list to stop sign-in', async () => {
    const fetchMock = mockFetch()

    await updateSSOProvider(context, 'provider-id', { domains: [] })

    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('PUT')
    expect(sentBody(fetchMock)).toEqual({ domains: [] })
  })

  it('aborts a hanging call after 8 seconds and reports it as 504', async () => {
    // Drive the deadline by hand: the request only settles once its signal aborts.
    const deadline = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })))

    const pending = updateSSOProvider(context, 'provider-id', { domains: [] })
    expect(timeoutSpy).toHaveBeenCalledWith(8_000)
    deadline.abort(new DOMException('The operation timed out.', 'TimeoutError'))

    await expect(pending).rejects.toMatchObject({ status: 504, code: 'management_api_timeout' })
    timeoutSpy.mockRestore()
  })

  it('snapshots a provider without domains as an explicit empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'provider-id',
      saml: { entity_id: 'idp', metadata_xml: '<EntityDescriptor/>' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    expect(await snapshotSSOProvider(context, 'provider-id')).toEqual({ metadata_xml: '<EntityDescriptor/>', domains: [] })
  })

  it('snapshots the Auth provider and restores it verbatim', async () => {
    const attributeMapping = { keys: { groups: { name: 'memberOf', array: true } } }
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      id: 'provider-id',
      saml: { entity_id: 'idp', metadata_url: 'https://idp.example.com/metadata', attribute_mapping: attributeMapping },
      domains: [{ domain: 'example.com' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await snapshotSSOProvider(context, 'provider-id')
    expect(snapshot).toEqual({ metadata_url: 'https://idp.example.com/metadata', attribute_mapping: attributeMapping, domains: ['example.com'] })

    await restoreSSOProvider(context, 'provider-id', snapshot)
    const [url, init] = fetchMock.mock.calls[1]!
    expect(url).toBe('https://api.supabase.com/v1/projects/projectref/config/auth/sso/providers/provider-id')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual(snapshot)
  })
})

describe('sSO provider calls with a GOTRUE binding', () => {
  function bindingContext(response: Response) {
    const bindingFetch = vi.fn(async (_url: string, _init?: RequestInit) => response)
    const globalFetch = vi.fn()
    vi.stubGlobal('fetch', globalFetch)
    const bound = { get: vi.fn(() => 'request-id'), env: { GOTRUE: { fetch: bindingFetch } } } as unknown as Context
    return { bound, bindingFetch, globalFetch }
  }

  it('sends the same body to GoTrue\'s admin API with the service key, not to the Management API', async () => {
    const { bound, bindingFetch, globalFetch } = bindingContext(new Response(JSON.stringify({ id: 'provider-id' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }))

    expect(await createSSOProvider(bound, 'example.com', { metadata_url: 'https://idp.example.com/metadata' })).toEqual({ id: 'provider-id' })

    expect(globalFetch).not.toHaveBeenCalled()
    const [url, init] = bindingFetch.mock.calls[0]!
    expect(url).toBe('https://gotrue/admin/sso/providers')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer service-key')
    expect(new Headers(init?.headers).get('apikey')).toBe('service-key')
    expect(JSON.parse(init?.body as string)).toEqual({ type: 'saml', domains: ['example.com'], metadata_url: 'https://idp.example.com/metadata' })
  })

  it('addresses one provider by id and keeps GoTrue\'s error message and code', async () => {
    const { bound, bindingFetch } = bindingContext(new Response(JSON.stringify({ code: 400, error_code: 'saml_entity_id_mismatch', msg: 'EntityID mismatch' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(updateSSOProvider(bound, 'provider-id', { domains: [] })).rejects.toMatchObject({ status: 400, code: 'saml_entity_id_mismatch', message: 'EntityID mismatch' })
    expect(bindingFetch.mock.calls[0]?.[0]).toBe('https://gotrue/admin/sso/providers/provider-id')
    expect(bindingFetch.mock.calls[0]?.[1]?.method).toBe('PUT')
  })

  it('snapshots, restores and deletes through GoTrue with the service key', async () => {
    const provider = { id: 'provider-id', saml: { entity_id: 'idp', metadata_xml: '<EntityDescriptor/>' }, domains: [{ domain: 'example.com' }] }
    const bindingFetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(provider), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', vi.fn())
    const bound = { get: vi.fn(() => 'request-id'), env: { GOTRUE: { fetch: bindingFetch } } } as unknown as Context

    const snapshot = await snapshotSSOProvider(bound, 'provider-id')
    await restoreSSOProvider(bound, 'provider-id', snapshot)
    await deleteSSOProvider(bound, 'provider-id')

    expect(bindingFetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://gotrue/admin/sso/providers/provider-id', 'GET'],
      ['https://gotrue/admin/sso/providers/provider-id', 'PUT'],
      ['https://gotrue/admin/sso/providers/provider-id', 'DELETE'],
    ])
    for (const [, init] of bindingFetch.mock.calls)
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer service-key')
    expect(JSON.parse(bindingFetch.mock.calls[1]?.[1]?.body as string)).toEqual({ metadata_xml: '<EntityDescriptor/>', domains: ['example.com'] })
  })
})
