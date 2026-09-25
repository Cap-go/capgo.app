import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { refreshAppOnboardingBatch } from '../supabase/functions/_backend/utils/app_onboarding_refresh.ts'
import { getDrizzleClient } from '../supabase/functions/_backend/utils/pg.ts'
import { getPostgresClient } from './test-utils.ts'

afterAll(async () => (await getPostgresClient()).end())

async function fixture(client: any, count: number, billing: 'paid' | 'trial' | 'credits' | 'none' = 'none') {
  const orgId = randomUUID()
  let customerId = billing === 'paid' || billing === 'trial' ? `cus_onboarding_${orgId}` : null
  const owner = (await client.query('SELECT id FROM public.users WHERE email = \'test@capgo.app\'')).rows[0].id
  if (customerId) {
    await client.query(`INSERT INTO public.stripe_info(customer_id,status,product_id,trial_at)
      VALUES ($1,$2,'prod_LQIregjtNduh4q',$3::timestamptz)`, [customerId, billing === 'paid' ? 'succeeded' : 'created', billing === 'trial' ? new Date(Date.now() + 86400000).toISOString() : '2020-01-01T00:00:00Z'])
  }
  await client.query('INSERT INTO public.orgs(id,created_by,name,management_email,customer_id) VALUES ($1,$2,$3,\'onboarding-refresh@example.com\',$4)', [orgId, owner, `Refresh ${orgId}`, customerId])
  customerId = (await client.query('SELECT customer_id FROM public.orgs WHERE id=$1', [orgId])).rows[0].customer_id
  if (billing === 'none' || billing === 'credits') {
    await client.query('UPDATE public.stripe_info SET status=\'created\', trial_at=now()-interval \'1 day\' WHERE customer_id=$1', [customerId])
  }
  if (billing === 'credits') {
    await client.query('INSERT INTO public.usage_credit_grants(org_id,credits_total,credits_consumed,expires_at) VALUES ($1,1,0,now()+interval \'1 day\')', [orgId])
  }
  const ids = Array.from({ length: count }, (_, i) => `000.r.${orgId}.${String(i).padStart(4, '0')}`)
  await client.query(`INSERT INTO public.apps(app_id,owner_org,name,icon_url,need_onboarding)
    SELECT app_id,$1,'Refresh fixture','',false FROM pg_catalog.unnest($2::varchar[]) ids(app_id)`, [orgId, ids])
  return { orgId, customerId, ids }
}

async function cleanup(client: any, fixtures: Awaited<ReturnType<typeof fixture>>[]) {
  for (const item of fixtures) {
    await client.query('DELETE FROM public.daily_version WHERE app_id=ANY($1::varchar[])', [item.ids])
    await client.query('DELETE FROM public.devices WHERE app_id=ANY($1::varchar[])', [item.ids])
    await client.query('DELETE FROM public.build_requests WHERE app_id=ANY($1::varchar[])', [item.ids])
    await client.query('DELETE FROM public.app_versions WHERE app_id=ANY($1::varchar[])', [item.ids])
    await client.query('DELETE FROM public.apps WHERE app_id=ANY($1::varchar[])', [item.ids])
    await client.query('DELETE FROM public.usage_credit_grants WHERE org_id=$1', [item.orgId])
    await client.query('DELETE FROM public.orgs WHERE id=$1', [item.orgId])
    if (item.customerId)
      await client.query('DELETE FROM public.stripe_info WHERE customer_id=$1', [item.customerId])
  }
}

