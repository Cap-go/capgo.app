import { z } from 'zod'
import { isBentoConfigured, trackBentoEvent } from '../utils/bento.ts'
import { BRES, createHono, middlewareAPISecret, simpleError, triggerValidator } from '../utils/hono.ts'
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
  })).min(1),
})

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

  const { owner_org_id: orgId, apikeys } = parsed.data
  const previousRecipientIds = [...new Set(apikeys.map(key => key.previous_recipient_user_id).filter((id): id is string => !!id))]

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

    // Current members only: a removed member no longer has an org binding.
    const [{ rows: memberRows }, { rows: previousRows }] = await Promise.all([
      pgClient.query<{ email: string }>(
        `
        SELECT DISTINCT lower(users.email) AS email
        FROM public.users
        WHERE users.email IS NOT NULL
          AND users.id IN (
            SELECT rb.principal_id
            FROM public.role_bindings rb
            WHERE rb.principal_type = public.rbac_principal_user()
              AND rb.org_id = $1::uuid
              AND (rb.expires_at IS NULL OR rb.expires_at > now())

            UNION

            SELECT gm.user_id
            FROM public.group_members gm
            JOIN public.groups g ON g.id = gm.group_id AND g.org_id = $1::uuid
            JOIN public.role_bindings rb
              ON rb.principal_type = public.rbac_principal_group()
              AND rb.principal_id = gm.group_id
              AND rb.org_id = g.org_id
            WHERE rb.expires_at IS NULL OR rb.expires_at > now()
          )
        `,
        [orgId],
      ),
      previousRecipientIds.length > 0
        ? pgClient.query<{ email: string }>(
            'SELECT email FROM public.users WHERE id = ANY($1::uuid[]) AND email IS NOT NULL',
            [previousRecipientIds],
          )
        : Promise.resolve({ rows: [] as { email: string }[] }),
    ])

    const baseUrl = (getEnv(c, 'WEBAPP_URL') || '').replace(/\/+$/, '')
    const eventData = {
      org_id: orgId,
      org_name: org.name,
      apikey_count: apikeys.length,
      apikey_names: apikeys.map(key => key.name),
      apikey_ids: apikeys.map(key => key.id),
      previous_holder_emails: previousRows.map(row => row.email),
      apikeys_url: baseUrl ? `${baseUrl}/apikeys?ownership=shared&org=${orgId}` : '',
    }

    await Promise.all(memberRows.map(row => trackBentoEvent(c, row.email, eventData, SHARED_APIKEY_ROTATED_EVENT)))

    cloudlog({
      requestId: c.get('requestId'),
      message: 'on_shared_apikey_secret_revoked: notified',
      orgId,
      apikeyCount: apikeys.length,
      recipients: memberRows.length,
    })
  }
  finally {
    if (pgClient)
      await closeClient(c, pgClient)
  }

  return c.json(BRES)
})
