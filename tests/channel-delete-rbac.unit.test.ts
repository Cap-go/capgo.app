import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkPermissionMock = vi.fn()
const supabaseApikeyMock = vi.fn()
const closeClientMock = vi.fn()
const getPgClientMock = vi.fn()
const logPgErrorMock = vi.fn()
const queryMock = vi.fn()
const releaseMock = vi.fn()
const connectMock = vi.fn()
const pgClientMock = { connect: connectMock }
const PREVIEW_ORG = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
const TRANSFERRED_ORG = '7d456c9f-0957-4e9c-a5ca-99592dc32cf'

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => checkPermissionMock(...args),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: (...args: unknown[]) => closeClientMock(...args),
  getPgClient: (...args: unknown[]) => getPgClientMock(...args),
  logPgError: (...args: unknown[]) => logPgErrorMock(...args),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: (...args: unknown[]) => supabaseApikeyMock(...args),
}))

const { deleteChannel } = await import('../supabase/functions/_backend/public/channel/delete.ts')

function createChannelBuilder() {
  const deleteResult = {
    data: [{ id: 42 }],
    error: null,
  }
  const builder = {
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn(),
    single: vi.fn().mockResolvedValue({
      data: { id: 42 },
      error: null,
    }),
  }
  builder.select.mockImplementation(() => builder.delete.mock.calls.length > 0 ? Promise.resolve(deleteResult) : builder)
  return { ...builder, deleteResult }
}

function context() {
  return {
    get: vi.fn((key: string) => {
      if (key === 'capgkey')
        return 'test-apikey'
      return undefined
    }),
    json: vi.fn((body: unknown) => Response.json(body)),
  }
}

function createPreviewDeleteQuery(appOwner = PREVIEW_ORG) {
  return async (text: string) => {
    if (text.includes('SELECT owner_org') && text.includes('FROM public.channels') && !text.includes('FOR UPDATE')) {
      return { rowCount: 1, rows: [{ owner_org: PREVIEW_ORG }] }
    }
    if (text.includes('FROM public.apps')) {
      return { rowCount: 1, rows: [{ owner_org: appOwner }] }
    }
    if (text.includes('SELECT id, app_id, owner_org') && text.includes('FROM public.channels')) {
      return {
        rowCount: 1,
        rows: [{
          id: 42,
          app_id: 'com.example.app',
          owner_org: PREVIEW_ORG,
          rbac_id: 'c535b25e-55e2-4fb4-ae8c-53f6c3a9ee7a',
          version: 7,
          rollout_version: null,
        }],
      }
    }
    if (text.includes('rbac_check_permission_direct')) {
      return { rowCount: 1, rows: [{ allowed: true }] }
    }
    if (text.includes('FROM public.role_bindings')) {
      return { rowCount: 1, rows: [{ id: 'binding-id' }] }
    }
    if (text.includes('UPDATE public.app_versions')) {
      return { rowCount: 1, rows: [{ id: 7 }] }
    }
    if (text.includes('FROM public.app_versions')) {
      return { rowCount: 1, rows: [{ id: 7, created_by_apikey_rbac_id: '45e18508-b1f6-4a85-b4c6-37ba102fbd10' }] }
    }
    if (text.includes('AND id <> $2')) {
      return { rowCount: 0, rows: [] }
    }
    if (text.includes('DELETE FROM public.channels')) {
      return { rowCount: 1, rows: [{ id: 42 }] }
    }
    return { rowCount: 0, rows: [] }
  }
}

