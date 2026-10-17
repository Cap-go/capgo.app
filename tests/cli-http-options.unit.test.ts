import { afterEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())

vi.stubGlobal('fetch', fetchMock)

const { hasCliPermission, hostOptionsFromClient, resolveUserIdFromApiKey } = await import('../cli/src/utils')

const LOCAL_API = 'http://127.0.0.1:54321/functions/v1'

function createLocalClient() {
  return {
    apikey: 'test-api-key',
    apiHost: LOCAL_API,
    filesHost: LOCAL_API,
  }
}

describe('cLI HTTP host resolution', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('hostOptionsFromClient forwards the client API host', () => {
    expect(hostOptionsFromClient(createLocalClient())).toEqual({ apiHost: LOCAL_API })
  })

  it('hasCliPermission uses the client host and only the API key', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ permissions: { 'app.upload_bundle': true } }),
    })

    const allowed = await hasCliPermission(
      createLocalClient(),
      'test-api-key',
      'app.upload_bundle',
      { appId: 'com.example.app' },
    )

    expect(allowed).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      `${LOCAL_API}/private/cli/permissions`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ permissions: ['app.upload_bundle'], app_id: 'com.example.app' }),
        headers: expect.objectContaining({
          Authorization: 'test-api-key',
          capgkey: 'test-api-key',
          capgo_api: '2025-10-01',
        }),
      }),
    )
  })

  it('resolveUserIdFromApiKey uses the client host', async () => {
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
      `${LOCAL_API}/private/cli/identity`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'test-api-key',
          capgkey: 'test-api-key',
        }),
      }),
    )
  })
})
