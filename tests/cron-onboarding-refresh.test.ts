import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshAppOnboardingBatch } from '../supabase/functions/_backend/utils/app_onboarding_refresh.ts'
import { getDrizzleClient } from '../supabase/functions/_backend/utils/pg.ts'
import { getPostgresClient } from './test-utils.ts'

const mocks = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/cloudflare.ts', async original => ({ ...await original<typeof import('../supabase/functions/_backend/utils/cloudflare.ts')>(), runQueryToCFA: mocks.run }))
const context = { env: { VERSION_USAGE: {}, DEVICE_INFO: {} }, get: () => 'fixture-request' } as any
const now = new Date('2026-09-17T12:00:00Z')
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CF_ANALYTICS_TOKEN', 'test-only')
  vi.stubEnv('CF_ACCOUNT_ANALYTICS_ID', 'test-account')
})
afterEach(() => vi.unstubAllEnvs())
afterAll(async () => (await getPostgresClient()).end())

async function fixture(client: any, count = 1) {
  const orgId = randomUUID()
  const owner = (await client.query('SELECT id FROM public.users WHERE email = \'test@capgo.app\'')).rows[0].id
  await client.query('INSERT INTO public.orgs(id, created_by, name, management_email) VALUES ($1,$2,\'Refresh fixture\',\'onboarding-refresh@example.com\')', [orgId, owner])
  const ids = Array.from({ length: count }, (_, i) => `000.onboarding.refresh.${orgId}.${String(i).padStart(4, '0')}`)
  await client.query('INSERT INTO public.apps(app_id, owner_org, name, icon_url, created_at, need_onboarding) SELECT app_id, $1, \'Refresh fixture\', \'\', \'2026-08-01T00:00:00Z\'::timestamptz, false FROM unnest($2::varchar[]) ids(app_id)', [orgId, ids])
  return { orgId, ids }
}

