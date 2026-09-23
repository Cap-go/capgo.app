import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(async () => true),
  rpc: vi.fn(),
  from: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => mocks.checkPermission(...args),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: () => ({
    from: (...args: unknown[]) => mocks.from(...args),
    rpc: (...args: unknown[]) => mocks.rpc(...args),
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
    mocks.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 42, version: 99 },
        error: null,
      }),
    })
    mocks.rpc.mockResolvedValue({
      data: [{ bundle_name: '1.0.0' }],
      error: null,
    })
  })

  it('returns bundle_name when channel.read is allowed', async () => {
    const response = await getCurrentBundle(
      createContext(),
      { app_id: 'com.example.app', channel: 'production' },
      { key: 'test-key' } as any,
    )
    expect(response.status).toBe(200)
    const body = await response.json() as { bundle_name?: string }
    expect(body.bundle_name).toBe('1.0.0')
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'channel.read', {
      appId: 'com.example.app',
      channelId: 42,
    })
    expect(mocks.rpc).toHaveBeenCalledWith('get_channel_current_bundle_rbac', {
      p_app_id: 'com.example.app',
      p_channel_id: 42,
    })
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
