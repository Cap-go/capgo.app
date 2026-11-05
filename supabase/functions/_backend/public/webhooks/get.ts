import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import { z } from 'zod'
import { numberLikeSchema, safeParseSchema } from '../../utils/schema_validation.ts'
import { simpleError } from '../../utils/hono.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { queryJson, queryJsonOne } from '../../utils/pg_rls.ts'
import { fetchLimit } from '../../utils/utils.ts'
import { checkWebhookPermissionV2 } from './index.ts'
import { webhookPublicSchema, webhookPublicSelect, webhooksPublicSchema } from './response.ts'

const bodySchema = z.object({
  orgId: z.string(),
  webhookId: z.string().optional(),
  page: numberLikeSchema.optional(),
})

export async function get(c: Context<MiddlewareKeyVariables>, bodyRaw: unknown, auth: AuthInfo): Promise<Response> {
  const bodyParsed = safeParseSchema(bodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data

  await checkWebhookPermissionV2(c, body.orgId, auth)
  // Direct RLS access to webhook tables is intentionally denied; use service-role only after explicit permission checks.
  const pg = await getPgClient(c)
  try {
    // Get single webhook
    if (body.webhookId) {
      let data: unknown = null
      try {
        data = await queryJsonOne(pg, `SELECT ${webhookPublicSelect} FROM public.webhooks WHERE id = $1 AND org_id = $2`, [body.webhookId, body.orgId])
      }
      catch (error) {
        throw simpleError('webhook_not_found', 'Webhook not found', { error })
      }
      if (!data) {
        throw simpleError('webhook_not_found', 'Webhook not found', { error: null })
      }

      const dataParsed = safeParseSchema(webhookPublicSchema, data)
      if (!dataParsed.success) {
        throw simpleError('cannot_parse_webhook', 'Cannot parse webhook', { error: dataParsed.error })
      }

      // Get recent delivery stats for this webhook. Counts only the first 1000 rows, the
      // PostgREST max_rows this endpoint was bounded by.
      const stats = await queryJsonOne<{ success: number, failed: number, pending: number }>(
        pg,
        `SELECT
           count(*) FILTER (WHERE status = 'success')::int AS success,
           count(*) FILTER (WHERE status = 'failed')::int AS failed,
           count(*) FILTER (WHERE status = 'pending')::int AS pending
         FROM (
           SELECT status
           FROM public.webhook_deliveries
           WHERE webhook_id = $1
             AND created_at >= $2
           LIMIT 1000
         ) recent`,
        [body.webhookId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()],
      ).catch(() => null)

      return c.json({
        ...dataParsed.data,
        stats_24h: {
          success: stats?.success || 0,
          failed: stats?.failed || 0,
          pending: stats?.pending || 0,
        },
      })
    }

    // List all webhooks for org
    const fetchOffset = body.page ?? 0
    const from = fetchOffset * fetchLimit

    let data: unknown[]
    try {
      data = await queryJson(
        pg,
        `SELECT ${webhookPublicSelect} FROM public.webhooks WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [body.orgId, fetchLimit, from],
      )
    }
    catch (error) {
      throw simpleError('cannot_get_webhooks', 'Cannot get webhooks', { error })
    }

    const dataParsed = safeParseSchema(webhooksPublicSchema, data)
    if (!dataParsed.success) {
      throw simpleError('cannot_parse_webhooks', 'Cannot parse webhooks', { error: dataParsed.error })
    }

    return c.json(dataParsed.data)
  }
  finally {
    closeClient(c, pg)
  }
}
