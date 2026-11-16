import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  user: { id: 'user-1' } as { id: string } | null,
}))

vi.mock('~/services/console', () => ({ useConsole: () => ({ rpc: mocks.rpc }) }))
vi.mock('~/stores/main', () => ({ useMainStore: () => ({ user: mocks.user }) }))

const {
  checkPermissions,
  checkPermissionsBatch,
  invalidatePermissionCache,
  MAX_PERMISSION_CHECKS_PER_RPC,
  userHasPermission,
  userHasPermissionsBatch,
} = await import('../src/services/permissions')

interface BatchEntry {
  key: string
  permission_key: string
  org_id: string | null
  app_id: string | null
  channel_id: number | null
  user_id?: string
}

// Grants the listed "permission@channelId|appId|orgId" combinations.
function grantBatch(isAllowed: (entry: BatchEntry) => boolean) {
  mocks.rpc.mockImplementation(async (name: string, args: { p_checks: BatchEntry[] }) => {
    if (name !== 'rbac_check_permissions')
      throw new Error(`unexpected rpc ${name}`)
    return {
      data: args.p_checks.map((entry, idx) => ({ idx, key: entry.key, allowed: isAllowed(entry) })),
      error: null,
    }
  })
}

function batchCalls() {
  return mocks.rpc.mock.calls.filter(([name]) => name === 'rbac_check_permissions')
}

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.user = { id: 'user-1' }
  invalidatePermissionCache()
})

describe('console permission batching', () => {
  it('sends every concurrent check in one RPC and keeps per-row results', async () => {
    grantBatch(entry => entry.permission_key === 'channel.read' || entry.channel_id === 2)

    const rows = [1, 2, 3]
    const results = await Promise.all(rows.flatMap(channelId => [
      checkPermissions('channel.read', { channelId }),
      checkPermissions('channel.promote_bundle', { channelId }),
      checkPermissions('channel.delete', { appId: 'com.test.app', channelId }),
    ]))

    expect(batchCalls()).toHaveLength(1)
    expect(batchCalls()[0][1].p_checks).toHaveLength(9)
    expect(results).toEqual([
      true,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
    ])
  })

  it('maps scope fields and omits user_id for the signed-in user', async () => {
    grantBatch(() => true)
    await checkPermissions('app.read', { orgId: 'org-1', appId: 'com.test.app' })
    expect(batchCalls()[0][1].p_checks).toEqual([{
      key: '0',
      permission_key: 'app.read',
      org_id: 'org-1',
      app_id: 'com.test.app',
      channel_id: null,
    }])
  })

  it('deduplicates identical checks and serves repeats from the cache', async () => {
    grantBatch(() => true)
    await Promise.all([
      checkPermissions('app.read', { appId: 'a' }),
      checkPermissions('app.read', { appId: 'a' }),
    ])
    expect(batchCalls()).toHaveLength(1)
    expect(batchCalls()[0][1].p_checks).toHaveLength(1)

    await checkPermissions('app.read', { appId: 'a' })
    expect(batchCalls()).toHaveLength(1)
  })

  it('settles every caller when the cache is invalidated before the flush', async () => {
    grantBatch(() => true)
    const first = checkPermissions('app.read', { appId: 'a' })
    invalidatePermissionCache()
    const second = checkPermissions('app.read', { appId: 'a' })
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(batchCalls()).toHaveLength(1)
    expect(batchCalls()[0][1].p_checks).toHaveLength(1)
  })

  it('re-checks after invalidatePermissionCache and after the user changes', async () => {
    grantBatch(() => true)
    await checkPermissions('app.read', { appId: 'a' })
    invalidatePermissionCache()
    await checkPermissions('app.read', { appId: 'a' })
    expect(batchCalls()).toHaveLength(2)

    mocks.user = { id: 'user-2' }
    await checkPermissions('app.read', { appId: 'a' })
    expect(batchCalls()).toHaveLength(3)
  })

  it('denies without a signed-in user and does not call the API', async () => {
    mocks.user = null
    expect(await checkPermissions('app.read', { appId: 'a' })).toBe(false)
    expect(await checkPermissionsBatch([{ permissions: 'app.read', scope: { appId: 'a' } }])).toEqual([false])
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('keeps ALL / ANY semantics for multi-permission requests', async () => {
    grantBatch(entry => entry.permission_key === 'app.read')
    expect(await checkPermissionsBatch([
      { permissions: ['app.read', 'app.delete'], scope: { appId: 'a' } },
      { permissions: ['app.read', 'app.delete'], scope: { appId: 'a' }, mode: 'any' },
      { permissions: [], scope: { appId: 'a' } },
    ])).toEqual([false, true, false])
    expect(batchCalls()).toHaveLength(1)
  })

  it('splits large batches into RPCs of at most MAX_PERMISSION_CHECKS_PER_RPC entries', async () => {
    grantBatch(entry => (entry.channel_id ?? 0) % 2 === 0)
    const count = MAX_PERMISSION_CHECKS_PER_RPC * 2 + 5
    const results = await checkPermissionsBatch(Array.from({ length: count }, (_, channelId) => ({
      permissions: 'channel.read' as const,
      scope: { channelId },
    })))
    expect(batchCalls().map(([, args]) => args.p_checks.length)).toEqual([
      MAX_PERMISSION_CHECKS_PER_RPC,
      MAX_PERMISSION_CHECKS_PER_RPC,
      5,
    ])
    expect(results.filter(Boolean)).toHaveLength(Math.ceil(count / 2))
  })

  it('falls back to single checks when the batch RPC fails, without caching errors', async () => {
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'rbac_check_permissions')
        return { data: null, error: { message: 'not allowed' } }
      if (name === 'rbac_check_permission')
        return args.p_app_id === 'b' ? { data: null, error: { message: 'boom' } } : { data: true, error: null }
      throw new Error(`unexpected rpc ${name}`)
    })

    expect(await checkPermissionsBatch([
      { permissions: 'app.read', scope: { appId: 'a' } },
      { permissions: 'app.read', scope: { appId: 'b' } },
    ])).toEqual([true, false])
    expect(mocks.rpc).toHaveBeenCalledWith('rbac_check_permission', {
      p_permission_key: 'app.read',
      p_org_id: undefined,
      p_app_id: 'a',
      p_channel_id: undefined,
    })

    mocks.rpc.mockClear()
    await checkPermissionsBatch([
      { permissions: 'app.read', scope: { appId: 'a' } },
      { permissions: 'app.read', scope: { appId: 'b' } },
    ])
    // The successful result is cached; the errored one is retried.
    expect(batchCalls()).toHaveLength(1)
    expect(batchCalls()[0][1].p_checks).toHaveLength(1)
    expect(batchCalls()[0][1].p_checks[0]).toMatchObject({ app_id: 'b' })
  })
})

