import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { DEPLOY_REPORT_CONSUME_SQL, DEPLOY_REPORT_RELEASE_SQL, DEPLOY_REPORT_SELECT_SQL } from '../supabase/functions/_backend/utils/deploy_report.ts'
import { POSTGRES_URL } from './test-utils.ts'

const pool = new Pool({ connectionString: POSTGRES_URL, max: 8 })
afterAll(async () => pool.end())

// Run the real parameterized statements against isolated PostgreSQL fixtures.
async function fixture(run: (db: PoolClient, sql: (query: string) => string, claim: unknown[], consume: unknown[]) => Promise<void>) {
  const db = await pool.connect()
  const schema = `report_${randomUUID().replaceAll('-', '')}`
  const org = randomUUID()
  const sql = (query: string) => query.replaceAll('public.', `${schema}.`)
  try {
    await db.query('BEGIN')
    await db.query(`CREATE SCHEMA ${schema}`)
    await db.query(sql(`
      CREATE TABLE public.apps (app_id text PRIMARY KEY, owner_org uuid, name text);
      CREATE TABLE public.channels (id bigint PRIMARY KEY, app_id text, owner_org uuid, version bigint, name text, public boolean, ios boolean, android boolean, paused_at timestamptz);
      CREATE TABLE public.app_versions (id bigint PRIMARY KEY, app_id text, owner_org uuid, name text, deleted boolean, deleted_at timestamptz);
      CREATE TABLE public.deploy_history (id bigint PRIMARY KEY, app_id text, owner_org uuid, version_id bigint, channel_id bigint, deployed_at timestamptz, install_stats_email_sent_at timestamptz);
    `))
    await db.query(sql(`INSERT INTO public.apps VALUES ('com.example.report', $1, 'Example')`), [org])
    await db.query(sql(`INSERT INTO public.channels VALUES (3, 'com.example.report', $1, 2, 'production', true, true, false, NULL)`), [org])
    await db.query(sql(`INSERT INTO public.app_versions VALUES (2, 'com.example.report', $1, '1.0.0', false, NULL)`), [org])
    await db.query(sql(`INSERT INTO public.deploy_history VALUES (1, 'com.example.report', $1, 2, 3, now() - interval '25 hours', now() - interval '1 minute')`), [org])
    const { rows } = await db.query(sql('SELECT deployed_at::text, install_stats_email_sent_at::text FROM public.deploy_history'))
    const claim = [1, 'com.example.report', rows[0].install_stats_email_sent_at]
    await run(db, sql, claim, [...claim, 2, '1.0.0', org, rows[0].deployed_at])
  }
  finally {
    await db.query('ROLLBACK')
    db.release()
  }
}

