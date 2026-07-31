import { HTTPException } from 'hono/http-exception'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateOrCreateChannel = vi.fn()
const checkPermission = vi.fn()
const checkPermissionPg = vi.fn()
const assertCanPromoteChannelInTransaction = vi.fn()
const setChannelInTransaction = vi.fn()
const supabaseAdmin = vi.fn()
const isValidAppId = vi.fn()
const getPgClient = vi.fn()
const getDrizzleClient = vi.fn()
const closeClient = vi.fn()
const logPgError = vi.fn()
const transactionEvents: string[] = []
const dbClient = {
  query: vi.fn(),
  release: vi.fn(),
}
const pgClient = {
  connect: vi.fn(),
}
const drizzle = {}

vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  BRES: { status: 'ok' },
  simpleError: (error: string, message: string, details: Record<string, unknown> = {}) => {
    const issue = new Error(message)
    ;(issue as Error & { cause?: unknown }).cause = { error, ...details }
    throw issue
  },
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission,
  checkPermissionPg,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient,
  getDrizzleClient,
  getPgClient,
  logPgError,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin,
  updateOrCreateChannel,
}))

vi.mock('../supabase/functions/_backend/public/bundle/set_channel.ts', () => ({
  assertCanPromoteChannelInTransaction,
  setChannelInTransaction,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  isInternalVersionName: (version: string) => version === 'builtin' || version === 'unknown',
  isValidAppId,
}))

function buildAdminChain(body: {
  existingChannelId?: number | null
  existingChannelVersion?: number | null
  existingRolloutVersion?: number | null
  ownerOrg?: string
  versionId?: number
  versionError?: { message: string } | null
  eqCalls?: Array<[string, unknown]>
  fromCalls?: string[]
} = {}) {
  return {
    from(table: string) {
      body.fromCalls?.push(table)
      if (table === 'apps') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { owner_org: body.ownerOrg ?? 'org-test' }, error: null }),
            }),
          }),
        }
      }

      if (table === 'channels') {
        return {
          select: () => ({
            eq() {
              return this
            },
            maybeSingle: async () => ({
              data: body.existingChannelId == null
                ? null
                : {
                    id: body.existingChannelId,
                    version: body.existingChannelVersion ?? null,
                    rollout_version: body.existingRolloutVersion ?? null,
                  },
              error: null,
            }),
          }),
        }
      }

      if (table === 'app_versions') {
        return {
          select: () => ({
            eq(column: string, value: unknown) {
              body.eqCalls?.push([column, value])
              return this
            },
            single: async () => body.versionError ? { data: null, error: body.versionError } : { data: { id: body.versionId ?? 123 }, error: null },
          }),
        }
      }

      throw new Error(`Unexpected admin table: ${table}`)
    },
  }
}

function apiKey() {
  return { user_id: 'user-test', key: 'capg-key' } as any
}

function context() {
  return {
    get: vi.fn((key: string) => {
      if (key === 'auth')
        return { authType: 'apikey', userId: 'user-test', apikey: apiKey() }
      if (key === 'requestId')
        return 'channel-post-test'
      return undefined
    }),
    json: vi.fn().mockReturnValue({ ok: true }),
  } as any
}

function configureTransaction(versionId: number | null = 123) {
  dbClient.query.mockImplementation(async (statement: string) => {
    if (statement === 'BEGIN') {
      transactionEvents.push('begin')
      return { rowCount: null, rows: [] }
    }
    if (statement === 'COMMIT') {
      transactionEvents.push('commit')
      return { rowCount: null, rows: [] }
    }
    if (statement === 'ROLLBACK') {
      transactionEvents.push('rollback')
      return { rowCount: null, rows: [] }
    }
    if (statement.includes('set_config')) {
      transactionEvents.push('headers')
      return { rowCount: 1, rows: [] }
    }
    if (statement.includes('INSERT INTO public.channels')) {
      transactionEvents.push('insert')
      return { rowCount: 1, rows: [{ id: 77, public: false }] }
    }
    if (statement.includes('FROM public.app_versions')) {
      transactionEvents.push('version')
      return versionId === null
        ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [{ id: versionId }] }
    }
    throw new Error(`Unexpected transaction statement: ${statement}`)
  })
}