describe('other-member permission batching', () => {
  it('sends user_id and combines member permissions with ANY by default', async () => {
    grantBatch(entry => entry.user_id === 'member-1' && entry.permission_key === 'org.update_user_roles')

    const results = await userHasPermissionsBatch([
      { permissions: ['org.invite_user', 'org.update_user_roles'], userId: 'member-1', scope: { orgId: 'org-1' } },
      { permissions: ['org.invite_user', 'org.update_user_roles'], userId: 'member-2', scope: { orgId: 'org-1' } },
    ])

    expect(results).toEqual([true, false])
    expect(batchCalls()).toHaveLength(1)
    expect(batchCalls()[0][1].p_checks).toHaveLength(4)
    expect(batchCalls()[0][1].p_checks[0]).toMatchObject({ user_id: 'member-1', org_id: 'org-1' })
  })

  it('keeps the self cache separate from other members', async () => {
    grantBatch(entry => !entry.user_id)
    expect(await checkPermissions('org.read', { orgId: 'org-1' })).toBe(true)
    expect(await userHasPermission('org.read', 'member-1', { orgId: 'org-1' })).toBe(false)
    expect(batchCalls()).toHaveLength(2)
  })

  it('denies org-less or user-less member checks without calling the API', async () => {
    expect(await userHasPermission('org.read', 'member-1', {})).toBe(false)
    expect(await userHasPermission('org.read', '', { orgId: 'org-1' })).toBe(false)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
