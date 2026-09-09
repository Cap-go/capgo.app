import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HTTPException } from 'hono/http-exception'
import { fetchStoreMetadata } from '../supabase/functions/_backend/public/app/store_metadata.ts'

function createContext() {
  return {
    get: vi.fn((key: string) => key === 'requestId' ? 'store-metadata-request' : undefined),
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context<MiddlewareKeyVariables>
}

function appStorePageResponse() {
  return new Response('<meta property="og:title" content="Example App">', {
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

  it('does not report a successful Apple import when both lookups omit the bundle ID', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(appStorePageResponse())
      .mockResolvedValueOnce(appleLookupResponse([]))
      .mockResolvedValueOnce(appleLookupResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    const error = await fetchStoreMetadata(createContext(), {
      url: 'https://apps.apple.com/om/app/example/id123456789',
    }).catch(caught => caught)

    expect(error).toBeInstanceOf(HTTPException)
    expect(error.status).toBe(502)
    expect(error.cause.error).toBe('cannot_fetch_apple_app_id')
  })
})
