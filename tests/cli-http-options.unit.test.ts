import { afterEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())

vi.stubGlobal('fetch', fetchMock)

const { hasCliPermission, hostOptionsFromSupabase, resolveUserIdFromApiKey } = await import('../cli/src/utils')

function createLocalSupabaseMock() {
  return {
    supabaseUrl: 'http://127.0.0.1:54321',
    supabaseKey: 'test-anon-key',
  }
}

describe('CLI HTTP host resolution', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('hostOptionsFromSupabase returns local host options for self-host clients', () => {
    expect(hostOptionsFromSupabase(createLocalSupabaseMock() as any)).toEqual({
      supaHost: 'http://127.0.0.1:54321',
      supaAnon: 'test-anon-key',
    })
  })

  it('hostOptionsFromSupabase ignores Capgo-managed Supabase hosts', () => {
    expect(hostOptionsFromSupabase({
      supabaseUrl: 'https://sb.capgo.app',
      supabaseKey: 'anon-key',
    } as any)).toBeUndefined()
  })

  it('hasCliPermission routes to local /functions/v1 when httpOptions are omitted', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ allowed: true }),
    })

    const allowed = await hasCliPermission(
      createLocalSupabaseMock() as any,
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
      createLocalSupabaseMock() as any,
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
