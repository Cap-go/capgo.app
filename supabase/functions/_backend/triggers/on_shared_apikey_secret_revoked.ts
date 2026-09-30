import { z } from 'zod'
import { isBentoConfigured, trackBentoRecipientEvents } from '../utils/bento.ts'
import { BRES, createHono, middlewareAPISecret, quickError, simpleError, triggerValidator } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { getEnv } from '../utils/utils.ts'
import { version } from '../utils/version.ts'

export const SHARED_APIKEY_ROTATED_EVENT = 'org:shared_apikey_rotated'

const revokedPayloadSchema = z.object({
  owner_org_id: z.uuid(),
  apikeys: z.array(z.object({
    id: z.number(),
    name: z.string(),
    previous_recipient_user_id: z.uuid().nullable(),
  })).min(1).optional(),
  after_user_id: z.uuid().optional(),
}).refine(data => !!data.apikeys || !!data.after_user_id)

const RECIPIENT_BATCH_SIZE = 100

export const app = createHono('', version)

// Shared key secrets are revoked in the database when the member who received
// them loses or changes access. Tell every remaining member so someone with
// API key rights regenerates the key before automation silently fails. This is
// a security notice, so it ignores email preferences.
app.post('/', middlewareAPISecret, triggerValidator('apikeys', 'UPDATE'), async (c) => {
  const parsed = revokedPayloadSchema.safeParse(c.get('webhookBody'))
  if (!parsed.success)
    throw simpleError('invalid_payload', 'Invalid shared API key revocation payload', { issues: parsed.error.issues })

  if (!isBentoConfigured(c))
    return c.json(BRES)

  const { owner_org_id: orgId, after_user_id: afterUserId } = parsed.data

  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    // Primary, not a replica: the removal that triggered this must be visible.
    pgClient = getPgClient(c)
    const { rows: orgRows } = await pgClient.query<{ name: string }>(
      'SELECT name FROM public.orgs WHERE id = $1::uuid',
      [orgId],
    )
    const org = orgRows[0]
    if (!org) {
      cloudlog({ requestId: c.get('requestId'), message: 'on_shared_apikey_secret_revoked: org not found', orgId })
      return c.json(BRES)
    }

    // Start with indexed org-scope bindings, never all users or app grants.
    const { rows: memberRows } = await pgClient.query<{ id: string, email: string }>(
      `
      WITH member_ids AS (
        SELECT rb.principal_id AS user_id
        FROM public.role_bindings rb
        WHERE rb.scope_type = public.rbac_scope_org()
          AND rb.principal_type = public.rbac_principal_user()
          AND rb.org_id = $1::uuid
          AND ($2::uuid IS NULL OR rb.principal_id > $2::uuid)
          AND (rb.expires_at IS NULL OR rb.expires_at > now())
        UNION
        SELECT gm.user_id
        FROM public.role_bindings rb
        JOIN public.groups g ON g.id = rb.principal_id AND g.org_id = rb.org_id
        JOIN public.group_members gm ON gm.group_id = rb.principal_id
        WHERE rb.scope_type = public.rbac_scope_org()
          AND rb.principal_type = public.rbac_principal_group()
          AND rb.org_id = $1::uuid
          AND ($2::uuid IS NULL OR gm.user_id > $2::uuid)
          AND (rb.expires_at IS NULL OR rb.expires_at > now())
      )
      SELECT users.id, lower(users.email) AS email
      FROM member_ids
      JOIN public.users ON users.id = member_ids.user_id
      WHERE users.email IS NOT NULL
        AND ($2::uuid IS NULL OR users.id > $2::uuid)
      ORDER BY users.id
      LIMIT $3
      `,
      [orgId, afterUserId ?? null, RECIPIENT_BATCH_SIZE + 1],
    )
    const recipients = memberRows.slice(0, RECIPIENT_BATCH_SIZE)

    const baseUrl = (getEnv(c, 'WEBAPP_URL') || '').replace(/\/+$/, '')
    const eventData = {
      org_id: orgId,
      org_name: org.name,
      apikeys_url: baseUrl ? `${baseUrl}/apikeys?ownership=shared&org=${orgId}` : '',
    }

    // All org members need this actionable automation notice. Key metadata and
    // former holder identities remain behind the console's API key permissions.
    const accepted = await trackBentoRecipientEvents(c, recipients.map(row => ({
      email: row.email,
      data: eventData,
      event: SHARED_APIKEY_ROTATED_EVENT,
    })), AbortSignal.timeout(8000))
    if (!accepted)
      quickError(503, 'notification_delivery_failed', 'Shared API key notice delivery failed')

    if (memberRows.length > RECIPIENT_BATCH_SIZE) {
      // Continue successful pages with a fresh queue message; retries only repeat
      // the current page. A crash between delivery and enqueue can duplicate it.
      await pgClient.query('SELECT pgmq.send($1::text, $2::jsonb, $3::integer)', [
        'on_shared_apikey_secret_revoked',
        JSON.stringify({
          function_name: 'on_shared_apikey_secret_revoked',
          function_type: 'cloudflare',
          payload: {
            type: 'UPDATE',
            table: 'apikeys',
            schema: 'public',
            old_record: null,
            record: { owner_org_id: orgId, after_user_id: recipients[recipients.length - 1].id },
          },
        }),
        1,
      ])
    }

    cloudlog({
      requestId: c.get('requestId'),
      message: 'on_shared_apikey_secret_revoked: notified',
      orgId,
      recipients: recipients.length,
    })
  }
  finally {
    if (pgClient)
      await closeClient(c, pgClient)
  }

  return c.json(BRES)
})
