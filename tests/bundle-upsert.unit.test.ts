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

const { upsertBundle } = await import('../supabase/functions/_backend/public/bundle/upsert.ts')

function createContext() {
  return {
    json: (body: unknown) => Response.json(body),
  } as any
}

describe('bundle upsert endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.checkPermission.mockResolvedValue(true)
    mocks.adminFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          owner_org: 'org-1',
          orgs: {
            enforce_encrypted_bundles: false,
            required_encryption_key: null,
          },
        },
        error: null,
      }),
    })
    mocks.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      upsert: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: 99,
          app_id: 'com.example.app',
          name: '1.0.0',
          storage_provider: 'r2-direct',
        },
        error: null,
      }),
    })
  })

  it('creates bundle version rows for upload finalize writes', async () => {
    const response = await upsertBundle(
      createContext(),
      {
        app_id: 'com.example.app',
        name: '1.0.0',
        checksum: 'abc',
        storage_provider: 'r2-direct',
        session_key: 'iv-key',
      },
      { key: 'test-key', user_id: 'user-1' } as any,
    )

    expect(response.status).toBe(200)
    const body = await response.json() as { id?: number, name?: string }
    expect(body.id).toBe(99)
    expect(body.name).toBe('1.0.0')
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'app.upload_bundle', {
      appId: 'com.example.app',
    })
  })
})
