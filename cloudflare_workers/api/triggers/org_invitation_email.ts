import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../../supabase/functions/_backend/utils/hono.ts'
import type { PgQueryClient } from '../../../supabase/functions/_backend/utils/pg.ts'
import { cloudlog } from '../../../supabase/functions/_backend/utils/logging.ts'
import { closeClient, getPgClient, withPgTransaction } from '../../../supabase/functions/_backend/utils/pg.ts'
import { getEnv, trimTrailingSlashes } from '../../../supabase/functions/_backend/utils/utils.ts'
import { renderOrgInvitationEmail } from '../email_templates/org_invite.ts'
import { sendCloudflareEmail } from '../email_templates/send.ts'

export interface OrgInvitation {
  id: string
  org_id: string
  recipient_user_id: string | null
  org_user_id: string | null
  tmp_user_id: number | null
  sent_at: string | null
  bento_synced_at: string | null
  bento_email: string | null
  is_pending: boolean
  email: string
  first_name: string | null
  last_name: string | null
  org_name: string
  org_admin_name: string
  invite_magic_string: string | null
}

// Every join starts from its primary key; this is an internal low-volume path.
export async function selectOrgInvitation(client: PgQueryClient, invitationId: string, forUpdate = false): Promise<OrgInvitation | undefined> {
  const { rows } = await client.query<OrgInvitation>(`
    SELECT r.id, r.org_user_id, r.tmp_user_id, r.sent_at::text AS sent_at,
      r.bento_synced_at::text AS bento_synced_at, r.bento_email, u.id AS recipient_user_id,
      o.id AS org_id, o.name AS org_name,
      COALESCE(t.email, u.email) AS email,
      COALESCE(t.first_name, u.first_name) AS first_name,
      COALESCE(t.last_name, u.last_name) AS last_name,
      COALESCE((
        SELECT NULLIF(TRIM(CONCAT_WS(' ', inviter.first_name, inviter.last_name)), '')
        FROM public.users inviter WHERE inviter.id = r.invited_by_user_id
      ), 'Capgo team') AS org_admin_name,
      t.invite_magic_string,
      CASE WHEN r.tmp_user_id IS NOT NULL THEN
        t.id IS NOT NULL AND t.cancelled_at IS NULL
          AND GREATEST(t.updated_at, t.created_at) > CURRENT_TIMESTAMP - INTERVAL '7 days'
      ELSE
        ou.id IS NOT NULL AND ou.is_invite AND ou.app_id IS NULL AND ou.channel_id IS NULL
      END AS is_pending
    FROM public.org_invitation_email_requests r
    LEFT JOIN public.tmp_users t ON t.id = r.tmp_user_id
    LEFT JOIN public.org_users ou ON ou.id = r.org_user_id
    LEFT JOIN public.users u ON u.id = ou.user_id
    JOIN public.orgs o ON o.id = COALESCE(t.org_id, ou.org_id)
    WHERE r.id = $1
    ${forUpdate ? 'FOR UPDATE OF r' : ''}
  `, [invitationId])
  return rows[0]
}

// Email delivery and durable Bento-target preparation serialize on
// the request row. Bento's network call uses only the subscriber lock.
export function selectOrgInvitationForUpdate(client: PgQueryClient, invitationId: string): Promise<OrgInvitation | undefined> {
  return selectOrgInvitation(client, invitationId, true)
}

export function orgInvitationLink(c: Context, invitation: OrgInvitation): string {
  const webappUrl = trimTrailingSlashes(getEnv(c, 'WEBAPP_URL'))
  const isNewUser = invitation.tmp_user_id !== null
  if (!webappUrl || (isNewUser && !invitation.invite_magic_string))
    throw new Error('Missing organization invitation email configuration')
  return isNewUser
    ? `${webappUrl}/invitation?invite_magic_string=${encodeURIComponent(invitation.invite_magic_string!)}`
    : `${webappUrl}/dashboard?invite_org=${encodeURIComponent(invitation.org_id)}`
}

export async function sendOrgInvitationEmail(c: Context<MiddlewareKeyVariables>, invitationId: string) {
  const pgPool = await getPgClient(c)
  try {
    await withPgTransaction(pgPool, async (client) => {
      // Cover the queue's 15-second HTTP timeout plus the Worker's 30-second
      // waitUntil lifetime, while staying below the 120-second queue visibility.
      await client.query('SET LOCAL idle_in_transaction_session_timeout = 60000')
      const invitation = await selectOrgInvitationForUpdate(client, invitationId)
      if (!invitation || invitation.sent_at || !invitation.is_pending) {
        cloudlog({ requestId: c.get('requestId'), message: 'organization invitation email skipped', invitationId })
        return
      }

      const isNewUser = invitation.tmp_user_id !== null
      const content = renderOrgInvitationEmail(isNewUser, {
        org_name: invitation.org_name,
        org_admin_name: invitation.org_admin_name,
        invited_first_name: invitation.first_name?.trim() || invitation.email.split('@')[0],
        invited_last_name: invitation.last_name?.trim() || '',
        invite_link: orgInvitationLink(c, invitation),
      })
      const messageId = await sendCloudflareEmail(c, invitation.email, content, {
        invitationId,
        email_action_type: isNewUser ? 'org_invite_new' : 'org_invite_existing',
      })
      // The marker acknowledges provider acceptance, not recipient inbox delivery.
      await client.query(`
        UPDATE public.org_invitation_email_requests
        SET sent_at = pg_catalog.clock_timestamp(), message_id = $2
        WHERE id = $1
      `, [invitationId, messageId])
    })
  }
  finally {
    closeClient(c, pgPool)
  }
}
