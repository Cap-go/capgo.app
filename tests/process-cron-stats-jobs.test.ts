import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executeSQL,
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
})
