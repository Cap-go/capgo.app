import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  BASE_URL,
  getSupabaseClient,
  headersInternal,
  POSTGRES_URL,
  TEST_EMAIL,
  USER_ID,
} from './test-utils.ts'

const BASE_URL_TRIGGER = `${BASE_URL}/triggers`
const pool = new Pool({
  connectionString: POSTGRES_URL,
  max: 1,
  idleTimeoutMillis: 2000,
})

const WEBHOOK_QUEUE_TEST_ORG_ID = randomUUID()
const webhookName = `Webhook Queue Test ${randomUUID()}`
const customerId = `cus_webhook_queue_${randomUUID().replace(/-/g, '').slice(0, 20)}`
const dispatcherQueueName = `webhook_dispatcher_${randomUUID().replace(/-/g, '').slice(0, 12)}`
const deliveryQueueName = `webhook_delivery_${randomUUID().replace(/-/g, '').slice(0, 12)}`

let createdWebhookId: string | null = null

async function fetchQueueSync(queueName: string) {
  const response = await fetch(`${BASE_URL_TRIGGER}/queue_consumer/sync`, {
    method: 'POST',
    headers: headersInternal,
    body: JSON.stringify({
      queue_name: queueName,
      wait_for_completion: true,
    }),
  })

  expect(response.status).toBe(202)
  expect(await response.json()).toEqual({ status: 'ok' })
}

async function getDeliveryRecord(webhookId: string, recordId: string) {
  const { rows } = await pool.query(
    `SELECT *
     FROM public.webhook_deliveries
     WHERE webhook_id = $1
       AND request_payload->'data'->>'record_id' = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [webhookId, recordId],
  )

  expect(rows).toHaveLength(1)
  return rows[0]
}

async function getWebhookDeliveryQueueMessage(deliveryId: string) {
  const { rows } = await pool.query<{ msg_id: number | string, message: unknown }>(
    `SELECT msg_id, message
     FROM pgmq.q_webhook_delivery
     WHERE message->'payload'->>'delivery_id' = $1`,
    [deliveryId],
  )

  expect(rows).toHaveLength(1)
  return rows[0]
}

async function deleteWebhookDeliveryQueueMessage(msgId: number | string) {
  await pool.query('SELECT pgmq.delete($1::text, $2::bigint)', ['webhook_delivery', msgId])
}

async function getDeliveryAttempt(deliveryId: string) {
  const { rows } = await pool.query(
    'SELECT * FROM public.webhook_deliveries WHERE id = $1',
    [deliveryId],
  )

  expect(rows).toHaveLength(1)
  return rows[0]
}

describe('webhook queue processing', () => {
  beforeAll(async () => {
    await pool.query('SELECT pgmq.create($1)', [dispatcherQueueName])
    await pool.query('SELECT pgmq.create($1)', [deliveryQueueName])
    const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
      customer_id: customerId,
      status: 'succeeded',
      product_id: 'prod_LQIregjtNduh4q',
      subscription_id: `sub_${randomUUID()}`,
      trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      is_good_plan: true,
    })
    if (stripeError)
      throw stripeError

    const { error: orgError } = await getSupabaseClient().from('orgs').insert({
      id: WEBHOOK_QUEUE_TEST_ORG_ID,
      name: webhookName,
      management_email: TEST_EMAIL,
      created_by: USER_ID,
      customer_id: customerId,
    })
    if (orgError)
      throw orgError

    const { data: webhook, error: webhookError } = await (getSupabaseClient() as any)
      .from('webhooks')
      .insert({
        org_id: WEBHOOK_QUEUE_TEST_ORG_ID,
        name: webhookName,
        url: 'https://example.com/webhook',
        events: ['apps'],
        enabled: true,
        created_by: USER_ID,
      })
      .select()
      .single()

    if (webhookError)
      throw webhookError

    createdWebhookId = webhook.id
  })

  afterAll(async () => {
    if (createdWebhookId) {
      await (getSupabaseClient() as any).from('webhook_deliveries').delete().eq('webhook_id', createdWebhookId)
      await (getSupabaseClient() as any).from('webhooks').delete().eq('id', createdWebhookId)
    }

    await getSupabaseClient().from('orgs').delete().eq('id', WEBHOOK_QUEUE_TEST_ORG_ID)
    await getSupabaseClient().from('stripe_info').delete().eq('customer_id', customerId)
    if (createdWebhookId) {
      await pool.query(`DELETE FROM pgmq.q_webhook_delivery WHERE message->'payload'->>'webhook_id' = $1`, [createdWebhookId])
      await pool.query(`DELETE FROM pgmq.a_webhook_delivery WHERE message->'payload'->>'webhook_id' = $1`, [createdWebhookId])
    }

    for (const queueName of [dispatcherQueueName, deliveryQueueName]) {
      await pool.query(`DELETE FROM pgmq.q_${queueName}`)
      await pool.query(`DELETE FROM pgmq.a_${queueName}`)
      await pool.query('SELECT pgmq.drop_queue($1)', [queueName])
    }
    await pool.end()
  })

  it('dispatches and delivers webhook queue messages end to end', async () => {
    if (!createdWebhookId)
      throw new Error('Webhook was not created in setup')

    const recordId = `app_${randomUUID()}`
    const queueMessage = {
      function_name: 'webhook_dispatcher',
      function_type: 'cloudflare',
      payload: {
        audit_log_id: 999999,
        table_name: 'apps',
        operation: 'UPDATE',
        org_id: WEBHOOK_QUEUE_TEST_ORG_ID,
        record_id: recordId,
        old_record: { name: 'Before' },
        new_record: { name: 'After' },
        changed_fields: ['name'],
        user_id: USER_ID,
        created_at: new Date().toISOString(),
      },
    }

    await pool.query('SELECT pgmq.send($1, $2::jsonb)', [dispatcherQueueName, JSON.stringify(queueMessage)])

    await fetchQueueSync(dispatcherQueueName)
    const createdDelivery = await getDeliveryRecord(createdWebhookId, recordId)
    const queuedDelivery = await getWebhookDeliveryQueueMessage(createdDelivery.id)
    await deleteWebhookDeliveryQueueMessage(queuedDelivery.msg_id)

    expect(createdDelivery.event_type).toBe('apps.UPDATE')
    expect(createdDelivery.status).toBe('pending')

    await pool.query('SELECT pgmq.send($1, $2::jsonb)', [deliveryQueueName, JSON.stringify(queuedDelivery.message)])

    await fetchQueueSync(deliveryQueueName)
    const attemptedDelivery = await getDeliveryAttempt(createdDelivery.id)
    const retryDelivery = await getWebhookDeliveryQueueMessage(createdDelivery.id)
    await deleteWebhookDeliveryQueueMessage(retryDelivery.msg_id)

    expect(attemptedDelivery.status).toBe('pending')
    expect(attemptedDelivery.attempt_count).toBe(1)
    expect(attemptedDelivery.response_status).toBe(405)
    expect(attemptedDelivery.next_retry_at).toBeTruthy()
    expect(attemptedDelivery.response_body).toBeTruthy()
  })
})