describe('channel delete RBAC guard', () => {
  let channelBuilder: ReturnType<typeof createChannelBuilder>
  let c: ReturnType<typeof context>

  beforeEach(() => {
    vi.clearAllMocks()
    queryMock.mockReset()
    getPgClientMock.mockReturnValue(pgClientMock)
    connectMock.mockResolvedValue({ query: queryMock, release: releaseMock })
    channelBuilder = createChannelBuilder()
    c = context()
    checkPermissionMock.mockResolvedValue(true)
    supabaseApikeyMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table !== 'channels')
          throw new Error(`Unexpected table: ${table}`)
        return channelBuilder
      }),
    })
  })

  it('checks delete permission against the target channel', async () => {
    const response = await deleteChannel(c as any, {
      app_id: 'com.example.app',
      channel: 'production',
    }, { key: 'test-apikey' } as any)

    expect(response.status).toBe(200)
    expect(checkPermissionMock).toHaveBeenCalledTimes(1)
    expect(checkPermissionMock).toHaveBeenCalledWith(c, 'channel.delete', {
      appId: 'com.example.app',
      channelId: 42,
    })
    expect(channelBuilder.delete).toHaveBeenCalledTimes(1)
    expect(channelBuilder.eq).toHaveBeenCalledWith('id', 42)
  })

  it('fails when channel deletion affects no rows', async () => {
    channelBuilder.deleteResult.data = []

    await expect(deleteChannel(c as any, {
      app_id: 'com.example.app',
      channel: 'production',
    }, { key: 'test-apikey' } as any)).rejects.toHaveProperty('status', 400)

    expect(channelBuilder.select).toHaveBeenCalledWith('id')
  })

  it('does not delete the channel when channel-scoped delete is denied', async () => {
    checkPermissionMock.mockResolvedValueOnce(false)

    await expect(deleteChannel(c as any, {
      app_id: 'com.example.app',
      channel: 'production',
    }, { key: 'test-apikey' } as any)).rejects.toHaveProperty('status', 400)

    expect(checkPermissionMock).toHaveBeenCalledTimes(1)
    expect(checkPermissionMock).toHaveBeenCalledWith(c, 'channel.delete', {
      appId: 'com.example.app',
      channelId: 42,
    })
    expect(channelBuilder.delete).not.toHaveBeenCalled()
  })
  it('locks the org and app before preview channel rows', async () => {
    queryMock.mockImplementation(createPreviewDeleteQuery())

    const response = await deleteChannel(c as any, {
      app_id: 'com.example.app',
      channel: 'preview',
      delete_bundle: true,
    }, {
      key: 'test-apikey',
      user_id: 'user-test',
      rbac_id: '45e18508-b1f6-4a85-b4c6-37ba102fbd10',
    } as any)

    expect(response.status).toBe(200)
    const queryTexts = queryMock.mock.calls.map(([text]) => String(text))
    const channelOwnerLookupIndex = queryTexts.findIndex(text => text.includes('SELECT owner_org') && text.includes('FROM public.channels'))
    const orgLockIndex = queryTexts.findIndex(text => text.includes('lock_rbac_orgs'))
    const appLockIndex = queryTexts.findIndex(text => text.includes('FROM public.apps'))
    const channelLockIndex = queryTexts.findIndex(text => text.includes('SELECT id, app_id, owner_org') && text.includes('FROM public.channels'))
    const bindingLockIndex = queryTexts.findIndex(text => text.includes('FROM public.role_bindings'))
    const bundleLockIndex = queryTexts.findIndex(text => text.includes('pg_advisory_xact_lock'))

    expect(channelOwnerLookupIndex).toBeGreaterThan(-1)
    expect(queryTexts[channelOwnerLookupIndex]).not.toContain('FOR UPDATE')
    expect(orgLockIndex).toBeGreaterThan(channelOwnerLookupIndex)
    expect(appLockIndex).toBeGreaterThan(orgLockIndex)
    expect(queryTexts[appLockIndex]).toContain('FOR UPDATE')
    expect(channelLockIndex).toBeGreaterThan(appLockIndex)
    expect(bindingLockIndex).toBeGreaterThan(channelLockIndex)
    expect(queryTexts[bindingLockIndex]).toContain('FOR KEY SHARE')
    expect(bundleLockIndex).toBeGreaterThan(bindingLockIndex)
  })

  it('aborts before channel locking when the app moves organizations', async () => {
    queryMock.mockImplementation(createPreviewDeleteQuery(TRANSFERRED_ORG))

    await expect(deleteChannel(c as any, {
      app_id: 'com.example.app',
      channel: 'preview',
      delete_bundle: true,
    }, {
      key: 'test-apikey',
      user_id: 'user-test',
      rbac_id: '45e18508-b1f6-4a85-b4c6-37ba102fbd10',
    } as any)).rejects.toHaveProperty('status', 400)

    const queryTexts = queryMock.mock.calls.map(([text]) => String(text))
    expect(queryTexts.some(text => text.includes('SELECT id, app_id, owner_org') && text.includes('FROM public.channels'))).toBe(false)
    expect(queryTexts.some(text => text.includes('FROM public.app_versions'))).toBe(false)
    expect(queryTexts.some(text => text.includes('DELETE FROM public.channels'))).toBe(false)
    expect(checkPermissionMock).not.toHaveBeenCalled()
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK')
  })
})
