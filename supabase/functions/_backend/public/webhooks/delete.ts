import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import { z } from 'zod'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { simpleError } from '../../utils/hono.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { checkWebhookPermissionV2 } from './index.ts'

const bodySchema = z.object({
  orgId: z.string(),
  webhookId: z.string(),
})

export async function deleteWebhook(c: Context<MiddlewareKeyVariables>, bodyRaw: unknown, auth: AuthInfo): Promise<Response> {
  const bodyParsed = safeParseSchema(bodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data

  await checkWebhookPermissionV2(c, body.orgId, auth)

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

    // Delete webhook (cascade will delete deliveries)
    try {
      await pg.query('DELETE FROM public.webhooks WHERE id = $1', [body.webhookId])
    }
    catch (error) {
      throw simpleError('cannot_delete_webhook', 'Cannot delete webhook', { error })
    }
  }
  finally {
    closeClient(c, pg)
  }

  return c.json({
    status: 'Webhook deleted',
    webhookId: body.webhookId,
  })
}
