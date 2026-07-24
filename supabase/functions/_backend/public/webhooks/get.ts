import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import { z } from 'zod'
import { numberLikeSchema, safeParseSchema } from '../../utils/schema_validation.ts'
import { simpleError } from '../../utils/hono.ts'
import { supabaseAdmin } from '../../utils/supabase.ts'
import { fetchLimit } from '../../utils/utils.ts'
import { checkWebhookPermissionV2 } from './index.ts'
import { webhookPublicSchema, webhookPublicSelect, webhooksPublicSchema } from './response.ts'

const bodySchema = z.object({
  orgId: z.string(),
  webhookId: z.string().optional(),
  page: numberLikeSchema.optional(),
})

export async function get(c: Context<MiddlewareKeyVariables, any, any>, bodyRaw: any, auth: AuthInfo): Promise<Response> {
  const bodyParsed = safeParseSchema(bodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data

  await checkWebhookPermissionV2(c, body.orgId, auth)
  // Direct RLS access to webhook tables is intentionally denied; use service-role only after explicit permission checks.
  const supabase = supabaseAdmin(c)

  // Get single webhook
  if (body.webhookId) {
    const { data, error } = await supabase
      .from('webhooks')
      .select(webhookPublicSelect)
      .eq('id', body.webhookId)
      .eq('org_id', body.orgId)
      .single()

    if (error) {
      throw simpleError('webhook_not_found', 'Webhook not found', { error })
    }

    const dataParsed = safeParseSchema(webhookPublicSchema, data)
    if (!dataParsed.success) {
      throw simpleError('cannot_parse_webhook', 'Cannot parse webhook', { error: dataParsed.error })
    }

    // Get recent delivery stats for this webhook
    const { data: stats } = await supabase
      .from('webhook_deliveries')
      .select('status', { count: 'exact' })
      .eq('webhook_id', body.webhookId)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())

    const successCount = stats?.filter((s: any) => s.status === 'success').length || 0
    const failedCount = stats?.filter((s: any) => s.status === 'failed').length || 0
    const pendingCount = stats?.filter((s: any) => s.status === 'pending').length || 0

    return c.json({
      ...dataParsed.data,
      stats_24h: {
        success: successCount,
        failed: failedCount,
        pending: pendingCount,
      },
    })
  }

  // List all webhooks for org
  const fetchOffset = body.page ?? 0
  const from = fetchOffset * fetchLimit
  const to = (fetchOffset + 1) * fetchLimit - 1

  const { data, error } = await supabase
    .from('webhooks')
    .select(webhookPublicSelect)
    .eq('org_id', body.orgId)
    .order('created_at', { ascending: false })
    .range(from, to)

  if (error) {
    throw simpleError('cannot_get_webhooks', 'Cannot get webhooks', { error })
  }

  const dataParsed = safeParseSchema(webhooksPublicSchema, data)
  if (!dataParsed.success) {
    throw simpleError('cannot_parse_webhooks', 'Cannot parse webhooks', { error: dataParsed.error })
  }

  return c.json(dataParsed.data)
}
