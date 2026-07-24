import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import { z } from 'zod'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { simpleError } from '../../utils/hono.ts'
import { supabaseAdmin } from '../../utils/supabase.ts'
import { getWebhookLogUrlMetadata, getWebhookPublicUrlValidationError, parseWebhookDeliveryVersion, WEBHOOK_EVENT_TYPES } from '../../utils/webhook.ts'
import { checkWebhookPermissionV2 } from './index.ts'
import { webhookCreatedSelect } from './response.ts'

const bodySchema = z.object({
  orgId: z.string(),
  name: z.string().min(1),
  url: z.url(),
  events: z.array(z.string()).min(1),
  enabled: z.boolean().optional(),
  deliveryVersion: z.string().optional(),
  delivery_version: z.string().optional(),
})

export async function post(c: Context<MiddlewareKeyVariables, any, any>, bodyRaw: any, auth: AuthInfo): Promise<Response> {
  const bodyParsed = safeParseSchema(bodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data

  await checkWebhookPermissionV2(c, body.orgId, auth)

  const deliveryVersion = parseWebhookDeliveryVersion(body.deliveryVersion ?? body.delivery_version ?? 'legacy')
  if (!deliveryVersion) {
    throw simpleError('invalid_delivery_version', 'Invalid webhook delivery version', {
      allowed: ['legacy', 'standard'],
    })
  }

  // Validate events are allowed
  const invalidEvents = body.events.filter(e => !WEBHOOK_EVENT_TYPES.includes(e as any))
  if (invalidEvents.length > 0) {
    throw simpleError('invalid_events', 'Invalid event types', {
      invalid: invalidEvents,
      allowed: WEBHOOK_EVENT_TYPES,
    })
  }

  const urlError = await getWebhookPublicUrlValidationError(c, body.url)
  if (urlError)
    throw simpleError('invalid_url', urlError, { urlInfo: getWebhookLogUrlMetadata(body.url) })

  // Direct RLS access to webhook tables is intentionally denied; use service-role only after explicit permission checks.
  const { data, error } = await supabaseAdmin(c)
    .from('webhooks')
    .insert({
      org_id: body.orgId,
      name: body.name,
      url: body.url,
      events: body.events,
      enabled: body.enabled ?? true,
      delivery_version: deliveryVersion,
      created_by: auth.userId,
    })
    // Return the secret once on creation so admins can store it; read/update endpoints never expose it.
    .select(webhookCreatedSelect)
    .single()

  if (error) {
    throw simpleError('cannot_create_webhook', 'Cannot create webhook', { error })
  }

  return c.json({
    status: 'Webhook created',
    webhook: data,
  }, 201)
}
