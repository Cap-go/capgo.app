import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import type { WebhookDeliveryVersion } from '../../utils/webhook.ts'
import { z } from 'zod'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { simpleError } from '../../utils/hono.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { queryJsonOne } from '../../utils/pg_rls.ts'
import { getWebhookLogUrlMetadata, getWebhookPublicUrlValidationError, isWebhookEventType, parseWebhookDeliveryVersion, WEBHOOK_EVENT_TYPES } from '../../utils/webhook.ts'
import { checkWebhookPermissionV2 } from './index.ts'
import { webhookPublicSelect } from './response.ts'

const bodySchema = z.object({
  orgId: z.string(),
  webhookId: z.string(),
  name: z.string().min(1).optional(),
  url: z.url().optional(),
  events: z.array(z.string()).min(1).optional(),
  enabled: z.boolean().optional(),
  deliveryVersion: z.string().optional(),
  delivery_version: z.string().optional(),
})

interface PutWebhookBody {
  orgId: string
  webhookId: string
  name?: string
  url?: string
  events?: string[]
  enabled?: boolean
  deliveryVersion?: string
  delivery_version?: string
}

function parseRequestedDeliveryVersion(requestedDeliveryVersion: string | undefined): WebhookDeliveryVersion | undefined {
  if (requestedDeliveryVersion === undefined)
    return undefined

  const deliveryVersion = parseWebhookDeliveryVersion(requestedDeliveryVersion)
  if (!deliveryVersion) {
    throw simpleError('invalid_delivery_version', 'Invalid webhook delivery version', {
      allowed: ['legacy', 'standard'],
    })
  }

  return deliveryVersion
}

function validateEvents(events: string[] | undefined): void {
  if (!events)
    return

  const invalidEvents = events.filter(e => !isWebhookEventType(e))
  if (invalidEvents.length > 0) {
    throw simpleError('invalid_events', 'Invalid event types', {
      invalid: invalidEvents,
      allowed: WEBHOOK_EVENT_TYPES,
    })
  }
}

async function validateWebhookUrl(c: Context<MiddlewareKeyVariables>, url: string | undefined): Promise<void> {
  if (!url)
    return

  const urlError = await getWebhookPublicUrlValidationError(c, url)
  if (urlError)
    throw simpleError('invalid_url', urlError, { urlInfo: getWebhookLogUrlMetadata(url) })
}

function buildWebhookUpdateData(
  body: PutWebhookBody,
  deliveryVersion: WebhookDeliveryVersion | undefined,
): Database['public']['Tables']['webhooks']['Update'] {
  const updateData: Database['public']['Tables']['webhooks']['Update'] = {}
  if (body.name !== undefined)
    updateData.name = body.name
  if (body.url !== undefined)
    updateData.url = body.url
  if (body.events !== undefined)
    updateData.events = body.events
  if (body.enabled !== undefined)
    updateData.enabled = body.enabled
  if (deliveryVersion !== undefined)
    updateData.delivery_version = deliveryVersion

  return updateData
}

export async function put(c: Context<MiddlewareKeyVariables>, bodyRaw: unknown, auth: AuthInfo): Promise<Response> {
  const bodyParsed = safeParseSchema(bodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data as PutWebhookBody

  await checkWebhookPermissionV2(c, body.orgId, auth)
  const deliveryVersion = parseRequestedDeliveryVersion(body.deliveryVersion ?? body.delivery_version)

  // Direct RLS access to webhook tables is intentionally denied; use service-role only after explicit permission checks.
  const pg = await getPgClient(c)
  try {
    // Verify webhook belongs to org
    const existingWebhook = await pg.query<{ id: string, org_id: string }>('SELECT id, org_id FROM public.webhooks WHERE id = $1', [body.webhookId])
      .then(result => result.rows[0] ?? null)
      .catch(() => null)

    if (!existingWebhook) {
      throw simpleError('webhook_not_found', 'Webhook not found', { webhookId: body.webhookId })
    }

    if (existingWebhook.org_id !== body.orgId) {
      throw simpleError('no_permission', 'Webhook does not belong to this organization', { webhookId: body.webhookId })
    }

    validateEvents(body.events)
    await validateWebhookUrl(c, body.url)

    // Build update object
    const updateData = buildWebhookUpdateData(body, deliveryVersion)
    if (Object.keys(updateData).length === 0) {
      throw simpleError('no_updates', 'No fields to update')
    }

    // Update webhook. Column names come from buildWebhookUpdateData's fixed keys only.
    const columns = Object.keys(updateData) as (keyof typeof updateData)[]
    let data: unknown = null
    let error: unknown = null
    try {
      data = await queryJsonOne(
        pg,
        `UPDATE public.webhooks SET ${columns.map((column, index) => `${column} = $${index + 2}`).join(', ')} WHERE id = $1 RETURNING ${webhookPublicSelect}`,
        [body.webhookId, ...columns.map(column => updateData[column])],
      )
    }
    catch (updateError) {
      error = updateError
    }

    if (error || !data) {
      throw simpleError('cannot_update_webhook', 'Cannot update webhook', { error })
    }

    return c.json({
      status: 'Webhook updated',
      webhook: data,
    })
  }
  finally {
    closeClient(c, pg)
  }
}
