import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanupPostgresClient, executeSQL, ORG_ID_CRON_QUEUE } from './test-utils.ts'

async function getCronSyncSubQueueBaseline() {
  const [row] = await executeSQL(
    `SELECT COALESCE(MAX(msg_id), 0) AS max_msg_id
      FROM pgmq.q_cron_sync_sub
      WHERE message->>'function_name' = 'cron_sync_sub'`,
  )
  return Number(row?.max_msg_id ?? 0)
}

async function clearCronSyncSubMessagesSince(minMsgIdExclusive: number) {
  await executeSQL(
    `DELETE FROM pgmq.q_cron_sync_sub
      WHERE message->>'function_name' = 'cron_sync_sub'
        AND msg_id > $1`,
    [minMsgIdExclusive],
  )
}

async function getCronSyncSubMessagesSince(minMsgIdExclusive: number) {
  return executeSQL(
    `SELECT message
      FROM pgmq.q_cron_sync_sub
      WHERE message->>'function_name' = 'cron_sync_sub'
        AND msg_id > $1
      ORDER BY msg_id DESC`,
    [minMsgIdExclusive],
  )
}

describe('process_cron_sync_sub_jobs', () => {
  let baselineMsgId = 0

  beforeEach(async () => {
    baselineMsgId = await getCronSyncSubQueueBaseline()
  })

  afterEach(async () => {
    await clearCronSyncSubMessagesSince(baselineMsgId)
  })

  afterAll(async () => {
    await cleanupPostgresClient()
  })

  it('queues cron_sync_sub with the standard payload envelope', async () => {
    const [orgRow] = await executeSQL(
      `SELECT o.id, si.customer_id
        FROM public.orgs AS o
        INNER JOIN public.stripe_info AS si ON o.customer_id = si.customer_id
        WHERE o.id = $1`,
      [ORG_ID_CRON_QUEUE],
    )

    expect(orgRow?.id).toBe(ORG_ID_CRON_QUEUE)
    expect(orgRow?.customer_id).toBeTruthy()

    await executeSQL('SELECT public.process_cron_sync_sub_jobs()')

    const queuedMessages = await getCronSyncSubMessagesSince(baselineMsgId)
    expect(queuedMessages.length).toBeGreaterThan(0)

    const targetMessage = queuedMessages.find((queuedMessage: { message?: { payload?: { orgId?: string } } }) =>
      queuedMessage.message?.payload?.orgId === ORG_ID_CRON_QUEUE)
    expect(targetMessage?.message).toMatchObject({
      function_name: 'cron_sync_sub',
      function_type: null,
      payload: {
        orgId: ORG_ID_CRON_QUEUE,
        customerId: orgRow?.customer_id,
      },
    })
    expect(targetMessage?.message?.orgId).toBeUndefined()
  })

  it('releases the burst in per-minute slots so queue_health does not flag it as stale', async () => {
    await executeSQL('SELECT public.process_cron_sync_sub_jobs()')

    const rows = await executeSQL(
      `SELECT EXTRACT(EPOCH FROM (vt - enqueued_at))::float AS delay_seconds
        FROM pgmq.q_cron_sync_sub
        WHERE message->>'function_name' = 'cron_sync_sub'
          AND msg_id > $1
        ORDER BY msg_id`,
      [baselineMsgId],
    )

    expect(rows.length).toBeGreaterThan(0)
    rows.forEach((row: { delay_seconds: number }, index: number) => {
      expect(row.delay_seconds).toBeCloseTo(Math.floor(index / 60) * 60, -1)
    })
  })
})