describe('deploy report atomic send gate', () => {
  it.concurrent('consumes a valid claim once and does not release an already consumed token', async () => {
    await fixture(async (db, sql, claim, consume) => {
      expect((await db.query(sql(DEPLOY_REPORT_SELECT_SQL), claim)).rows).toHaveLength(1)
      expect((await db.query(sql(DEPLOY_REPORT_CONSUME_SQL), consume)).rows).toHaveLength(1)
      expect((await db.query(sql(DEPLOY_REPORT_CONSUME_SQL), consume)).rows).toHaveLength(0)
      expect((await db.query(sql(DEPLOY_REPORT_RELEASE_SQL), claim)).rowCount).toBe(0)
    })
  })

  it.concurrent('the migration queues versioned jobs with the exact claim token', async () => {
    await fixture(async (db, sql) => {
      await db.query(sql(`
        CREATE TABLE public.cron_tasks (name text, second_interval integer, minute_interval integer, hour_interval integer, run_at_hour integer, run_at_minute integer, updated_at timestamptz);
        INSERT INTO public.cron_tasks (name) VALUES ('deploy_install_stats_email');
        CREATE TABLE public.orgs (id uuid PRIMARY KEY, management_email text);
        INSERT INTO public.orgs SELECT owner_org, 'report@example.com' FROM public.apps;
        CREATE TABLE public.report_queue (payload jsonb);
        CREATE FUNCTION public.queue_send(text, jsonb) RETURNS bigint
        LANGUAGE sql SET search_path = '' AS $$
          INSERT INTO public.report_queue VALUES ($2) RETURNING 1::bigint
        $$;
        UPDATE public.deploy_history SET install_stats_email_sent_at = NULL;
      `))
      const migration = readFileSync(new URL('../supabase/migrations/20261112183933_restore_deploy_report_schedule.sql', import.meta.url), 'utf8')
      await db.query(sql(migration.replaceAll('pgmq.send', 'public.queue_send')))
      expect((await db.query(sql('SELECT hour_interval FROM public.cron_tasks'))).rows[0].hour_interval).toBe(1)
      await db.query(sql('SELECT public.process_deploy_install_stats_email()'))
      const { rows } = await db.query(sql(`SELECT payload->'payload' AS job,
        (payload->'payload'->>'reportClaimedAt')::timestamptz = dh.install_stats_email_sent_at AS matches
        FROM public.report_queue CROSS JOIN public.deploy_history dh`))
      expect(rows).toHaveLength(1)
      expect(rows[0].matches).toBe(true)
      expect(rows[0].job).toMatchObject({ type: 'deploy_install_stats_v2', deployId: 1, appId: 'com.example.report', versionId: 2 })
      await db.query(sql('SELECT public.process_deploy_install_stats_email()'))
      expect((await db.query(sql('SELECT * FROM public.report_queue'))).rows).toHaveLength(1)
    })
  })

  it.concurrent('releases an unconsumed claim for a later producer pass', async () => {
    await fixture(async (db, sql, claim) => {
      expect((await db.query(sql(DEPLOY_REPORT_RELEASE_SQL), claim)).rowCount).toBe(1)
      expect((await db.query(sql(DEPLOY_REPORT_SELECT_SQL), claim)).rows).toHaveLength(0)
    })
  })

  it.concurrent.each([
    ['deleted app', 'DELETE FROM public.apps'],
    ['transferred app', 'UPDATE public.apps SET owner_org = gen_random_uuid()'],
    ['deleted channel', 'DELETE FROM public.channels'],
    ['private channel', 'UPDATE public.channels SET public = false'],
    ['disabled platforms', 'UPDATE public.channels SET ios = false, android = false'],
    ['paused channel', 'UPDATE public.channels SET paused_at = now()'],
    ['rolled back channel', 'UPDATE public.channels SET version = 99'],
    ['deleted bundle', 'UPDATE public.app_versions SET deleted = true'],
    ['pending bundle deletion', 'UPDATE public.app_versions SET deleted_at = now()'],
    ['transferred bundle', 'UPDATE public.app_versions SET owner_org = gen_random_uuid()'],
    ['premature report', "UPDATE public.deploy_history SET deployed_at = now() - interval '23 hours'"],
    ['expired report', "UPDATE public.deploy_history SET deployed_at = now() - interval '48 hours'"],
    ['future deployment', "UPDATE public.deploy_history SET deployed_at = now() + interval '1 hour'"],
    ['superseded deployment', 'INSERT INTO public.deploy_history SELECT 9, app_id, owner_org, version_id, channel_id, now(), NULL FROM public.deploy_history'],
  ])('does not send after %s even if the preliminary read was cached', async (_name, mutation) => {
    await fixture(async (db, sql, claim, consume) => {
      expect((await db.query(sql(DEPLOY_REPORT_SELECT_SQL), claim)).rows).toHaveLength(1)
      await db.query(sql(mutation))
      expect((await db.query(sql(DEPLOY_REPORT_CONSUME_SQL), consume)).rows).toHaveLength(0)
    })
  })

  it.concurrent('rejects a changed analytics window or bundle name', async () => {
    await fixture(async (db, sql, _claim, consume) => {
      await db.query(sql("UPDATE public.app_versions SET name = '2.0.0'"))
      expect((await db.query(sql(DEPLOY_REPORT_CONSUME_SQL), consume)).rows).toHaveLength(0)
      await db.query(sql("UPDATE public.app_versions SET name = '1.0.0'"))
      await db.query(sql("UPDATE public.deploy_history SET deployed_at = deployed_at - interval '1 hour'"))
      expect((await db.query(sql(DEPLOY_REPORT_CONSUME_SQL), consume)).rows).toHaveLength(0)
    })
  })
})
