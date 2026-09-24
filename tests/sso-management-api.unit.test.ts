import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSSOProvider, restoreSSOProvider, snapshotSSOProvider, updateSSOProvider } from '../supabase/functions/_backend/utils/supabase-management.ts'

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_context: unknown, key: string) => ({
    SB_MANAGEMENT_API_TOKEN: 'management-token',
    MAIN_SUPABASE_DB_URL: 'postgresql://postgres@db.projectref.supabase.co:5432/postgres',
  } as Record<string, string>)[key] ?? '',
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
  it('creates providers disabled so Supabase Auth refuses logins before DNS proof', async () => {
    const fetchMock = mockFetch()

    await createSSOProvider(context, 'example.com', { metadata_url: 'https://idp.example.com/metadata' })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.supabase.com/v1/projects/projectref/config/auth/sso/providers')
    expect(sentBody(fetchMock)).toEqual({
      type: 'saml',
      domains: ['example.com'],
      disabled: true,
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

  it('updates with PUT and forwards the disabled flag, including false', async () => {
    const fetchMock = mockFetch()

    await updateSSOProvider(context, 'provider-id', { disabled: false })

    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('PUT')
    expect(sentBody(fetchMock)).toEqual({ disabled: false })
  })

  it('snapshots a missing or null disabled flag as explicitly enabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'provider-id',
      saml: { entity_id: 'idp', metadata_xml: '<EntityDescriptor/>' },
      disabled: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    expect(await snapshotSSOProvider(context, 'provider-id')).toEqual({ metadata_xml: '<EntityDescriptor/>', disabled: false })
  })

  it('snapshots the Auth provider and restores it verbatim', async () => {
    const attributeMapping = { keys: { groups: { name: 'memberOf', array: true } } }
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      id: 'provider-id',
      saml: { entity_id: 'idp', metadata_url: 'https://idp.example.com/metadata', attribute_mapping: attributeMapping },
      disabled: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await snapshotSSOProvider(context, 'provider-id')
    expect(snapshot).toEqual({ metadata_url: 'https://idp.example.com/metadata', attribute_mapping: attributeMapping, disabled: true })

    await restoreSSOProvider(context, 'provider-id', snapshot)
    const [url, init] = fetchMock.mock.calls[1]!
    expect(url).toBe('https://api.supabase.com/v1/projects/projectref/config/auth/sso/providers/provider-id')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual(snapshot)
  })
})
