import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupPostgresClient, getPostgresClient } from './test-utils.ts'

const migration = await readFile(new URL('../supabase/migrations/20261111225650_cron_task_duration_diagnostics.sql', import.meta.url), 'utf8')

afterAll(cleanupPostgresClient)

describe('cron task duration diagnostics', () => {
  it('reports slow jobs without payloads and continues after a failing job', async () => {
    const pool = await getPostgresClient()
    const client = await pool.connect()
    const warnings: string[] = []
    const notice = (event: { message?: string }) => warnings.push(event.message ?? '')
    client.on('notice', notice)
    try {
      await client.query('BEGIN')
      // Session-local fixtures: never mutate cron_tasks or dispatch real queues.
      await client.query(`
        CREATE TEMP TABLE cron_tasks (
          id int, name text, enabled boolean DEFAULT true, task_type text,
          target text, payload jsonb, batch_size int, second_interval int,
          minute_interval int, hour_interval int, run_at_hour int,
          run_at_minute int, run_on_dow int, run_on_day int
        );
        CREATE TEMP TABLE cron_observed (name text);
        CREATE FUNCTION pg_temp.enqueue_cron_tick(queue_name text, payload jsonb)
        RETURNS void LANGUAGE sql SET search_path = '' AS $fn$
          INSERT INTO pg_temp.cron_observed VALUES (queue_name);
        $fn$;
        CREATE FUNCTION pg_temp.process_function_queue(queue_names text[], batch_size int DEFAULT 950)
        RETURNS void LANGUAGE sql SET search_path = '' AS $fn$
          INSERT INTO pg_temp.cron_observed SELECT unnest(queue_names);
        $fn$;
        CREATE FUNCTION pg_temp.fail_task()
        RETURNS void LANGUAGE plpgsql SET search_path = '' AS $fn$
        BEGIN
          RAISE EXCEPTION 'fixture failure';
        END;
        $fn$;
        INSERT INTO pg_temp.cron_tasks (id, name, task_type, target, second_interval, payload) VALUES
          (1, 'slow_fixture', 'function', 'pg_catalog.pg_sleep(1.02)', 10, '{"private":"fixture-payload"}'),
          (2, 'failed_fixture', 'function', 'pg_temp.fail_task()', 10, NULL),
          (3, 'queue_fixture', 'queue', 'after_failure', 10, NULL),
          (4, 'dispatch_fixture', 'function_queue', '["dispatch_after_failure"]', 10, NULL);
      `)
      // Use the migration body with only schema/lock isolation, preserving its
      // actual scheduler and timing logic. No shared job or lock is modified.
      await client.query(migration.replaceAll('public.', 'pg_temp.').replaceAll('advisory_lock(1)', 'advisory_lock(76318429)').replaceAll('advisory_unlock(1)', 'advisory_unlock(76318429)'))
      await client.query('SELECT pg_temp.process_all_cron_tasks()')
      expect(warnings).toContainEqual(expect.stringMatching(/cron task "slow_fixture" slow: duration_ms=\d+/))
      expect(warnings).toContainEqual(expect.stringContaining('cron task "failed_fixture" failed: fixture failure'))
      expect(warnings.join('\n')).not.toContain('fixture-payload')
      expect(warnings.some(message => /queue_fixture.*slow/.test(message))).toBe(false)
      const { rows } = await client.query('SELECT name FROM pg_temp.cron_observed')
      expect(rows.map(row => row.name)).toEqual(expect.arrayContaining(['after_failure', 'dispatch_after_failure', 'cron_rollout_auto_pause']))
      const lock = await client.query('SELECT pg_catalog.pg_advisory_unlock(76318429) AS held')
      expect(lock.rows[0].held).toBe(false)
    }
    finally {
      await client.query('ROLLBACK')
      await client.query('SELECT pg_catalog.pg_advisory_unlock(76318429)')
      client.removeListener('notice', notice)
      client.release()
    }
  })
})
