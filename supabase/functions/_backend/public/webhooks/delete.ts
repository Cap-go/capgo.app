import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import { z } from 'zod'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { simpleError } from '../../utils/hono.ts'
import { supabaseAdmin } from '../../utils/supabase.ts'
import { checkWebhookPermissionV2 } from './index.ts'

const bodySchema = z.object({
  orgId: z.string(),
  webhookId: z.string(),
})

export async function deleteWebhook(c: Context<MiddlewareKeyVariables, any, any>, bodyRaw: any, auth: AuthInfo): Promise<Response> {
  const bodyParsed = safeParseSchema(bodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data

  await checkWebhookPermissionV2(c, body.orgId, auth)

  const supabase = supabaseAdmin(c)

  // Verify webhook belongs to org
  const { data: existingWebhook, error: fetchError } = await supabase
    .from('webhooks')
    .select('id, org_id')
    .eq('id', body.webhookId)
    .single()

  if (fetchError || !existingWebhook) {
    throw simpleError('webhook_not_found', 'Webhook not found', { webhookId: body.webhookId })
  }

  if (existingWebhook.org_id !== body.orgId) {
    throw simpleError('no_permission', 'Webhook does not belong to this organization', { webhookId: body.webhookId })
  }

  // Delete webhook (cascade will delete deliveries)
  const { error } = await supabase
    .from('webhooks')
    .delete()
    .eq('id', body.webhookId)

  if (error) {
    throw simpleError('cannot_delete_webhook', 'Cannot delete webhook', { error })
  }

  return c.json({
    status: 'Webhook deleted',
    webhookId: body.webhookId,
  })
}
