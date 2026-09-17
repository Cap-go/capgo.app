import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchStoreMetadata } from '../supabase/functions/_backend/public/app/store_metadata.ts'

function createContext() {
  return {
    get: vi.fn((key: string) => key === 'requestId' ? 'store-metadata-request' : undefined),
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context<MiddlewareKeyVariables>
}

function appStorePageResponse(iconUrl = '') {
  const iconMeta = iconUrl ? `<meta property="og:image" content="${iconUrl}">` : ''
  return new Response(`<meta property="og:title" content="Example App">${iconMeta}`, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })
}

function appleLookupResponse(results: Array<Record<string, unknown>>, status = 200) {
  return Response.json({ resultCount: results.length, results }, { status })
}

describe('store metadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries an empty storefront lookup and returns the imported Apple bundle ID', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(appStorePageResponse())
      .mockResolvedValueOnce(appleLookupResponse([]))
      .mockResolvedValueOnce(appleLookupResponse([{ bundleId: 'com.example.imported', trackName: 'Example App' }]))
    vi.stubGlobal('fetch', fetchMock)

    const response = await fetchStoreMetadata(createContext(), {
      url: 'https://apps.apple.com/om/app/example/id123456789',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'ok',
      app_id: 'com.example.imported',
      ios_bundle_id: 'com.example.imported',
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://itunes.apple.com/lookup?id=123456789&country=om', expect.anything())
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://itunes.apple.com/lookup?id=123456789', expect.anything())
  })

  it('does not perform the default lookup when the storefront lookup returns a bundle ID', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(appStorePageResponse())
      .mockResolvedValueOnce(appleLookupResponse([{ bundleId: 'com.example.imported', trackName: 'Example App' }]))
    vi.stubGlobal('fetch', fetchMock)

    const response = await fetchStoreMetadata(createContext(), {
      url: 'https://apps.apple.com/om/app/example/id123456789',
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('preserves icon metadata when both Apple lookups omit the bundle ID', async () => {
    const iconUrl = 'https://is1-ssl.mzstatic.com/image/thumb/example/icon.png'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(appStorePageResponse(iconUrl))
      .mockResolvedValueOnce(appleLookupResponse([]))
      .mockResolvedValueOnce(appleLookupResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    const response = await fetchStoreMetadata(createContext(), {
      url: 'https://apps.apple.com/om/app/example/id123456789',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'ok',
      name: 'Example App',
      icon_url: iconUrl,
      app_id: null,
      app_id_lookup_failed: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
