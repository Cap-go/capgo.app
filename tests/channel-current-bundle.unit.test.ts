import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(),
  channelRows: vi.fn(),
  versionRow: vi.fn(),
  principal: vi.fn(),
}))

const rlsClient = { kind: 'rls' }
const adminPg = { kind: 'admin' }

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => mocks.checkPermission(...args),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: async () => adminPg,
  closeClient: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  apikeyPrincipal: (_c: unknown, apikey: string) => {
    mocks.principal(apikey)
    return { kind: 'apikey', apikey }
  },
  withRlsContext: async (_c: unknown, _principal: unknown, run: (client: unknown) => unknown) => run(rlsClient),
  queryJson: async (client: unknown, text: string, values: unknown[]) => {
    expect(client).toBe(rlsClient)
    return mocks.channelRows(text, values)
  },
  queryJsonOne: async (client: unknown, text: string, values: unknown[]) => {
    expect(client).toBe(adminPg)
    return mocks.versionRow(text, values)
  },
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
    mocks.channelRows.mockResolvedValue([{ id: 42, disable_auto_update: 'version_number', version: 99 }])
    mocks.versionRow.mockResolvedValue({
      id: 99,
      name: '1.0.0',
      min_update_version: '0.9.0',
      native_packages: [{ name: '@capacitor/core', version: '6.0.0' }],
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
    expect(mocks.principal).toHaveBeenCalledWith('test-key')
    expect(mocks.channelRows).toHaveBeenCalledWith(expect.stringContaining('FROM public.channels'), ['com.example.app', 'production'])
  })

  it('loads the linked version on the service connection so channel.read-only keys see it', async () => {
    mocks.versionRow.mockResolvedValue({ id: 99, name: '1.0.0', min_update_version: null, native_packages: null })

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
    expect(mocks.versionRow).toHaveBeenCalledWith(expect.stringContaining('FROM public.app_versions WHERE app_id = $1 AND id = $2'), ['com.example.app', 99])
  })

  it('returns channel metadata when no bundle is linked', async () => {
    mocks.channelRows.mockResolvedValue([{ id: 42, disable_auto_update: 'none', version: null }])

    const response = await getCurrentBundle(
      createContext(),
      { app_id: 'com.example.app', channel: 'production' },
      { key: 'test-key' } as any,
    )
    expect(response.status).toBe(200)
    const body = await response.json() as { bundle_name?: string | null, disable_auto_update?: string }
    expect(body.bundle_name).toBeNull()
    expect(body.disable_auto_update).toBe('none')
    expect(mocks.versionRow).not.toHaveBeenCalled()
  })

  it.each([
    ['the linked bundle checksum', false, 'sha-abc'],
    ['no checksum for a soft-deleted linked bundle', true, null],
  ])('returns %s', async (_label, deleted, expected) => {
    mocks.versionRow.mockResolvedValue({ id: 99, name: '1.0.0', min_update_version: null, checksum: 'sha-abc', deleted, native_packages: [] })

    const response = await getCurrentBundle(
      createContext(),
      { app_id: 'com.example.app', channel: 'production' },
      { key: 'test-key' } as any,
    )
    const body = await response.json() as { checksum?: string | null }
    expect(body.checksum).toBe(expected)
  })

  it('rejects callers without channel.read', async () => {
    mocks.checkPermission.mockResolvedValueOnce(false)
    await expect(getCurrentBundle(
      createContext(),
      { app_id: 'com.example.app', channel: 'production' },
      { key: 'test-key' } as any,
    )).rejects.toMatchObject({ status: 400 })
    expect(mocks.versionRow).not.toHaveBeenCalled()
  })

  it('treats an unreadable or ambiguous channel as not found', async () => {
    mocks.channelRows.mockResolvedValueOnce([])
    await expect(getCurrentBundle(
      createContext(),
      { app_id: 'com.example.app', channel: 'production' },
      { key: 'test-key' } as any,
    )).rejects.toMatchObject({ status: 400 })

    mocks.channelRows.mockResolvedValueOnce([{ id: 1, disable_auto_update: 'none', version: null }, { id: 2, disable_auto_update: 'none', version: null }])
    await expect(getCurrentBundle(
      createContext(),
      { app_id: 'com.example.app', channel: 'production' },
      { key: 'test-key' } as any,
    )).rejects.toMatchObject({ status: 400 })
    expect(mocks.checkPermission).not.toHaveBeenCalled()
  })
})
