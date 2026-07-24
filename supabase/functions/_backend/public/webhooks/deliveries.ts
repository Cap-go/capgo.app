import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { WebhookDeliveryPayload } from '../../utils/webhook.ts'
import { z } from 'zod'
import { numberLikeSchema, safeParseSchema } from '../../utils/schema_validation.ts'
import { simpleError } from '../../utils/hono.ts'
import { supabaseAdmin } from '../../utils/supabase.ts'
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

export async function getDeliveries(c: Context<MiddlewareKeyVariables, any, any>, bodyRaw: any, auth: AuthInfo): Promise<Response> {
  const bodyParsed = safeParseSchema(getDeliveriesSchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data

  await checkWebhookPermissionV2(c, body.orgId, auth)

  // Direct RLS access to webhook tables is intentionally denied; use service-role only after explicit permission checks.
  const supabase = supabaseAdmin(c)

  // Verify webhook belongs to org
  const { data: webhook, error: webhookError } = await supabase
    .from('webhooks')
    .select('id, org_id')
    .eq('id', body.webhookId)
    .single()

  if (webhookError || !webhook) {
    throw simpleError('webhook_not_found', 'Webhook not found', { webhookId: body.webhookId })
  }

  if (webhook.org_id !== body.orgId) {
    throw simpleError('no_permission', 'Webhook does not belong to this organization', { webhookId: body.webhookId })
  }

  // Build query
  const page = body.page ?? 0
  const from = page * DELIVERIES_PER_PAGE
  const to = (page + 1) * DELIVERIES_PER_PAGE - 1

  let query = supabase
    .from('webhook_deliveries')
    .select('*')
    .eq('webhook_id', body.webhookId)

  // Apply status filter before ordering and pagination
  if (body.status) {
    query = query.eq('status', body.status)
  }

  query = query.order('created_at', { ascending: false }).range(from, to)

  const { data, error } = await query

  if (error) {
    throw simpleError('cannot_get_deliveries', 'Cannot get deliveries', { error })
  }

  // Get total count for pagination (include status filter)
  let countQuery = supabase
    .from('webhook_deliveries')
    .select('*', { count: 'exact', head: true })
    .eq('webhook_id', body.webhookId)

  if (body.status) {
    countQuery = countQuery.eq('status', body.status)
  }

  const { count } = await countQuery

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

export async function retryDelivery(c: Context<MiddlewareKeyVariables, any, any>, bodyRaw: any, auth: AuthInfo): Promise<Response> {
  const bodyParsed = safeParseSchema(retryDeliverySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data

  await checkWebhookPermissionV2(c, body.orgId, auth)

  const supabase = supabaseAdmin(c)

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
  const { error: updateError } = await supabase
    .from('webhook_deliveries')
    .update({
      status: 'pending',
      attempt_count: 0,
      response_status: null,
      response_body: null,
      completed_at: null,
      duration_ms: null,
      next_retry_at: null,
    })
    .eq('id', body.deliveryId)

  if (updateError) {
    throw simpleError('cannot_reset_delivery', 'Cannot reset delivery for retry', {
      deliveryId: body.deliveryId,
      error: updateError,
    })
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
