import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(),
  from: vi.fn(),
  adminFrom: vi.fn(),
  upsert: vi.fn(),
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

const apikey = { key: 'test-key', user_id: 'user-1' } as any

function mockOrgPolicy(enforce: boolean, requiredKey: string | null = null) {
  mocks.adminFrom.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({
      data: {
        owner_org: 'org-1',
        orgs: {
          enforce_encrypted_bundles: enforce,
          required_encryption_key: requiredKey,
        },
      },
      error: null,
    }),
  })
}

function mockVersions(existingVersion: unknown) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: existingVersion, error: null }),
    upsert: mocks.upsert,
    single: vi.fn().mockResolvedValue({
      data: {
        id: 99,
        app_id: 'com.example.app',
        name: '1.0.0',
        storage_provider: 'r2-direct',
      },
      error: null,
    }),
  }
  mocks.upsert.mockReturnValue(query)
  mocks.from.mockReturnValue(query)
}

describe('bundle upsert endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.checkPermission.mockResolvedValue(true)
    mockOrgPolicy(false)
    mockVersions(null)
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
      apikey,
    )

    expect(response.status).toBe(200)
    const body = await response.json() as { id?: number, name?: string }
    expect(body.id).toBe(99)
    expect(body.name).toBe('1.0.0')
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'app.upload_bundle', {
      appId: 'com.example.app',
    })
    expect(mocks.upsert).toHaveBeenCalledTimes(1)
    expect(mocks.upsert).toHaveBeenCalledWith(
      {
        app_id: 'com.example.app',
        name: '1.0.0',
        owner_org: 'org-1',
        user_id: 'user-1',
        checksum: 'abc',
        storage_provider: 'r2-direct',
        session_key: 'iv-key',
      },
      { onConflict: 'name,app_id' },
    )
  })

  it('rejects clearing session_key on an existing version when the org enforces encryption', async () => {
    mockOrgPolicy(true)
    mockVersions({ id: 99, deleted: false, session_key: 'iv-key', key_id: null })

    await expect(upsertBundle(
      createContext(),
      { app_id: 'com.example.app', name: '1.0.0', session_key: null },
      apikey,
    )).rejects.toMatchObject({ status: 400, cause: { error: 'encryption_required' } })
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('rejects swapping key_id on an existing version to a non-required key', async () => {
    mockOrgPolicy(true, 'required-key-value-0123456789')
    mockVersions({ id: 99, deleted: false, session_key: 'iv-key', key_id: 'required-key-value-0' })

    await expect(upsertBundle(
      createContext(),
      { app_id: 'com.example.app', name: '1.0.0', key_id: 'other-key' },
      apikey,
    )).rejects.toMatchObject({ status: 400, cause: { error: 'encryption_key_mismatch' } })
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('allows non-encryption updates on an existing version under an encryption policy', async () => {
    mockOrgPolicy(true)
    mockVersions({ id: 99, deleted: false, session_key: null, key_id: null })

    const response = await upsertBundle(
      createContext(),
      { app_id: 'com.example.app', name: '1.0.0', r2_path: 'orgs/org-1/apps/com.example.app/1.0.0.zip' },
      apikey,
    )

    expect(response.status).toBe(200)
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ r2_path: 'orgs/org-1/apps/com.example.app/1.0.0.zip' }),
      { onConflict: 'name,app_id' },
    )
  })
})
