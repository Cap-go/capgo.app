import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkWebhookPermission } from '../supabase/functions/_backend/public/webhooks/index.ts'

const ORG_ID = '22222222-2222-4222-8222-222222222222'

const mocks = vi.hoisted(() => ({
  orgRight: vi.fn(),
  policy: vi.fn(),
  checkPermission: vi.fn(),
  appScoped: false,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>(),
  getPgClient: async () => ({ query: async () => ({ rows: [{ has_app_scope: mocks.appScoped }] }) }),
  closeClient: async () => {},
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/rbac.ts')>(),
  checkPermission: (...args: unknown[]) => mocks.checkPermission(...args),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/supabase.ts')>(),
  apikeyHasOrgRight: (...args: unknown[]) => mocks.orgRight(...args),
  // The wrapper re-ran apikeyHasOrgRight; the webhook check must not need it any more.
  apikeyHasOrgRightWithPolicy: async () => {
    throw new Error('apikeyHasOrgRightWithPolicy repeats the org right check')
  },
  checkApikeyMeetsOrgPolicy: (...args: unknown[]) => mocks.policy(...args),
}))

function apikey(id: number) {
  return { id, key: `key-${id}`, rbac_id: `00000000-0000-4000-8000-00000000000${id}` } as any
}

function context(parentApikey?: unknown) {
  const values: Record<string, unknown> = { capgkey: 'key-1', parentApikey, requestId: 'req' }
  return { get: (key: string) => values[key], env: {} } as any
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.appScoped = false
  mocks.orgRight.mockResolvedValue(true)
  mocks.policy.mockResolvedValue({ valid: true })
  mocks.checkPermission.mockResolvedValue(true)
})

describe('checkWebhookPermission', () => {
  it('checks org read access once per key of the chain', async () => {
    await checkWebhookPermission(context(apikey(2)), ORG_ID, apikey(1))
    expect(mocks.orgRight).toHaveBeenCalledTimes(2)
    expect(mocks.policy).toHaveBeenCalledTimes(2)
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'org.update_settings', { orgId: ORG_ID })
  })

  it('rejects a key without org access before any policy check', async () => {
    mocks.orgRight.mockImplementation(async (_c: unknown, key: { id: number }) => key.id !== 2)
    await expect(checkWebhookPermission(context(apikey(2)), ORG_ID, apikey(1))).rejects.toThrow('You can\'t access this organization')
    expect(mocks.policy).not.toHaveBeenCalled()
  })

  it('keeps the org policy errors', async () => {
    mocks.policy.mockResolvedValue({ valid: false, error: 'org_requires_expiring_key' })
    await expect(checkWebhookPermission(context(), ORG_ID, apikey(1))).rejects.toThrow('requires API keys with an expiration date')

    mocks.policy.mockResolvedValue({ valid: false, error: 'invalid_org_id' })
    await expect(checkWebhookPermission(context(), ORG_ID, apikey(1))).rejects.toThrow('You can\'t access this organization')
  })

  it('still refuses app-scoped keys', async () => {
    mocks.appScoped = true
    await expect(checkWebhookPermission(context(), ORG_ID, apikey(1))).rejects.toThrow('App-scoped API keys cannot manage organization webhooks')
    expect(mocks.orgRight).not.toHaveBeenCalled()
  })
})
