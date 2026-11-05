import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(),
  orgPolicy: vi.fn(),
  existingVersion: vi.fn(),
  upsert: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => mocks.checkPermission(...args),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: async () => ({ query: async () => ({ rows: [mocks.orgPolicy()] }) }),
  closeClient: () => {},
}))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  apikeyPrincipal: (_c: unknown, apikey: string) => ({ kind: 'apikey', apikey }),
  withRlsContext: (_c: unknown, _principal: unknown, run: (client: unknown) => unknown) => run({}),
  queryJsonOne: async (_client: unknown, text: string, values: unknown[]) => {
    if (text.startsWith('INSERT'))
      return mocks.upsert(text, JSON.parse(values[0] as string))
    return mocks.existingVersion()
  },
}))

const { upsertBundle } = await import('../supabase/functions/_backend/public/bundle/upsert.ts')

function createContext() {
  return {
    json: (body: unknown) => Response.json(body),
  } as any
}

const apikey = { key: 'test-key', user_id: 'user-1' } as any

function mockOrgPolicy(enforce: boolean, requiredKey: string | null = null) {
  mocks.orgPolicy.mockReturnValue({
    owner_org: 'org-1',
    orgs: {
      enforce_encrypted_bundles: enforce,
      required_encryption_key: requiredKey,
    },
  })
}

function mockVersions(existingVersion: unknown) {
  mocks.existingVersion.mockReturnValue(existingVersion)
  mocks.upsert.mockReturnValue({
    id: 99,
    app_id: 'com.example.app',
    name: '1.0.0',
    storage_provider: 'r2-direct',
  })
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
      expect.stringContaining('ON CONFLICT (name, app_id) DO UPDATE SET "app_id" = EXCLUDED."app_id"'),
      {
        app_id: 'com.example.app',
        name: '1.0.0',
        owner_org: 'org-1',
        user_id: 'user-1',
        checksum: 'abc',
        storage_provider: 'r2-direct',
        session_key: 'iv-key',
      },
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
      expect.stringContaining('ON CONFLICT (name, app_id)'),
      expect.objectContaining({ r2_path: 'orgs/org-1/apps/com.example.app/1.0.0.zip' }),
    )
  })
})
