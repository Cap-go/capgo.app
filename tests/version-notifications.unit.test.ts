import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  closeClient: vi.fn(),
  getPgClient: vi.fn(),
  sendEventToTracking: vi.fn(async () => undefined),
  sendEmailToOrgMembers: vi.fn(async () => 1),
  sendNotifToOrgMembersOnce: vi.fn(async () => true),
  purgeOnPremCache: vi.fn(async () => undefined),
  pending: true,
  publicChannel: true,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: mocks.getPgClient,
  closeClient: mocks.closeClient,
  getDrizzleClient: vi.fn(() => ({})),
}))
vi.mock('../supabase/functions/_backend/utils/org_email_notifications.ts', () => ({
  sendEmailToOrgMembers: mocks.sendEmailToOrgMembers,
  sendNotifToOrgMembersOnce: mocks.sendNotifToOrgMembersOnce,
}))
vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({ sendEventToTracking: mocks.sendEventToTracking }))
vi.mock('../supabase/functions/_backend/utils/cloudflare_cache_purge.ts', () => ({ purgeOnPremCache: mocks.purgeOnPremCache }))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlog: vi.fn(), cloudlogErr: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      select() { return this },
      update() { return this },
      eq() { return this },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve({ error: null }).then(resolve) },
      maybeSingle: async () => ({ data: { need_onboarding: mocks.pending }, error: null }),
      single: async () => ({ data: table === 'channels' ? { public: mocks.publicChannel } : { name: '1.0.0', owner_org: 'org-id' }, error: null }),
    }),
  }),
}))

const { app: versionApp } = await import('../supabase/functions/_backend/triggers/on_version_create.ts')
const { app: deployApp } = await import('../supabase/functions/_backend/triggers/on_deploy_history_create.ts')

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('API_SECRET', 'notification-test-secret')
  mocks.pending = true
  mocks.publicChannel = true
  mocks.getPgClient.mockResolvedValue({ query: mocks.query })
  mocks.query.mockResolvedValue({ rows: [{ skip_notifications: false }] })
})
afterEach(() => vi.unstubAllEnvs())

async function trigger(kind: 'version' | 'deploy') {
  const record = { id: kind === 'version' ? 123 : 456, version_id: 123, app_id: 'com.example.notifications', owner_org: 'org-id', name: '1.0.0', channel_id: 12 }
  return (kind === 'version' ? versionApp : deployApp).request('http://local/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', apisecret: 'notification-test-secret' },
    body: JSON.stringify({ type: 'INSERT', table: kind === 'version' ? 'app_versions' : 'deploy_history', record }),
  })
}

describe.each(['version', 'deploy'] as const)('%s notifications', (kind) => {
  it('emits genuine activity while app onboarding is pending', async () => {
    const response = await trigger(kind)
    expect(response.status, await response.text()).toBe(200)
    expect(mocks.sendEventToTracking).toHaveBeenCalledOnce()
    const notification = kind === 'version' ? mocks.sendEmailToOrgMembers : mocks.sendNotifToOrgMembersOnce
    expect(notification).toHaveBeenCalledWith(
      expect.anything(),
      kind === 'version' ? 'bundle:created' : 'bundle:deployed',
      kind === 'version' ? 'bundle_created' : 'bundle_deployed',
      expect.objectContaining({ app_id: 'com.example.notifications' }),
      'org-id',
      ...(kind === 'version' ? [expect.anything()] : ['bundle:deployed:123:12', expect.anything()]),
    )
  })

  it('still emits genuine activity after onboarding completes', async () => {
    mocks.pending = false
    expect((await trigger(kind)).status).toBe(200)
    expect(mocks.sendEventToTracking).toHaveBeenCalledOnce()
  })

  it('suppresses a demo even after the onboarding flag clears', async () => {
    mocks.pending = false
    mocks.query.mockResolvedValue({ rows: [{ skip_notifications: true }] })
    expect((await trigger(kind)).status).toBe(200)
    expect(mocks.sendEventToTracking).not.toHaveBeenCalled()
    expect(mocks.sendEmailToOrgMembers).not.toHaveBeenCalled()
    expect(mocks.sendNotifToOrgMembersOnce).not.toHaveBeenCalled()
  })

  it('suppresses stale events for versions already removed by demo cleanup', async () => {
    mocks.query.mockResolvedValue({ rows: [] })
    expect((await trigger(kind)).status).toBe(200)
    expect(mocks.sendEventToTracking).not.toHaveBeenCalled()
  })

  it('fails the request on a lookup error so the queue can retry', async () => {
    mocks.query.mockRejectedValue(new Error('temporary database failure'))
    const response = await trigger(kind)
    expect(response.status).toBe(500)
    expect(mocks.sendEventToTracking).not.toHaveBeenCalled()
    expect(mocks.closeClient).toHaveBeenCalledOnce()
  })
})

it('keeps deployment notifications restricted to public channels', async () => {
  mocks.publicChannel = false
  expect((await trigger('deploy')).status).toBe(200)
  expect(mocks.sendEventToTracking).not.toHaveBeenCalled()
})
