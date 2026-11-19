import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executeSQL,
  getPostgresClient,
  ORG_ID_CRON_QUEUE,
  resetAndSeedAppData,
  resetAndSeedAppDataStats,
  resetAppData,
  resetAppDataStats,
  STRIPE_CUSTOMER_ID_CRON_QUEUE,
} from './test-utils.ts'

const processCronAppId = `com.cron.queue.${randomUUID().slice(0, 8)}`

async function clearCronStatAppMessages(appId: string) {
  await executeSQL(`DELETE FROM pgmq.q_cron_stat_app WHERE message->'payload'->>'appId' = $1`, [appId])
}

async function getCronStatAppMessages(appId: string) {
  return executeSQL(
    `SELECT message FROM pgmq.q_cron_stat_app WHERE message->'payload'->>'appId' = $1 ORDER BY msg_id DESC`,
    [appId],
  )
}

describe('cron_stat_app queue resilience', () => {
  beforeAll(async () => {
    await resetAndSeedAppData(processCronAppId, {
      orgId: ORG_ID_CRON_QUEUE,
      stripeCustomerId: STRIPE_CUSTOMER_ID_CRON_QUEUE,
    })
    await resetAndSeedAppDataStats(processCronAppId)
  })

  afterAll(async () => {
    await clearCronStatAppMessages(processCronAppId)
    await resetAppData(processCronAppId)
    await resetAppDataStats(processCronAppId)
  })

  it('process_cron_stats_jobs still queues active apps when first-seen MAU leaves daily_mau quiet', async () => {
    await clearCronStatAppMessages(processCronAppId)

    // MAU is now recorded on the device's first day in the billing window, so
    // an active app may legitimately have no fresh daily_mau rows anymore.
    await executeSQL(`DELETE FROM public.daily_mau WHERE app_id = $1`, [processCronAppId])
    await executeSQL(
      `UPDATE public.app_versions SET created_at = NOW() - INTERVAL '45 days' WHERE app_id = $1`,
      [processCronAppId],
    )

    await executeSQL(
      `INSERT INTO public.device_usage (device_id, app_id, timestamp, org_id) VALUES ($1, $2, NOW() - INTERVAL '10 minutes', $3)`,
      [randomUUID(), processCronAppId, ORG_ID_CRON_QUEUE],
    )
    await executeSQL(
      `INSERT INTO public.bandwidth_usage (device_id, app_id, file_size, timestamp) VALUES ($1, $2, $3, NOW() - INTERVAL '10 minutes')`,
      [randomUUID(), processCronAppId, 4096],
    )

    await executeSQL(`SELECT public.process_cron_stats_jobs()`)

    const queuedMessages = await getCronStatAppMessages(processCronAppId)
    expect(queuedMessages).toHaveLength(1)
    expect(queuedMessages[0]?.message?.payload?.appId).toBe(processCronAppId)
    expect(queuedMessages[0]?.message?.payload?.orgId).toBe(ORG_ID_CRON_QUEUE)
    expect(queuedMessages[0]?.message?.payload?.todayOnly).toBe(false)
  })

  it('an immediate refresh promotes a job parked in a staggered stats slot', async () => {
    const appId = processCronAppId
    await clearCronStatAppMessages(appId)
    await executeSQL(`DELETE FROM public.app_stats_refresh_state WHERE app_id = $1`, [appId])

    await executeSQL(`SELECT public.queue_cron_stat_app_for_app($1, $2, 600)`, [appId, ORG_ID_CRON_QUEUE])
    const [parked] = await executeSQL(
      `SELECT vt > now() + INTERVAL '5 minutes' AS parked FROM pgmq.q_cron_stat_app WHERE message->'payload'->>'appId' = $1`,
      [appId],
    )
    expect(parked?.parked).toBe(true)

    const [before] = await executeSQL(
      `SELECT stats_refresh_requested_at::text AS requested_at FROM public.app_stats_refresh_state WHERE app_id = $1`,
      [appId],
    )

    // Still inside the 5-minute request TTL the parked job just stamped.
    await executeSQL(`SELECT public.queue_cron_stat_app_for_app($1, $2)`, [appId, ORG_ID_CRON_QUEUE])

    // Chart refresh RPCs report an app as queued only when this stamp advances.
    const [after] = await executeSQL(
      `SELECT stats_refresh_requested_at > $2::timestamp AS advanced FROM public.app_stats_refresh_state WHERE app_id = $1`,
      [appId, before?.requested_at],
    )
    expect(after?.advanced).toBe(true)

    const rows = await executeSQL(
      `SELECT vt <= clock_timestamp() AS readable FROM pgmq.q_cron_stat_app WHERE message->'payload'->>'appId' = $1`,
      [appId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.readable).toBe(true)
  })

  it('does not queue an app twice and honours the request TTL', async () => {
    const appId = processCronAppId
    await clearCronStatAppMessages(appId)
    await executeSQL(`DELETE FROM public.app_stats_refresh_state WHERE app_id = $1`, [appId])

    await executeSQL(`SELECT public.process_cron_stats_jobs()`)
    expect(await getCronStatAppMessages(appId)).toHaveLength(1)

    // Still queued: a second run must not add another message.
    await executeSQL(
      `UPDATE public.app_stats_refresh_state SET stats_refresh_requested_at = stats_refresh_requested_at - INTERVAL '1 hour' WHERE app_id = $1`,
      [appId],
    )
    await executeSQL(`SELECT public.process_cron_stats_jobs()`)
    expect(await getCronStatAppMessages(appId)).toHaveLength(1)

    // Not queued, but requested inside the 5-minute TTL: no message either.
    await clearCronStatAppMessages(appId)
    await executeSQL(
      `UPDATE public.app_stats_refresh_state SET stats_refresh_requested_at = timezone('UTC', clock_timestamp()) WHERE app_id = $1`,
      [appId],
    )
    await executeSQL(`SELECT public.process_cron_stats_jobs()`)
    expect(await getCronStatAppMessages(appId)).toHaveLength(0)

    // Fresh stats inside the TTL: still nothing; once both are old, it is queued again.
    await executeSQL(
      `UPDATE public.app_stats_refresh_state
        SET stats_refresh_requested_at = timezone('UTC', clock_timestamp()) - INTERVAL '1 hour',
            stats_updated_at = timezone('UTC', clock_timestamp())
        WHERE app_id = $1`,
      [appId],
    )
    await executeSQL(`SELECT public.process_cron_stats_jobs()`)
    expect(await getCronStatAppMessages(appId)).toHaveLength(0)

    await executeSQL(
      `UPDATE public.app_stats_refresh_state SET stats_updated_at = timezone('UTC', clock_timestamp()) - INTERVAL '1 hour' WHERE app_id = $1`,
      [appId],
    )
    await executeSQL(`SELECT public.process_cron_stats_jobs()`)
    const queued = await getCronStatAppMessages(appId)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.message).toEqual({
      function_name: 'cron_stat_app',
      function_type: 'cloudflare',
      payload: { appId, orgId: ORG_ID_CRON_QUEUE, todayOnly: false },
    })
    await clearCronStatAppMessages(appId)
  })

  it('drains cron_stat_app within the Analytics Engine API budget', async () => {
    // 4 SQL API calls per app; up to 10 consumer calls per minute; the token
    // allows 1,200 requests per 5 minutes and is shared with dashboards.
    const [task] = await executeSQL<{ batch_size: number, minute_interval: number }>(
      `SELECT batch_size, minute_interval FROM public.cron_tasks WHERE name = 'stat_app_queue'`,
    )
    expect(task).toEqual({ batch_size: 3, minute_interval: 1 })
    const callsPerFiveMinutes = 4 * task!.batch_size * 10 * 5
    expect(callsPerFiveMinutes).toBeLessThanOrEqual(600)
  })

  it('indexes the queued-job lookups by payload id', async () => {
    const indexes = await executeSQL<{ indexname: string, indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'pgmq' AND tablename IN ('q_cron_stat_app', 'q_cron_stat_org')
        ORDER BY indexname`,
    )
    const definitions = indexes.map(index => index.indexdef)
    expect(definitions.some(def => def.includes('q_cron_stat_app') && def.includes(`'appId'`))).toBe(true)
    expect(definitions.some(def => def.includes('q_cron_stat_org') && def.includes(`'orgId'`))).toBe(true)

    // The lookups in queue_cron_stat_app_for_app, process_cron_stats_jobs and
    // process_cron_stat_org_jobs match the indexed expressions. Tiny test
    // tables may still prefer a sequential scan, so disable it for the check.
    const client = await (await getPostgresClient()).connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL enable_seqscan = off')
      const appPlan = await client.query(
        `EXPLAIN SELECT 1 FROM pgmq.q_cron_stat_app queued_job
          WHERE queued_job.message->'payload'->>'appId' = $1::character varying`,
        ['com.example.index'],
      )
      const orgPlan = await client.query(
        `EXPLAIN SELECT 1 FROM pgmq.q_cron_stat_org queued_job
          WHERE queued_job.message->'payload'->>'orgId' = $1::uuid::text`,
        [ORG_ID_CRON_QUEUE],
      )
      expect(appPlan.rows.map(row => row['QUERY PLAN']).join('\n')).toContain('q_cron_stat_app_payload_app_id_idx')
      expect(orgPlan.rows.map(row => row['QUERY PLAN']).join('\n')).toContain('q_cron_stat_org_payload_org_id_idx')
    }
    finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('releases the stats burst 25 apps per minute', async () => {
    const prefix = `com.cron.stagger.${randomUUID().slice(0, 8)}`
    // One more than a slot, so the 26th queued app must land in the next minute.
    const appIds = Array.from({ length: 26 }, (_, index) => `${prefix}.${index}`)
    await executeSQL(
      `INSERT INTO public.apps (app_id, icon_url, owner_org, name)
        SELECT id, '', $2, id FROM unnest($1::varchar[]) AS id`,
      [appIds, ORG_ID_CRON_QUEUE],
    )
    await executeSQL(
      `INSERT INTO public.app_versions (app_id, name, owner_org)
        SELECT id, '1.0.0', $2 FROM unnest($1::varchar[]) AS id`,
      [appIds, ORG_ID_CRON_QUEUE],
    )

    try {
      // pgmq stamps enqueued_at with now(), so this run's messages share the
      // statement timestamp returned here.
      const [run] = await executeSQL(
        `SELECT now()::text AS started_at FROM (SELECT public.process_cron_stats_jobs()) AS job`,
      )
      const rows = await executeSQL(
        `SELECT EXTRACT(EPOCH FROM (vt - enqueued_at))::float AS delay_seconds
          FROM pgmq.q_cron_stat_app
          WHERE enqueued_at = $1::timestamptz
          ORDER BY msg_id`,
        [run?.started_at],
      )

      expect(rows.length).toBeGreaterThanOrEqual(appIds.length)
      rows.forEach((row: { delay_seconds: number }, index: number) => {
        expect(row.delay_seconds).toBeCloseTo(Math.floor(index / 25) * 60, -1)
      })
    }
    finally {
      await executeSQL(`DELETE FROM pgmq.q_cron_stat_app WHERE message->'payload'->>'appId' = ANY($1::varchar[])`, [appIds])
      await executeSQL(`DELETE FROM public.app_versions WHERE app_id = ANY($1::varchar[])`, [appIds])
      await executeSQL(`DELETE FROM public.apps WHERE app_id = ANY($1::varchar[])`, [appIds])
    }
  })
})

