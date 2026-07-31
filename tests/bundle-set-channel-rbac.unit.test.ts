import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkPermissionPgMock = vi.fn()
const closeClientMock = vi.fn()
const getDrizzleClientMock = vi.fn()
const logPgErrorMock = vi.fn()
const queryMock = vi.fn()
const releaseMock = vi.fn()
const connectMock = vi.fn()
const pgClientMock = { connect: connectMock }
const transactionClientMock = { query: queryMock, release: releaseMock }
const transactionDrizzleMock = {}

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermissionPg: (...args: unknown[]) => checkPermissionPgMock(...args),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: (...args: unknown[]) => closeClientMock(...args),
  getDrizzleClient: (...args: unknown[]) => getDrizzleClientMock(...args),
  getPgClient: () => pgClientMock,
  logPgError: (...args: unknown[]) => logPgErrorMock(...args),
}))

const { setChannel } = await import('../supabase/functions/_backend/public/bundle/set_channel.ts')

function context() {
  return {
    get: vi.fn((key: string) => {
      if (key === 'capgkey')
        return 'test-apikey'
      if (key === 'requestId')
        return 'test-request'
      return undefined
    }),
    json: vi.fn((body: unknown) => Response.json(body)),
  }
}

function apiKey() {
  return { key: 'test-apikey', user_id: 'user-test' } as any
}

describe('bundle set channel RBAC guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkPermissionPgMock.mockResolvedValue(true)
    getDrizzleClientMock.mockReturnValue(transactionDrizzleMock)
    queryMock.mockImplementation(async (text: string) => {
      if (text.includes('FROM public.channels')) {
        return { rowCount: 1, rows: [{ name: 'production', owner_org: '046a36ac-e03c-4590-9257-bd6c9dba9ee8' }] }
      }
      if (text.includes('FROM public.app_versions')) {
        return { rowCount: 1, rows: [{ name: '1.0.0' }] }
      }
      return {
        rowCount: text.includes('UPDATE public.channels') ? 1 : undefined,
        rows: [],
      }
    })
    connectMock.mockResolvedValue(transactionClientMock)
  })

  it('checks promotion permission against the target channel on its transaction connection', async () => {
    const c = context()

    const response = await setChannel(c as any, {
      app_id: 'com.example.app',
      version_id: 7,
      channel_id: 42,
    }, apiKey())

    expect(response.status).toBe(200)
    expect(checkPermissionPgMock).toHaveBeenCalledTimes(1)
    expect(getDrizzleClientMock).toHaveBeenCalledWith(transactionClientMock)
    expect(checkPermissionPgMock).toHaveBeenCalledWith(
      c,
      'channel.promote_bundle',
      { appId: 'com.example.app', channelId: 42 },
      transactionDrizzleMock,
      'user-test',
      'test-apikey',
    )
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('FROM public.app_versions'), [
      7,
      'com.example.app',
    ])
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('FROM public.channels'), [
      42,
      'com.example.app',
    ])
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('UPDATE public.channels'), [
      7,
      42,
      'com.example.app',
      '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    ])

    const queryTexts = queryMock.mock.calls.map(([text]) => String(text))
    const targetChannelQueryIndex = queryTexts.findIndex(text => text.includes('FROM public.channels'))
    const bundleLockQueryIndex = queryTexts.findIndex(text => text.includes('pg_advisory_xact_lock'))
    const versionQueryIndex = queryTexts.findIndex(text => text.includes('FROM public.app_versions'))

    expect(queryTexts[targetChannelQueryIndex]).toContain('FOR UPDATE')
    expect(bundleLockQueryIndex).toBeGreaterThan(targetChannelQueryIndex)
    expect(bundleLockQueryIndex).toBeLessThan(versionQueryIndex)
    expect(queryMock).toHaveBeenCalledWith(
      'SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)',
      [7],
    )
  })

  it('rolls back without updating when channel-scoped promotion is denied', async () => {
    const c = context()
    checkPermissionPgMock.mockResolvedValueOnce(false)

    await expect(setChannel(c as any, {
      app_id: 'com.example.app',
      version_id: 7,
      channel_id: 42,
    }, apiKey())).rejects.toHaveProperty('status', 400)

    expect(checkPermissionPgMock).toHaveBeenCalledTimes(1)
    expect(checkPermissionPgMock).toHaveBeenCalledWith(
      c,
      'channel.promote_bundle',
      { appId: 'com.example.app', channelId: 42 },
      expect.anything(),
      'user-test',
      'test-apikey',
    )
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('FROM public.channels'), [
      42,
      'com.example.app',
    ])
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK')
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining('FROM public.app_versions'), expect.anything())
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE public.channels'), expect.anything())
  })

  it('uses app-scoped promotion permission when the target channel is missing', async () => {
    const c = context()
    queryMock.mockImplementation(async (text: string) => {
      if (text.includes('FROM public.channels'))
        return { rowCount: 0, rows: [] }
      return { rowCount: undefined, rows: [] }
    })
    checkPermissionPgMock.mockResolvedValueOnce(false)

    await expect(setChannel(c as any, {
      app_id: 'com.example.app',
      version_id: 7,
      channel_id: 42,
    }, apiKey())).rejects.toMatchObject({
      status: 400,
      cause: expect.objectContaining({ error: 'cannot_access_app' }),
    })

    expect(checkPermissionPgMock).toHaveBeenCalledTimes(1)
    expect(checkPermissionPgMock).toHaveBeenCalledWith(
      c,
      'channel.promote_bundle',
      { appId: 'com.example.app' },
      expect.anything(),
      'user-test',
      'test-apikey',
    )
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK')
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining('FROM public.app_versions'), expect.anything())
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE public.channels'), expect.anything())
  })

  it('checks the version before returning a missing-channel error', async () => {
    const c = context()
    queryMock.mockImplementation(async (text: string) => {
      if (text.includes('FROM public.channels'))
        return { rowCount: 0, rows: [] }
      if (text.includes('FROM public.app_versions'))
        return { rowCount: 0, rows: [] }
      return { rowCount: undefined, rows: [] }
    })

    await expect(setChannel(c as any, {
      app_id: 'com.example.app',
      version_id: 7,
      channel_id: 42,
    }, apiKey())).rejects.toMatchObject({
      status: 400,
      cause: expect.objectContaining({ error: 'cannot_find_version' }),
    })

    expect(checkPermissionPgMock).toHaveBeenCalledWith(
      c,
      'channel.promote_bundle',
      { appId: 'com.example.app' },
      expect.anything(),
      'user-test',
      'test-apikey',
    )
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('FROM public.app_versions'), [
      7,
      'com.example.app',
    ])
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK')
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE public.channels'), expect.anything())
  })
})
