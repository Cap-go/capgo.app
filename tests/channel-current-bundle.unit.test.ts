import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(),
  from: vi.fn(),
  adminFrom: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => mocks.checkPermission(...args),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: () => ({
    from: (...args: unknown[]) => mocks.from(...args),
  }),
  supabaseAdmin: () => ({
    from: (...args: unknown[]) => mocks.adminFrom(...args),
  }),
}))

function queryMock(result: { data: unknown, error: unknown }) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue(result),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

const { getCurrentBundle } = await import('../supabase/functions/_backend/public/channel/current_bundle.ts')

function createContext() {
  return {
    json: (body: unknown) => Response.json(body),
  } as any
}

describe('channel current bundle endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.checkPermission.mockResolvedValue(true)
    mocks.from.mockReturnValue(queryMock({
      data: { id: 42, disable_auto_update: 'version_number', version: 99 },
      error: null,
    }))
    mocks.adminFrom.mockReturnValue(queryMock({
      data: {
        id: 99,
        name: '1.0.0',
        min_update_version: '0.9.0',
        native_packages: [{ name: '@capacitor/core', version: '6.0.0' }],
      },
      error: null,
    }))
  })

  it('returns bundle compatibility fields when channel.read is allowed', async () => {
    const response = await getCurrentBundle(
      createContext(),
      { app_id: 'com.example.app', channel: 'production' },
      { key: 'test-key' } as any,
    )
    expect(response.status).toBe(200)
    const body = await response.json() as {
      bundle_name?: string
      bundle_id?: number
      min_update_version?: string | null
      native_packages?: unknown[]
      disable_auto_update?: string
    }
    expect(body.bundle_name).toBe('1.0.0')
    expect(body.bundle_id).toBe(99)
    expect(body.min_update_version).toBe('0.9.0')
    expect(body.disable_auto_update).toBe('version_number')
    expect(body.native_packages).toEqual([{ name: '@capacitor/core', version: '6.0.0' }])
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'channel.read', {
      appId: 'com.example.app',
      channelId: 42,
    })
  })

  it('loads the linked version with the admin client so channel.read-only keys see it', async () => {
    const adminQuery = queryMock({
      data: { id: 99, name: '1.0.0', min_update_version: null, native_packages: null },
      error: null,
    })
    mocks.adminFrom.mockReturnValue(adminQuery)

    const response = await getCurrentBundle(
      createContext(),
      { app_id: 'com.example.app', channel: 'production' },
      { key: 'test-key' } as any,
    )
    expect(response.status).toBe(200)
    const body = await response.json() as { bundle_name?: string, min_update_version?: string | null, native_packages?: unknown[] }
    expect(body.bundle_name).toBe('1.0.0')
    expect(body.min_update_version).toBeNull()
    expect(body.native_packages).toEqual([])
    expect(mocks.adminFrom).toHaveBeenCalledWith('app_versions')
    expect(adminQuery.eq).toHaveBeenCalledWith('app_id', 'com.example.app')
    expect(adminQuery.eq).toHaveBeenCalledWith('id', 99)
  })

  it('returns channel metadata when no bundle is linked', async () => {
    mocks.from.mockReturnValue(queryMock({
      data: { id: 42, disable_auto_update: 'none', version: null },
      error: null,
    }))

    const response = await getCurrentBundle(
      createContext(),
      { app_id: 'com.example.app', channel: 'production' },
      { key: 'test-key' } as any,
    )
    expect(response.status).toBe(200)
    const body = await response.json() as { bundle_name?: string | null, disable_auto_update?: string }
    expect(body.bundle_name).toBeNull()
    expect(body.disable_auto_update).toBe('none')
    expect(mocks.adminFrom).not.toHaveBeenCalled()
  })

  it('rejects callers without channel.read', async () => {
    mocks.checkPermission.mockResolvedValueOnce(false)
    await expect(getCurrentBundle(
      createContext(),
      { app_id: 'com.example.app', channel: 'production' },
      { key: 'test-key' } as any,
    )).rejects.toMatchObject({ status: 400 })
    expect(mocks.adminFrom).not.toHaveBeenCalled()
  })
})