describe('backend onboarding refresh', () => {
  it('queues only eligible apps, batches 25, and requeues unrefreshed work after 30 minutes', async () => {
    const client = await (await getPostgresClient()).connect()
    try {
      await client.query('BEGIN')
      const excluded = await fixture(client, 1)
      const paid = await fixture(client, 26, 'paid')
      const trial = await fixture(client, 1, 'trial')
      const credited = await fixture(client, 1, 'credits')
      const eligible = [...paid.ids, ...trial.ids, ...credited.ids]
      const countMessagesFor = async (appId: string) => (await client.query(`SELECT count(*)::int AS count
        FROM pgmq.q_cron_onboarding_refresh_apps WHERE message->'payload'->'appIds' ? $1`, [appId])).rows[0].count as number
      const first = (await client.query('SELECT public.enqueue_app_onboarding_refreshes(500) AS count')).rows[0].count
      expect(first).toBeGreaterThanOrEqual(eligible.length)
      const ownMessages = (await client.query(`SELECT message->'payload' AS payload FROM pgmq.q_cron_onboarding_refresh_apps
        WHERE message->'payload'->'appIds' ?| $1::text[] ORDER BY msg_id`, [eligible])).rows
      const queued = ownMessages.flatMap(row => row.payload.appIds).filter((id: string) => eligible.includes(id))
      expect(queued.sort()).toEqual([...eligible].sort())
      expect(ownMessages.every(row => row.payload.appIds.length <= 25)).toBe(true)
      expect(ownMessages.every(row => typeof row.payload.queuedAt === 'string')).toBe(true)
      expect(await countMessagesFor(excluded.ids[0])).toBe(0)
      const excludedStateCount = (await client.query(
        'SELECT count(*)::int AS count FROM public.app_onboarding WHERE app_id=$1',
        [excluded.ids[0]],
      )).rows[0].count
      expect(excludedStateCount).toBe(0)
      const state = (await client.query(`SELECT queued_refresh_at, refreshed_at
        FROM public.app_onboarding WHERE app_id=$1`, [eligible[0]])).rows[0]
      expect(state.queued_refresh_at).toBeTruthy()
      expect(state.refreshed_at).toBeNull()
      expect((await client.query(`SELECT onboarding ? 'queued_refresh_at' AS present
        FROM public.apps WHERE app_id=$1`, [eligible[0]])).rows[0].present).toBe(false)
      await client.query('SELECT public.enqueue_app_onboarding_refreshes(500)')
      expect(await countMessagesFor(eligible[0])).toBe(1)
      await client.query(`UPDATE public.app_onboarding SET queued_refresh_at=now()-interval '31 minutes'
        WHERE app_id=ANY($1::varchar[])`, [eligible])
      await client.query('SELECT public.enqueue_app_onboarding_refreshes(500)')
      expect(await countMessagesFor(eligible[0])).toBe(2)
      await client.query(`UPDATE public.app_onboarding SET refreshed_at=now()
        WHERE app_id=ANY($1::varchar[])`, [eligible])
      await client.query('SELECT public.enqueue_app_onboarding_refreshes(500)')
      expect(await countMessagesFor(eligible[0])).toBe(2)
    }
    finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('keeps the producer cap at 500 after eligibility filtering', async () => {
    const client = await (await getPostgresClient()).connect()
    try {
      await client.query('BEGIN')
      await fixture(client, 501, 'paid')
      expect((await client.query('SELECT public.enqueue_app_onboarding_refreshes(999999) AS count')).rows[0].count).toBe(500)
    }
    finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('derives old PostgreSQL milestones while preserving setup, custom fields, and replay safety', async () => {
    const pool = await getPostgresClient()
    const client = await pool.connect()
    let item: Awaited<ReturnType<typeof fixture>> | undefined
    let released = false
    try {
      item = await fixture(client, 2)
      const [appId, emptyApp] = item.ids
      const onboarding = {
        setup: { steps: { add_code: { status: 'done' } } },
        getting_started_dismissed_at: '2026-09-01T00:00:00Z',
        custom_field: null,
        features: {
          custom: { succeeded_at: '2026-08-02T00:00:00Z' },
          cli_install: { succeeded_at: '2026-08-03T00:00:00Z' },
        },
      }
      await client.query('UPDATE public.apps SET onboarding=$2::jsonb WHERE app_id=$1', [appId, JSON.stringify(onboarding)])
      await client.query(`INSERT INTO public.devices(app_id,device_id,platform,plugin_version,version_name,install_source,is_prod,is_emulator,updated_at)
        VALUES ($1,$2,'ios','7.0.0','1.0.0','testflight',true,false,'2026-09-16T12:00:00Z')`, [appId, `device-${randomUUID()}`])
      await client.query(`INSERT INTO public.app_versions(app_id,owner_org,name,created_at)
        VALUES ($1,$2,'first-bundle','2026-08-02T00:00:00Z')`, [appId, item.orgId])
      await client.query(`INSERT INTO public.daily_version(date,app_id,version_name,install)
        VALUES ('2026-08-05',$1,'1.0.0',1),('2026-09-16',$1,'1.0.0',1)`, [appId])
      const owner = (await client.query('SELECT created_by FROM public.orgs WHERE id=$1', [item.orgId])).rows[0].created_by
      await client.query(`INSERT INTO public.build_requests(app_id,owner_org,requested_by,platform,status,upload_session_key,upload_path,upload_url,upload_expires_at,created_at,completed_at)
        VALUES ($1,$2,$3,'android','succeeded','test-only','fixture','https://example.com',now(),'2026-08-03T00:00:00Z','2026-08-04T00:00:00Z')`, [appId, item.orgId, owner])
      client.release()
      released = true
      const queuedAt = new Date(Date.now() - 60000).toISOString()
      await pool.query('DELETE FROM public.app_onboarding WHERE app_id=ANY($1::varchar[])', [item.ids])
      expect(await refreshAppOnboardingBatch(getDrizzleClient(pool), { appIds: item.ids, queuedAt })).toBe(2)
      const row = (await pool.query('SELECT onboarding FROM public.apps WHERE app_id=$1', [appId])).rows[0].onboarding
      expect(row.setup).toEqual(onboarding.setup)
      expect(row.getting_started_dismissed_at).toBe(onboarding.getting_started_dismissed_at)
      expect(row).toHaveProperty('custom_field', null)
      expect(row.features.custom).toEqual(onboarding.features.custom)
      expect(row.features.cli_install.succeeded_at).toBe('2026-08-03T00:00:00.000Z')
      expect(row.features.cli_install.last_used_at).toBe('2026-09-16T12:00:00.000Z')
      expect(row.features.ota).toMatchObject({
        started_at: '2026-08-02T00:00:00.000Z',
        succeeded_at: '2026-08-05T00:00:00.000Z',
        last_used_at: '2026-09-16T00:00:00.000Z',
        stage: 'testflight',
      })
      expect(row.features.builder).toMatchObject({
        started_at: '2026-08-03T00:00:00.000Z',
        succeeded_at: '2026-08-04T00:00:00.000Z',
      })
      expect(row).not.toHaveProperty('refreshed_at')
      const refreshState = (await pool.query(`SELECT queued_refresh_at, refreshed_at
        FROM public.app_onboarding WHERE app_id=$1`, [appId])).rows[0]
      expect(refreshState.queued_refresh_at).toBeNull()
      expect(refreshState.refreshed_at).toBeTruthy()
      const empty = (await pool.query('SELECT onboarding FROM public.apps WHERE app_id=$1', [emptyApp])).rows[0].onboarding
      expect(empty.features.ota.stage).toBe('no_device')
      expect(await refreshAppOnboardingBatch(getDrizzleClient(pool), { appIds: item.ids, queuedAt })).toBe(0)
    }
    finally {
      if (!released)
        client.release()
      if (item)
        await cleanup(pool, [item])
    }
  })

  it('rolls back feature and checkpoint writes when the transaction fails', async () => {
    const pool = await getPostgresClient()
    const client = await pool.connect()
    const item = await fixture(client, 1)
    client.release()
    try {
      const before = (await pool.query('SELECT onboarding FROM public.apps WHERE app_id=$1', [item.ids[0]])).rows[0].onboarding
      await pool.query('DELETE FROM public.app_onboarding WHERE app_id=$1', [item.ids[0]])
      const database = getDrizzleClient(pool)
      const failingDatabase: Pick<typeof database, 'transaction'> = {
        transaction: (operation, config) => database.transaction(async (tx) => {
          const result = await operation(tx)
          await tx.execute(sql`SELECT 1/0`)
          return result
        }, config),
      }
      await expect(refreshAppOnboardingBatch(failingDatabase, { appIds: item.ids, queuedAt: new Date(Date.now() - 60000).toISOString() })).rejects.toThrow()
      expect((await pool.query('SELECT onboarding FROM public.apps WHERE app_id=$1', [item.ids[0]])).rows[0].onboarding).toEqual(before)
      expect((await pool.query('SELECT count(*)::int AS count FROM public.app_onboarding WHERE app_id=$1', [item.ids[0]])).rows[0].count).toBe(0)
    }
    finally {
      await cleanup(pool, [item])
    }
  })
})
