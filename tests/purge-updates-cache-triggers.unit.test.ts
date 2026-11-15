import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  purgeUpdatesCache: vi.fn(async () => ({ nudged: true, purgedApps: ['com.mock.app'], purged: true, enqueued: true })),
  purgeOnPremCache: vi.fn(async () => undefined),
  pgQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  getPgClient: vi.fn(async () => ({ query: vi.fn() })),
  closeClient: vi.fn(),
  getDrizzleClient: vi.fn(() => ({})),
  shouldSkipVersionNotifications: vi.fn(async () => true),
  sendEventToTracking: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/purgeUpdatesCache.ts', () => ({
  purgeUpdatesCache: mocks.purgeUpdatesCache,
}))

vi.mock('../supabase/functions/_backend/utils/cloudflare_cache_purge.ts', () => ({
  purgeOnPremCache: mocks.purgeOnPremCache,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: mocks.getPgClient,
  closeClient: mocks.closeClient,
  getDrizzleClient: mocks.getDrizzleClient,
}))

vi.mock('../supabase/functions/_backend/utils/version_notifications.ts', () => ({
  shouldSkipVersionNotifications: mocks.shouldSkipVersionNotifications,
}))

vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: mocks.sendEventToTracking,
}))

vi.mock('../supabase/functions/_backend/utils/org_email_notifications.ts', () => ({
  sendEmailToOrgMembers: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/manifest_cleanup.ts', () => ({
  deleteVersionManifestBatch: vi.fn(async () => {}),
}))

vi.mock('../supabase/functions/_backend/utils/s3.ts', () => ({
  getPath: vi.fn(),
  s3: { moveObjectToTrash: vi.fn(async () => true), deleteObject: vi.fn() },
}))

vi.mock('../supabase/functions/_backend/files/file_read_cache.ts', () => ({
  purgeFileReadCache: vi.fn(async () => {}),
  isVersionDeleted: (row: { deleted?: boolean | null, deleted_at?: string | null }) =>
    row?.deleted === true || row?.deleted_at != null,
}))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  queryJsonOne: vi.fn(async () => ({ size: 0 })),
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  BRES: { status: 'ok' },
  middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => next(),
  simpleError: (code: string, message: string) => new Error(`${code}: ${message}`),
  triggerValidator: () => async (c: any, next: () => Promise<void>) => {
    const body = await c.req.json()
    c.set('webhookBody', body.record)
    if (body.old_record)
      c.set('oldRecord', body.old_record)
    await next()
  },
}))

describe('purgeUpdatesCache on change paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('API_SECRET', 'purge-trigger-secret')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    mocks.getPgClient.mockResolvedValue({ query: mocks.pgQuery })
    mocks.pgQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  afterEach(() => vi.unstubAllEnvs())

  it('on_channel_update calls purgeUpdatesCache for the channel app', async () => {
    const { app } = await import('../supabase/functions/_backend/triggers/on_channel_update.ts')
    const response = await app.request('http://local/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', apisecret: 'purge-trigger-secret' },
      body: JSON.stringify({
        type: 'UPDATE',
        table: 'channels',
        record: { id: 1, app_id: 'com.example.channel', public: false },
        old_record: { id: 1, app_id: 'com.example.channel', public: false },
      }),
    })
    expect(response.status).toBe(200)
    expect(mocks.purgeUpdatesCache).toHaveBeenCalledWith(expect.anything(), 'com.example.channel')
  })

  it('on_version_create calls purgeUpdatesCache for the bundle app', async () => {
    mocks.pgQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0] ?? '')
      if (sql.startsWith('UPDATE public.apps'))
        return { rowCount: 1, rows: [] }
      return { rows: [], rowCount: 0 }
    })
    const { app } = await import('../supabase/functions/_backend/triggers/on_version_create.ts')
    const response = await app.request('http://local/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', apisecret: 'purge-trigger-secret' },
      body: JSON.stringify({
        type: 'INSERT',
        table: 'app_versions',
        record: { id: 10, app_id: 'com.example.bundle', owner_org: 'org', name: '1.0.0' },
      }),
    })
    expect(response.status).toBe(200)
    expect(mocks.purgeUpdatesCache).toHaveBeenCalledWith(expect.anything(), 'com.example.bundle')
  })

  it('on_version_update calls purgeUpdatesCache when the bundle payload is empty', async () => {
    const { app } = await import('../supabase/functions/_backend/triggers/on_version_update.ts')
    const response = await app.request('http://local/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', apisecret: 'purge-trigger-secret' },
      body: JSON.stringify({
        type: 'UPDATE',
        table: 'app_versions',
        record: {
          id: 3,
          app_id: 'com.example.version',
          owner_org: 'org',
          name: '2.0.0',
          deleted: false,
          deleted_at: null,
          r2_path: null,
          manifest: null,
        },
        old_record: {
          id: 3,
          app_id: 'com.example.version',
          deleted: false,
          deleted_at: null,
        },
      }),
    })
    expect(response.status).toBe(200)
    expect(mocks.purgeUpdatesCache).toHaveBeenCalledWith(expect.anything(), 'com.example.version')
  })

  it('on_version_update deleteIt calls purgeUpdatesCache for the bundle app', async () => {
    mocks.pgQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0] ?? '')
      if (sql.includes('SELECT size FROM public.app_versions_meta'))
        return { rows: [{ size: 0 }] }
      if (sql.startsWith('UPDATE public.channels'))
        return { rowCount: 0, rows: [] }
      return { rows: [], rowCount: 0 }
    })
    const { app } = await import('../supabase/functions/_backend/triggers/on_version_update.ts')
    const response = await app.request('http://local/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', apisecret: 'purge-trigger-secret' },
      body: JSON.stringify({
        type: 'UPDATE',
        table: 'app_versions',
        record: {
          id: 4,
          app_id: 'com.example.deleted',
          owner_org: 'org',
          name: '3.0.0',
          deleted: true,
          deleted_at: '2026-01-01T00:00:00.000Z',
          r2_path: null,
          manifest: [],
          manifest_count: 0,
        },
        old_record: {
          id: 4,
          app_id: 'com.example.deleted',
          deleted: false,
          deleted_at: null,
        },
      }),
    })
    expect(response.status).toBe(200)
    expect(mocks.purgeUpdatesCache).toHaveBeenCalledWith(expect.anything(), 'com.example.deleted')
  })
})