describe('public channel post', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transactionEvents.splice(0)
    checkPermission.mockResolvedValue(true)
    checkPermissionPg.mockImplementation(async (_context: unknown, permission: string) => {
      transactionEvents.push(`permission:${permission}`)
      return true
    })
    assertCanPromoteChannelInTransaction.mockImplementation(async () => {
      transactionEvents.push('promote')
    })
    setChannelInTransaction.mockImplementation(async () => {
      transactionEvents.push('set')
      return { channelName: 'preview', versionName: '1.0.0' }
    })
    isValidAppId.mockReturnValue(true)
    supabaseAdmin.mockImplementation(() => buildAdminChain())
    updateOrCreateChannel.mockResolvedValue({ data: { id: 99 }, error: null })
    getPgClient.mockReturnValue(pgClient)
    pgClient.connect.mockResolvedValue(dbClient)
    getDrizzleClient.mockReturnValue(drizzle)
    closeClient.mockResolvedValue(undefined)
    configureTransaction()
  })

  it('defaults legacy public mobile channel writes to electron false', async () => {
    const { post } = await import('../supabase/functions/_backend/public/channel/post.ts')
    const c = context()

    await post(c, {
      app_id: 'com.test.legacy-mobile',
      channel: 'ios-default',
      public: true,
      ios: true,
      android: false,
    }, apiKey())

    expect(updateOrCreateChannel).toHaveBeenCalledWith(
      c,
      expect.objectContaining({
        app_id: 'com.test.legacy-mobile',
        name: 'ios-default',
        public: true,
        ios: true,
        android: false,
        electron: false,
      }),
      null,
      true,
    )
    expect(c.json).toHaveBeenCalledWith({ status: 'ok' })
  })

  it('preserves explicit electron platform selection', async () => {
    const { post } = await import('../supabase/functions/_backend/public/channel/post.ts')
    const c = context()

    await post(c, {
      app_id: 'com.test.explicit-electron',
      channel: 'all-platforms',
      public: true,
      ios: true,
      android: true,
      electron: true,
    }, apiKey())

    expect(updateOrCreateChannel).toHaveBeenCalledWith(c, expect.objectContaining({ electron: true }), null, true)
  })

  it('keeps legacy all-platform public writes electron-compatible when both mobile flags are true', async () => {
    const { post } = await import('../supabase/functions/_backend/public/channel/post.ts')
    const c = context()

    await post(c, {
      app_id: 'com.test.legacy-all-platforms',
      channel: 'production',
      public: true,
      ios: true,
      android: true,
    }, apiKey())

    expect(updateOrCreateChannel).toHaveBeenCalledWith(c, expect.not.objectContaining({ electron: false }), null, true)
  })

  it('preserves the stable version for a settings-only update without channel.read or bundle lookup', async () => {
    const fromCalls: string[] = []
    supabaseAdmin.mockImplementation(() => buildAdminChain({
      existingChannelId: 42,
      existingChannelVersion: 123,
      fromCalls,
    }))
    const { post } = await import('../supabase/functions/_backend/public/channel/post.ts')
    const c = context()

    await post(c, {
      app_id: 'com.test.settings-only',
      channel: 'production',
      public: false,
    }, apiKey())

    expect(checkPermission).toHaveBeenCalledTimes(1)
    expect(checkPermission).toHaveBeenCalledWith(c, 'channel.update_settings', { appId: 'com.test.settings-only', channelId: 42 })
    expect(fromCalls).toEqual(['channels', 'apps'])
    expect(updateOrCreateChannel).toHaveBeenCalledWith(c, expect.objectContaining({ version: 123, public: false }), 42, true)
  })
  it('requires promote permission before explicit version lookup, even when the name is current', async () => {
    const fromCalls: string[] = []
    supabaseAdmin.mockImplementation(() => buildAdminChain({
      existingChannelId: 42,
      existingChannelVersion: 123,
      fromCalls,
    }))
    checkPermission
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const { post } = await import('../supabase/functions/_backend/public/channel/post.ts')

    await expect(post(context(), {
      app_id: 'com.test.same-version',
      channel: 'production',
      version: '1.0.0',
    }, apiKey())).rejects.toMatchObject({
      cause: expect.objectContaining({ error: 'cannot_access_app' }),
    })

    expect(checkPermission).toHaveBeenNthCalledWith(1, expect.anything(), 'channel.update_settings', { appId: 'com.test.same-version', channelId: 42 })
    expect(checkPermission).toHaveBeenNthCalledWith(2, expect.anything(), 'channel.promote_bundle', { appId: 'com.test.same-version', channelId: 42 })
    expect(fromCalls).toEqual(['channels', 'apps'])
    expect(updateOrCreateChannel).not.toHaveBeenCalled()
  })

  it('uses the admin version lookup after a scoped channel key proves settings and promote permissions', async () => {
    supabaseAdmin.mockImplementation(() => buildAdminChain({
      existingChannelId: 42,
      existingChannelVersion: 123,
      versionId: 456,
    }))
    const { post } = await import('../supabase/functions/_backend/public/channel/post.ts')
    const c = context()

    await post(c, {
      app_id: 'com.test.channel-admin-version',
      channel: 'production',
      version: '2.0.0',
    }, apiKey())

    expect(checkPermission).toHaveBeenNthCalledWith(1, c, 'channel.update_settings', { appId: 'com.test.channel-admin-version', channelId: 42 })
    expect(checkPermission).toHaveBeenNthCalledWith(2, c, 'channel.promote_bundle', { appId: 'com.test.channel-admin-version', channelId: 42 })
    expect(updateOrCreateChannel).toHaveBeenCalledWith(c, expect.objectContaining({ version: 456 }), 42, false)
  })

  it('writes a rollout promotion as the stable version when body.version is omitted', async () => {
    supabaseAdmin.mockImplementation(() => buildAdminChain({
      existingChannelId: 42,
      existingChannelVersion: 123,
      existingRolloutVersion: 456,
    }))
    const { post } = await import('../supabase/functions/_backend/public/channel/post.ts')
    const c = context()

    await post(c, {
      app_id: 'com.test.promote-rollout',
      channel: 'production',
      promoteToStable: true,
    }, apiKey())

    expect(checkPermission).toHaveBeenCalledWith(c, 'channel.promote_bundle', { appId: 'com.test.promote-rollout', channelId: 42 })
    expect(updateOrCreateChannel).toHaveBeenCalledWith(c, expect.objectContaining({ version: 456, rollout_version: null }), 42, false)
  })

  it('creates and promotes a new channel in one transaction after its scoped grant exists', async () => {
    const { post } = await import('../supabase/functions/_backend/public/channel/post.ts')
    const c = context()
    const key = apiKey()

    await post(c, {
      app_id: 'com.test.new-channel-version',
      channel: 'preview',
      version: '1.0.0',
    }, key)

    expect(updateOrCreateChannel).not.toHaveBeenCalled()
    expect(assertCanPromoteChannelInTransaction).toHaveBeenCalledWith(c, expect.objectContaining({
      app_id: 'com.test.new-channel-version',
      channel_id: 77,
    }), key, dbClient)
    expect(setChannelInTransaction).toHaveBeenCalledWith(c, {
      app_id: 'com.test.new-channel-version',
      channel_id: 77,
      version_id: 123,
    }, key, dbClient)
    expect(transactionEvents).toEqual([
      'begin',
      'headers',
      'permission:app.create_channel',
      'insert',
      'promote',
      'version',
      'set',
      'commit',
    ])
    expect(c.json).toHaveBeenCalledWith({ status: 'ok', id: 77, public: false })
  })

  it('rolls back the new channel when its post-insert scoped promotion permission is denied', async () => {
    const denied = new HTTPException(400, { message: 'You can\'t access this app' })
    assertCanPromoteChannelInTransaction.mockImplementation(async () => {
      transactionEvents.push('promote')
      throw denied
    })
    const { post } = await import('../supabase/functions/_backend/public/channel/post.ts')

    await expect(post(context(), {
      app_id: 'com.test.new-channel-permission-denied',
      channel: 'preview',
      version: '1.0.0',
    }, apiKey())).rejects.toBe(denied)

    expect(transactionEvents).toEqual([
      'begin',
      'headers',
      'permission:app.create_channel',
      'insert',
      'promote',
      'rollback',
    ])
    expect(setChannelInTransaction).not.toHaveBeenCalled()
  })

  it('rolls back the new channel when the requested bundle is missing', async () => {
    configureTransaction(null)
    const { post } = await import('../supabase/functions/_backend/public/channel/post.ts')

    await expect(post(context(), {
      app_id: 'com.test.new-channel-version-missing',
      channel: 'preview',
      version: '1.0.0',
    }, apiKey())).rejects.toThrow()

    expect(transactionEvents).toEqual([
      'begin',
      'headers',
      'permission:app.create_channel',
      'insert',
      'promote',
      'version',
      'rollback',
    ])
    expect(setChannelInTransaction).not.toHaveBeenCalled()
  })

  it('rolls back the new channel when bundle association fails', async () => {
    const associationError = new HTTPException(400, { message: 'Cannot associate bundle with the new channel' })
    setChannelInTransaction.mockImplementation(async () => {
      transactionEvents.push('set')
      throw associationError
    })
    const { post } = await import('../supabase/functions/_backend/public/channel/post.ts')

    await expect(post(context(), {
      app_id: 'com.test.new-channel-association-failure',
      channel: 'preview',
      version: '1.0.0',
    }, apiKey())).rejects.toBe(associationError)

    expect(transactionEvents).toEqual([
      'begin',
      'headers',
      'permission:app.create_channel',
      'insert',
      'promote',
      'version',
      'set',
      'rollback',
    ])
  })

  it('requires promote bundle permission to explicitly clear a channel version', async () => {
    supabaseAdmin.mockImplementation(() => buildAdminChain({ existingChannelId: 42, existingChannelVersion: 123 }))
    checkPermission
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const { post } = await import('../supabase/functions/_backend/public/channel/post.ts')

    await expect(post(context(), {
      app_id: 'com.test.clear-version',
      channel: 'production',
      version: null,
    }, apiKey())).rejects.toMatchObject({
      cause: expect.objectContaining({ error: 'cannot_access_app' }),
    })

    expect(updateOrCreateChannel).not.toHaveBeenCalled()
  })

  it('filters numeric rollout target ids to active bundles', async () => {
    const eqCalls: Array<[string, unknown]> = []
    supabaseAdmin.mockImplementation(() => buildAdminChain({
      existingChannelId: 42,
      existingChannelVersion: 123,
      versionId: 456,
      eqCalls,
    }))
    const { post } = await import('../supabase/functions/_backend/public/channel/post.ts')

    await post(context(), {
      app_id: 'com.test.rollout-id',
      channel: 'production',
      rolloutVersion: 456,
    }, apiKey())

    const rolloutIdCallIndex = eqCalls.findIndex(([column, value]) => column === 'id' && value === 456)
    expect(rolloutIdCallIndex).toBeGreaterThanOrEqual(0)
    expect(eqCalls.slice(rolloutIdCallIndex)).toContainEqual(['deleted', false])
    expect(checkPermission).toHaveBeenCalledWith(expect.anything(), 'channel.promote_bundle', { appId: 'com.test.rollout-id', channelId: 42 })
  })

  it('rejects rollout target changes without channel promote permission', async () => {
    supabaseAdmin.mockImplementation(() => buildAdminChain({ existingChannelId: 42, existingChannelVersion: 123 }))
    checkPermission
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const { post } = await import('../supabase/functions/_backend/public/channel/post.ts')

    await expect(post(context(), {
      app_id: 'com.test.rollout-auth',
      channel: 'production',
      rolloutVersion: '2.0.0',
    }, apiKey())).rejects.toMatchObject({
      cause: expect.objectContaining({ error: 'cannot_promote_bundle' }),
    })

    expect(updateOrCreateChannel).not.toHaveBeenCalled()
  })

  it('rejects rollout targets when a channel has no stable bundle', async () => {
    supabaseAdmin.mockImplementation(() => buildAdminChain({ existingChannelId: 42, existingChannelVersion: null }))
    const { post } = await import('../supabase/functions/_backend/public/channel/post.ts')

    await expect(post(context(), {
      app_id: 'com.test.rollout-no-stable',
      channel: 'new-rollout-channel',
      rolloutVersion: '2.0.0',
    }, apiKey())).rejects.toMatchObject({
      cause: expect.objectContaining({ error: 'missing_stable_version' }),
    })

    expect(updateOrCreateChannel).not.toHaveBeenCalled()
  })
})