describe('backend onboarding refresh PostgreSQL and telemetry integration', () => {
  it('atomically enqueues 20-app messages, deduplicates pending work and replaces expired leases', async () => {
    const client = await (await getPostgresClient()).connect()
    try {
      await client.query('BEGIN')
      const { ids } = await fixture(client, 43)
      expect((await client.query('SELECT public.enqueue_app_onboarding_refreshes(43) AS count')).rows[0].count).toBe(43)
      const messages = (await client.query('SELECT message->\'payload\' AS payload FROM pgmq.q_cron_onboarding_refresh_apps WHERE message->\'payload\'->\'appIds\' ? $1 ORDER BY msg_id', [ids[0]])).rows
      expect(messages).toHaveLength(1)
      expect(messages[0].payload.appIds).toHaveLength(20)
      const before = (await client.query('SELECT batch_token FROM public.app_onboarding_refresh_jobs WHERE app_id=$1', [ids[0]])).rows[0].batch_token
      await client.query('SELECT public.enqueue_app_onboarding_refreshes(43)')
      expect((await client.query('SELECT COUNT(*)::int AS count FROM pgmq.q_cron_onboarding_refresh_apps WHERE message->\'payload\'->\'appIds\' ? $1', [ids[0]])).rows[0].count).toBe(1)
      await client.query('UPDATE public.app_onboarding_refresh_jobs SET enqueued_at=now()-interval \'31 minutes\' WHERE app_id=ANY($1::varchar[])', [ids])
      await client.query('SELECT public.enqueue_app_onboarding_refreshes(43)')
      const after = (await client.query('SELECT batch_token FROM public.app_onboarding_refresh_jobs WHERE app_id=$1', [ids[0]])).rows[0].batch_token
      expect(after).not.toBe(before)
    }
    finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
  it('caps the producer at 3000 apps even when callers request a larger sweep', async () => {
    const client = await (await getPostgresClient()).connect()
    try {
      await client.query('BEGIN')
      const { ids } = await fixture(client, 3101)
      expect((await client.query('SELECT public.enqueue_app_onboarding_refreshes(999999) AS count')).rows[0].count).toBe(3000)
      expect((await client.query('SELECT COUNT(*)::int AS count FROM public.app_onboarding_refresh_jobs WHERE app_id=ANY($1::varchar[])', [ids])).rows[0].count).toBe(3000)
      expect((await client.query('SELECT max(jsonb_array_length(message->\'payload\'->\'appIds\')) AS largest FROM pgmq.q_cron_onboarding_refresh_apps')).rows[0].largest).toBe(20)
    }
    finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
  it('keeps a long legacy app ID from blocking the producer', async () => {
    const client = await (await getPostgresClient()).connect()
    try {
      await client.query('BEGIN')
      const { orgId } = await fixture(client)
      const appId = `000.${'a'.repeat(252)}`
      await client.query('INSERT INTO public.apps(app_id,owner_org,name,icon_url,created_at,need_onboarding) VALUES ($1,$2,\'Long ID fixture\',\'\',NULL,false)', [appId, orgId])
      await client.query('SELECT public.enqueue_app_onboarding_refreshes(3000)')
      const messages = (await client.query('SELECT message->\'payload\' AS payload FROM pgmq.q_cron_onboarding_refresh_apps WHERE message->\'payload\'->\'appIds\' ? $1', [appId])).rows
      expect(messages).toHaveLength(1)
      expect(messages[0].payload.appIds).toEqual([appId])
      expect((await client.query('SELECT batch_token FROM public.app_onboarding_refresh_jobs WHERE app_id=$1', [appId])).rows).toHaveLength(1)
    }
    finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
  it('uses indexed producer ordering and denies caller access to producer and operational leases', async () => {
    const client = await (await getPostgresClient()).connect()
    try {
      const acl = (await client.query('SELECT has_function_privilege(\'anon\',\'public.enqueue_app_onboarding_refreshes(integer)\',\'EXECUTE\') AS anon, has_function_privilege(\'authenticated\',\'public.enqueue_app_onboarding_refreshes(integer)\',\'EXECUTE\') AS authenticated, has_function_privilege(\'service_role\',\'public.enqueue_app_onboarding_refreshes(integer)\',\'EXECUTE\') AS service_role')).rows[0]
      expect(acl).toEqual({ anon: false, authenticated: false, service_role: true })
      const def = (await client.query('SELECT pg_get_functiondef(\'public.enqueue_app_onboarding_refreshes(integer)\'::regprocedure) AS def')).rows[0].def
      expect(def).toContain('SET search_path TO \'\'')
      expect(def).toContain('SKIP LOCKED')
      const task = (await client.query('SELECT task_type, target, minute_interval, hour_interval FROM public.cron_tasks WHERE name=\'refresh_app_onboarding_progress\'')).rows[0]
      expect(task).toMatchObject({ task_type: 'queue', target: 'cron_onboarding_refresh', minute_interval: 10, hour_interval: null })
      expect((await client.query("SELECT to_regprocedure('public.refresh_app_onboarding_progress(integer)') AS old_batch")).rows[0].old_batch).toBeNull()
      expect((await client.query("SELECT to_regprocedure('public.refresh_one_app_onboarding_progress(character varying)') AS single_app")).rows[0].single_app).not.toBeNull()
      const dispatcher = (await client.query('SELECT pg_get_functiondef(\'public.process_function_queue(text,integer)\'::regprocedure) AS def')).rows[0].def
      expect(dispatcher).toContain('calls_needed := 1')
      expect(dispatcher).toContain('\'wait_for_completion\', onboarding_queue')
      expect(dispatcher).toContain('60000')
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE authenticated')
      await expect(client.query('SELECT * FROM public.app_onboarding_refresh_jobs')).rejects.toMatchObject({ code: '42501' })
    }
    finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
  it('commits Cloudflare timestamps while preserving concurrent setup, historic success and unrelated features', async () => {
    const pool = await getPostgresClient()
    const client = await pool.connect()
    const { orgId, ids } = await fixture(client)
    const appId = ids[0]
    const token = randomUUID()
    const setup = { todo_list_version: 2, outcome: 'in_progress', steps: { add_code: { status: 'done', at: '2026-09-01' } } }
    let released = false
    try {
      await client.query('UPDATE public.apps SET onboarding=$2::jsonb WHERE app_id=$1', [appId, JSON.stringify({ setup, features: { custom: { succeeded_at: '2026-08-02T00:00:00Z' }, cli_install: { succeeded_at: '2026-08-03T00:00:00Z' } } })])
      await client.query('INSERT INTO public.app_onboarding_refresh_jobs(app_id,batch_token) VALUES ($1,$2)', [appId, token])
      mocks.run.mockImplementation(async (_c, query: string) => {
        if (query.includes('FROM version_usage')) {
          // Simulate a CLI report arriving after initial app lookup and before
          // the worker's write, without modifying any shared seed app.
          await pool.query('UPDATE public.apps SET onboarding=jsonb_set(onboarding,\'{setup,steps,add_updater}\', \'{"status":"done"}\'::jsonb) WHERE app_id=$1', [appId])
          return [{ app_id: appId, first_at: '2026-09-10T13:14:15Z', last_at: '2026-09-16T20:00:00Z' }]
        }
        return [{ app_id: appId, stage: 'store_live', first_at: '2026-09-09T10:00:00Z', last_at: '2026-09-16T21:00:00Z' }]
      })
      client.release()
      released = true
      expect(await refreshAppOnboardingBatch(context, getDrizzleClient(pool), { appIds: ids, batchToken: token }, now)).toBe(1)
      const row = (await pool.query('SELECT onboarding FROM public.apps WHERE app_id=$1', [appId])).rows[0].onboarding
      expect(row.setup.steps).toMatchObject({ add_code: { status: 'done' }, add_updater: { status: 'done' } })
      expect(row.features.custom.succeeded_at).toBe('2026-08-02T00:00:00Z')
      expect(row.features.cli_install.succeeded_at).toBe('2026-08-03T00:00:00.000Z')
      expect(row.features.ota).toMatchObject({ succeeded_at: '2026-09-10T13:14:15.000Z', last_used_at: '2026-09-16T20:00:00.000Z', stage: 'store_live' })
      expect(row.refreshed_at).toBe(now.toISOString())
      expect((await pool.query('SELECT * FROM public.app_onboarding_refresh_jobs WHERE app_id=$1', [appId])).rows).toHaveLength(0)
      expect(await refreshAppOnboardingBatch(context, getDrizzleClient(pool), { appIds: ids, batchToken: token }, now)).toBe(0)
    }
    finally {
      // release() above lets a max=1 shared pool service the worker.
      if (!released)
        client.release()
      await pool.query('DELETE FROM public.apps WHERE app_id=ANY($1::varchar[])', [ids])
      await pool.query('DELETE FROM public.orgs WHERE id=$1', [orgId])
    }
  })
  it('refreshes a full batch with bundle and builder milestones, retaining confirmed success after 30 days', async () => {
    const pool = await getPostgresClient()
    const client = await pool.connect()
    const { orgId, ids } = await fixture(client, 20)
    const token = randomUUID()
    const owner = (await client.query('SELECT created_by FROM public.orgs WHERE id=$1', [orgId])).rows[0].created_by
    await client.query('INSERT INTO public.app_onboarding_refresh_jobs(app_id,batch_token) SELECT id,$2 FROM unnest($1::varchar[]) ids(id)', [ids, token])
    await client.query('INSERT INTO public.app_versions(app_id,owner_org,name,created_at) SELECT id,$2,\'first-bundle\',\'2026-08-02T00:00:00Z\'::timestamptz FROM unnest($1::varchar[]) ids(id)', [ids, orgId])
    await client.query('INSERT INTO public.build_requests(app_id,owner_org,requested_by,platform,status,upload_session_key,upload_path,upload_url,upload_expires_at,created_at,completed_at) SELECT id,$2,$3,\'android\',\'succeeded\',\'test-only\',\'fixture\',\'https://example.com\',now(),\'2026-08-03T00:00:00Z\'::timestamptz,\'2026-08-04T00:00:00Z\'::timestamptz FROM unnest($1::varchar[]) ids(id)', [ids, orgId, owner])
    // Match MIN/MAX semantics even when an old bundle has no timestamp.
    await client.query('INSERT INTO public.app_versions(app_id,owner_org,name,created_at) VALUES ($1,$2,\'latest-bundle\',\'2026-09-17T00:00:00Z\'::timestamptz),($1,$2,\'undated-bundle\',NULL)', [ids[0], orgId])
    client.release()
    try {
      mocks.run.mockImplementation(async (_c, query: string) => ids.map(app_id => ({ app_id, first_at: '2026-08-05T12:00:00Z', last_at: '2026-09-16T12:00:00Z', ...(query.includes('FROM device_info') ? { stage: 'native_unknown' } : {}) })))
      expect(await refreshAppOnboardingBatch(context, getDrizzleClient(pool), { appIds: ids, batchToken: token }, now)).toBe(20)
      const rows = (await pool.query('SELECT app_id, onboarding FROM public.apps WHERE app_id=ANY($1::varchar[])', [ids])).rows
      for (const row of rows) {
        expect(row.onboarding.features.cli_install).toMatchObject({ started_at: '2026-09-16T12:00:00.000Z', succeeded_at: '2026-09-16T12:00:00.000Z', last_used_at: '2026-09-16T12:00:00.000Z' })
        expect(row.onboarding.features.cli_install.retained_30d_at).toBeUndefined()
        expect(row.onboarding.features.ota).toMatchObject({ started_at: '2026-08-02T00:00:00.000Z', succeeded_at: '2026-08-05T12:00:00.000Z', retained_30d_at: row.app_id === ids[0] ? '2026-09-17T00:00:00.000Z' : '2026-09-16T12:00:00.000Z' })
        expect(row.onboarding.features.builder).toMatchObject({ started_at: '2026-08-03T00:00:00.000Z', succeeded_at: '2026-08-04T00:00:00.000Z' })
      }
    }
    finally {
      await pool.query('DELETE FROM public.build_requests WHERE app_id=ANY($1::varchar[])', [ids])
      await pool.query('DELETE FROM public.app_versions WHERE app_id=ANY($1::varchar[])', [ids])
      await pool.query('DELETE FROM public.apps WHERE app_id=ANY($1::varchar[])', [ids])
      await pool.query('DELETE FROM public.orgs WHERE id=$1', [orgId])
    }
  })
  it('rolls back both checkpoint writes and lease deletion if the database transaction fails', async () => {
    const pool = await getPostgresClient()
    const client = await pool.connect()
    const { orgId, ids } = await fixture(client)
    const token = randomUUID()
    const before = (await client.query('SELECT onboarding FROM public.apps WHERE app_id=$1', [ids[0]])).rows[0].onboarding
    await client.query('INSERT INTO public.app_onboarding_refresh_jobs(app_id,batch_token) VALUES ($1,$2)', [ids[0], token])
    client.release()
    try {
      mocks.run.mockResolvedValue([])
      const database = getDrizzleClient(pool)
      const failingDatabase: Pick<typeof database, 'execute' | 'transaction'> = {
        execute: database.execute.bind(database),
        transaction: (operation, config) => database.transaction(async (tx) => {
          const result = await operation(tx)
          // Fail after the batch write but before Drizzle commits, proving the
          // wrapper rolls back both onboarding updates and lease deletion.
          await tx.execute(sql`SELECT 1/0`)
          return result
        }, config),
      }
      await expect(refreshAppOnboardingBatch(context, failingDatabase, { appIds: ids, batchToken: token }, now)).rejects.toMatchObject({ cause: { code: '22012' } })
      expect((await pool.query('SELECT onboarding FROM public.apps WHERE app_id=$1', [ids[0]])).rows[0].onboarding).toEqual(before)
      expect((await pool.query('SELECT batch_token FROM public.app_onboarding_refresh_jobs WHERE app_id=$1', [ids[0]])).rows[0].batch_token).toBe(token)
    }
    finally {
      await pool.query('DELETE FROM public.apps WHERE app_id=ANY($1::varchar[])', [ids])
      await pool.query('DELETE FROM public.orgs WHERE id=$1', [orgId])
    }
  })
  it('leaves checkpoints and leases unchanged on Cloudflare failure, and ignores replaced message tokens', async () => {
    const pool = await getPostgresClient()
    const client = await pool.connect()
    const { orgId, ids } = await fixture(client)
    const token = randomUUID()
    const before = (await client.query('SELECT onboarding FROM public.apps WHERE app_id=$1', [ids[0]])).rows[0].onboarding
    await client.query('INSERT INTO public.app_onboarding_refresh_jobs(app_id,batch_token) VALUES ($1,$2)', [ids[0], token])
    client.release()
    try {
      mocks.run.mockRejectedValue(new Error('Cloudflare unavailable'))
      await expect(refreshAppOnboardingBatch(context, getDrizzleClient(pool), { appIds: ids, batchToken: token }, now)).rejects.toThrow('Cloudflare unavailable')
      expect((await pool.query('SELECT onboarding FROM public.apps WHERE app_id=$1', [ids[0]])).rows[0].onboarding).toEqual(before)
      expect((await pool.query('SELECT batch_token FROM public.app_onboarding_refresh_jobs WHERE app_id=$1', [ids[0]])).rows[0].batch_token).toBe(token)
      mocks.run.mockClear()
      expect(await refreshAppOnboardingBatch(context, getDrizzleClient(pool), { appIds: ids, batchToken: randomUUID() }, now)).toBe(0)
      expect(mocks.run).not.toHaveBeenCalled()
    }
    finally {
      await pool.query('DELETE FROM public.apps WHERE app_id=ANY($1::varchar[])', [ids])
      await pool.query('DELETE FROM public.orgs WHERE id=$1', [orgId])
    }
  })
})
