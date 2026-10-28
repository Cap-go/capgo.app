import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { z } from 'zod'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { simpleError } from '../../utils/hono.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { queryJsonOne } from '../../utils/pg_rls.ts'
import {
  createDeliveryRecord,
  createTestPayload,
  deliverWebhook,
  getWebhookLogUrlMetadata,
  getWebhookPublicUrlValidationError,
  normalizeWebhookDeliveryVersion,
  updateDeliveryResult,
} from '../../utils/webhook.ts'
import { checkWebhookPermissionV2 } from './index.ts'

const bodySchema = z.object({
  orgId: z.string(),
  webhookId: z.string(),
})

async function getWebhookForTest(c: Context<MiddlewareKeyVariables>, webhookId: string) {
  const pg = await getPgClient(c)
  try {
    return await queryJsonOne<Database['public']['Tables']['webhooks']['Row']>(pg, 'SELECT * FROM public.webhooks WHERE id = $1', [webhookId])
  }
  catch {
    return null
  }
  finally {
    closeClient(c, pg)
  }
}

export async function test(c: Context<MiddlewareKeyVariables>, bodyRaw: unknown, auth: AuthInfo): Promise<Response> {
  const bodyParsed = safeParseSchema(bodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data

  await checkWebhookPermissionV2(c, body.orgId, auth)

  // Get webhook
  const webhook = await getWebhookForTest(c, body.webhookId)

  if (!webhook) {
    throw simpleError('webhook_not_found', 'Webhook not found', { webhookId: body.webhookId })
  }

  if (webhook.org_id !== body.orgId) {
    throw simpleError('no_permission', 'Webhook does not belong to this organization', { webhookId: body.webhookId })
  }

  const urlError = await getWebhookPublicUrlValidationError(c, webhook.url)
  if (urlError)
    throw simpleError('invalid_url', urlError, { urlInfo: getWebhookLogUrlMetadata(webhook.url) })

  // Create test payload
  const payload = createTestPayload(body.orgId)
  const deliveryVersion = normalizeWebhookDeliveryVersion(webhook.delivery_version)

  // Create delivery record for the test
  const delivery = await createDeliveryRecord(
    c,
    webhook.id,
    webhook.org_id,
    null, // No audit_log_id for test events
    'test.ping',
    payload,
    deliveryVersion,
  )

  if (!delivery) {
    throw simpleError('cannot_create_delivery', 'Cannot create delivery record')
  }

  // Immediately deliver the test webhook (bypass queue)
  const result = await deliverWebhook(c, delivery.id, webhook.url, payload, webhook.secret, deliveryVersion)

  // Update delivery record with result
  await updateDeliveryResult(
    c,
    delivery.id,
    result.success,
    result.status || null,
    result.body || null,
    result.duration || 0,
  )

  // Update attempt count
  const pg = await getPgClient(c)
  try {
    await pg.query('UPDATE public.webhook_deliveries SET attempt_count = 1 WHERE id = $1', [delivery.id])
  }
  catch {
    throw simpleError('cannot_update_delivery', 'Cannot update delivery attempt count', {
      deliveryId: delivery.id,
    })
  }
  finally {
    closeClient(c, pg)
  }

  return c.json({
    success: result.success,
    status: result.status,
    duration_ms: result.duration,
    response_preview: result.body?.slice(0, 500),
    delivery_id: delivery.id,
    message: result.success
      ? 'Test webhook delivered successfully'
      : 'Test webhook delivery failed',
  })
}
