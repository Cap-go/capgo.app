import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(),
  from: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => mocks.checkPermission(...args),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: () => ({
    from: (...args: unknown[]) => mocks.from(...args),
  }),
}))

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
    mocks.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 42,
          disable_auto_update: 'version_number',
          version: {
            id: 99,
            name: '1.0.0',
            min_update_version: '0.9.0',
            native_packages: [{ name: '@capacitor/core', version: '6.0.0' }],
          },
        },
        error: null,
      }),
    })
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
      native_packages?: unknown[]
      disable_auto_update?: string
    }
    expect(body.bundle_name).toBe('1.0.0')
    expect(body.bundle_id).toBe(99)
    expect(body.disable_auto_update).toBe('version_number')
    expect(body.native_packages).toEqual([{ name: '@capacitor/core', version: '6.0.0' }])
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'channel.read', {
      appId: 'com.example.app',
      channelId: 42,
    })
  })

  it('returns channel metadata when no bundle is linked', async () => {
    mocks.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 42,
          disable_auto_update: 'none',
          version: null,
        },
        error: null,
      }),
    })

    const response = await getCurrentBundle(
      createContext(),
      { app_id: 'com.example.app', channel: 'production' },
      { key: 'test-key' } as any,
    )
    expect(response.status).toBe(200)
    const body = await response.json() as { bundle_name?: string | null, disable_auto_update?: string }
    expect(body.bundle_name).toBeNull()
    expect(body.disable_auto_update).toBe('none')
  })

  it('rejects callers without channel.read', async () => {
    mocks.checkPermission.mockResolvedValueOnce(false)
    await expect(getCurrentBundle(
      createContext(),
      { app_id: 'com.example.app', channel: 'production' },
      { key: 'test-key' } as any,
    )).rejects.toMatchObject({ status: 400 })
  })
})
