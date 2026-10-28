import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { WebhookDeliveryPayload } from '../../utils/webhook.ts'
import { z } from 'zod'
import { numberLikeSchema, safeParseSchema } from '../../utils/schema_validation.ts'
import { simpleError } from '../../utils/hono.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { queryJson, queryJsonOne } from '../../utils/pg_rls.ts'
import {
  getDeliveryById,
  getWebhookById,
  getWebhookLogUrlMetadata,
  getWebhookPublicUrlValidationError,
  queueWebhookDelivery,
} from '../../utils/webhook.ts'
import { checkWebhookPermissionV2 } from './index.ts'

const getDeliveriesSchema = z.object({
  orgId: z.string(),
  webhookId: z.string(),
  page: numberLikeSchema.optional(),
  status: z.string().optional(),
})

const retryDeliverySchema = z.object({
  orgId: z.string(),
  deliveryId: z.string(),
})

const DELIVERIES_PER_PAGE = 50

export async function getDeliveries(c: Context<MiddlewareKeyVariables>, bodyRaw: unknown, auth: AuthInfo): Promise<Response> {
  const bodyParsed = safeParseSchema(getDeliveriesSchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data

  await checkWebhookPermissionV2(c, body.orgId, auth)

  // Direct RLS access to webhook tables is intentionally denied; use service-role only after explicit permission checks.
  const pg = await getPgClient(c)
  try {
    // Verify webhook belongs to org
    const webhook = await pg.query<{ id: string, org_id: string }>('SELECT id, org_id FROM public.webhooks WHERE id = $1', [body.webhookId])
      .then(result => result.rows[0] ?? null)
      .catch(() => null)

    if (!webhook) {
      throw simpleError('webhook_not_found', 'Webhook not found', { webhookId: body.webhookId })
    }

    if (webhook.org_id !== body.orgId) {
      throw simpleError('no_permission', 'Webhook does not belong to this organization', { webhookId: body.webhookId })
    }

    // Build query
    const page = body.page ?? 0
    const from = page * DELIVERIES_PER_PAGE

    // Apply status filter before ordering and pagination
    const where = body.status ? 'webhook_id = $1 AND status = $2' : 'webhook_id = $1'
    const filterParams: unknown[] = body.status ? [body.webhookId, body.status] : [body.webhookId]

    let data: unknown[]
    try {
      data = await queryJson(
        pg,
        `SELECT * FROM public.webhook_deliveries WHERE ${where} ORDER BY created_at DESC LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
        [...filterParams, DELIVERIES_PER_PAGE, from],
      )
    }
    catch (error) {
      throw simpleError('cannot_get_deliveries', 'Cannot get deliveries', { error })
    }

    // Get total count for pagination (include status filter)
    const count = await queryJsonOne<{ count: number }>(pg, `SELECT count(*)::int AS count FROM public.webhook_deliveries WHERE ${where}`, filterParams)
      .then(row => row?.count ?? null)
      .catch(() => null)

    const totalCount = count ?? 0
    const nextPageStart = (page + 1) * DELIVERIES_PER_PAGE

    return c.json({
      deliveries: data,
      pagination: {
        page,
        per_page: DELIVERIES_PER_PAGE,
        total: totalCount,
        has_more: nextPageStart < totalCount,
      },
    })
  }
  finally {
    closeClient(c, pg)
  }
}

export async function retryDelivery(c: Context<MiddlewareKeyVariables>, bodyRaw: unknown, auth: AuthInfo): Promise<Response> {
  const bodyParsed = safeParseSchema(retryDeliverySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data

  await checkWebhookPermissionV2(c, body.orgId, auth)

  // Get delivery
  const delivery = await getDeliveryById(c, body.deliveryId)
  if (!delivery) {
    throw simpleError('delivery_not_found', 'Delivery not found', { deliveryId: body.deliveryId })
  }

  if (delivery.org_id !== body.orgId) {
    throw simpleError('no_permission', 'Delivery does not belong to this organization', { deliveryId: body.deliveryId })
  }

  // Can only retry failed deliveries. Pending deliveries are already queued or in flight.
  if (delivery.status !== 'failed') {
    throw simpleError('delivery_not_failed', 'Only failed deliveries can be retried', {
      deliveryId: body.deliveryId,
      status: delivery.status,
    })
  }

  // Get webhook for URL
  const webhook = await getWebhookById(c, delivery.webhook_id)
  if (!webhook) {
    throw simpleError('webhook_not_found', 'Associated webhook not found')
  }

  if (!webhook.enabled) {
    throw simpleError('webhook_disabled', 'Webhook is disabled')
  }

  const urlError = await getWebhookPublicUrlValidationError(c, webhook.url)
  if (urlError)
    throw simpleError('invalid_url', urlError, { urlInfo: getWebhookLogUrlMetadata(webhook.url) })

  // Reset delivery status and queue for retry
  const pg = await getPgClient(c)
  try {
    await pg.query(
      `UPDATE public.webhook_deliveries
       SET status = 'pending', attempt_count = 0, response_status = NULL, response_body = NULL, completed_at = NULL, duration_ms = NULL, next_retry_at = NULL
       WHERE id = $1`,
      [body.deliveryId],
    )
  }
  catch (updateError) {
    throw simpleError('cannot_reset_delivery', 'Cannot reset delivery for retry', {
      deliveryId: body.deliveryId,
      error: updateError,
    })
  }
  finally {
    closeClient(c, pg)
  }

  // Queue for immediate delivery
  await queueWebhookDelivery(
    c,
    delivery.id,
    webhook.id,
    webhook.url,
    delivery.request_payload as WebhookDeliveryPayload,
  )

  return c.json({
    status: 'Delivery queued for retry',
    deliveryId: body.deliveryId,
  })
}
