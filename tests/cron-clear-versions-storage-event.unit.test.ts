import { beforeEach, describe, expect, it, vi } from 'vitest'

// A bundle whose size was unknown at upload is repaired by cron_clear_versions. Storage is billed
// in GB-hours from version_meta events, so the repair must record the bundle's upload event.

const pgQuery = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as any[], rowCount: 0 }))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/s3.ts', () => ({
  getPath: vi.fn(async () => 'orgs/org-1/apps/com.test.repair/1.0.0.zip'),
  s3: { getSize: vi.fn(async () => 2048) },
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: vi.fn(async () => ({ query: pgQuery })),
  closeClient: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/hono.ts')
  return {
    ...actual,
    middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => await next(),
  }
})

const { app } = await import('../supabase/functions/_backend/triggers/cron_clear_versions.ts')

const version = {
  id: 77,
  app_id: 'com.test.repair',
  name: '1.0.0',
  owner_org: 'org-1',
  user_id: 'user-1',
  r2_path: 'orgs/org-1/apps/com.test.repair/1.0.0.zip',
}

function repair() {
  return app.request('http://local/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version }),
  })
}

describe('cron_clear_versions storage event', () => {
  beforeEach(() => {
    pgQuery.mockReset()
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT checksum FROM public.app_versions'))
        return { rows: [{ checksum: 'abc' }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
  })

  it('records the repaired bundle upload event with its size', async () => {
    const response = await repair()
    expect(response.status).toBe(200)
    const event = pgQuery.mock.calls.find(([sql]) => sql.includes('upsert_version_meta'))
    expect(event?.[1]).toEqual(['com.test.repair', 77, 2048])
    // Recorded at the bundle's upload (its version creation), not the repair.
    expect(event?.[0]).toContain('p_timestamp => (SELECT app_versions.created_at FROM public.app_versions WHERE app_versions.id = $2::bigint)')
  })

  it('fails the job when the event cannot be recorded', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT checksum FROM public.app_versions'))
        return { rows: [{ checksum: 'abc' }], rowCount: 1 }
      if (sql.includes('upsert_version_meta'))
        throw new Error('connection reset')
      return { rows: [], rowCount: 0 }
    })
    const response = await repair()
    expect(response.status).toBeGreaterThanOrEqual(400)
    // The bundle is repaired, not deleted.
    expect(pgQuery.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM public.app_versions'))).toBe(false)
  })
})
