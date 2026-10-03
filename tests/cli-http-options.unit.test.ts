import { afterEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())

vi.stubGlobal('fetch', fetchMock)

const { hasCliPermission, hostOptionsFromClient, resolveUserIdFromApiKey } = await import('../cli/src/utils')

function createLocalClient() {
  return {
    apikey: 'test-api-key',
    supaHost: 'http://127.0.0.1:54321',
    supaAnon: 'test-anon-key',
  }
}

describe('CLI HTTP host resolution', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('hostOptionsFromClient returns local host options for self-host clients', () => {
    expect(hostOptionsFromClient(createLocalClient())).toEqual({
      supaHost: 'http://127.0.0.1:54321',
      supaAnon: 'test-anon-key',
    })
  })

  it('hostOptionsFromClient ignores Capgo-managed Supabase hosts', () => {
    expect(hostOptionsFromClient({
      apikey: 'test-api-key',
      supaHost: 'https://sb.capgo.app',
      supaAnon: 'anon-key',
    })).toBeUndefined()
  })

  it('hasCliPermission routes to local /functions/v1 when httpOptions are omitted', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ allowed: true }),
    })

    const allowed = await hasCliPermission(
      createLocalClient(),
      'test-api-key',
      'app.upload_bundle',
      { appId: 'com.example.app' },
    )

    expect(allowed).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:54321/functions/v1/private/cli/check-permission',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-anon-key',
          capgkey: 'test-api-key',
        }),
      }),
    )
  })

  it('resolveUserIdFromApiKey routes to local /functions/v1 when httpOptions are omitted', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ userId: '11111111-1111-4111-8111-111111111111' }),
    })

    const userId = await resolveUserIdFromApiKey(
      createLocalClient(),
      'test-api-key',
      true,
    )

    expect(userId).toBe('11111111-1111-4111-8111-111111111111')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:54321/functions/v1/private/cli/identity',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-anon-key',
          capgkey: 'test-api-key',
        }),
      }),
    )
  })
})
