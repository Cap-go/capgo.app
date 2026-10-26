import type { Context } from 'hono'
import type { BentoBatchEvent } from '../../../supabase/functions/_backend/utils/bento.ts'
import type { MiddlewareKeyVariables } from '../../../supabase/functions/_backend/utils/hono.ts'
import type { PgQueryClient } from '../../../supabase/functions/_backend/utils/pg.ts'
import type { OrgInvitation } from './org_invitation_email.ts'
import { isBentoConfigured, trackBentoEvents, updateBentoFields } from '../../../supabase/functions/_backend/utils/bento.ts'
import { cloudlog } from '../../../supabase/functions/_backend/utils/logging.ts'
import { closeClient, getPgClient, withPgTransaction } from '../../../supabase/functions/_backend/utils/pg.ts'
import { escapeHtml } from '../email_templates/render.ts'
import { orgInvitationLink, selectOrgInvitation, selectOrgInvitationForUpdate } from './org_invitation_email.ts'

// Bento owns reminder timing: the flow triggered by this event waits, then
// sends a reminder only while the invite id is still in OPEN_INVITES_FIELD.
export const INVITE_SENT_EVENT = 'org:invite_sent'
export const OPEN_INVITES_FIELD = 'capgo_open_invites'

// Open invitations Bento tracks for one subscriber address, plus the
// generation being enrolled now. Bounded by the partial bento_email index
// and the request primary key; each join is by primary key.
const OPEN_INVITES_SQL = `
  SELECT r.id::text AS id
  FROM public.org_invitation_email_requests r
  LEFT JOIN public.tmp_users t ON t.id = r.tmp_user_id
  LEFT JOIN public.org_users ou ON ou.id = r.org_user_id
  WHERE (r.bento_email = $1 OR r.id = $2::uuid) AND r.sent_at IS NOT NULL
    AND CASE WHEN r.tmp_user_id IS NOT NULL THEN
      t.id IS NOT NULL AND t.cancelled_at IS NULL
        AND GREATEST(t.updated_at, t.created_at) > CURRENT_TIMESTAMP - INTERVAL '7 days'
    ELSE
      ou.id IS NOT NULL AND ou.is_invite AND ou.app_id IS NULL AND ou.channel_id IS NULL
    END
  ORDER BY r.id
`

// Serializes every Bento field write for one subscriber so a stale list can
// never land after a newer one. Each caller reads the open list after this.
async function lockBentoSubscriber(client: PgQueryClient, email: string) {
  await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.lower($1), 0))', [email])
}

async function readOpenInvites(client: PgQueryClient, email: string, enrollingId: string | null): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(OPEN_INVITES_SQL, [email, enrollingId])
  return rows.map(row => row.id)
}

export function buildInviteSentEvent(invitation: OrgInvitation, inviteLink: string, openInvites: readonly string[]): BentoBatchEvent {
  return {
    event: INVITE_SENT_EVENT,
    data: {
      invite_id: invitation.id,
      kind: invitation.tmp_user_id !== null ? 'new' : 'existing',
      org_id: invitation.org_id,
      org_name: escapeHtml(invitation.org_name),
      org_name_subject: invitation.org_name.replace(/[\r\n]+/g, ' '),
      org_admin_name: escapeHtml(invitation.org_admin_name),
      invited_first_name: escapeHtml(invitation.first_name?.trim() || invitation.email.split('@')[0]),
      invited_last_name: escapeHtml(invitation.last_name?.trim() || ''),
      invite_link: inviteLink,
    },
    fields: { [OPEN_INVITES_FIELD]: openInvites.join(' ') },
  }
}

// Starts the Bento reminder flow for a sent generation. The field update
// rides on the same event so the flow never sees the invite as closed. The
// subscriber lock orders the event before any concurrent close's field sync.
// The request row is never held across Bento's network call, so closes can
// commit and queue reconciliation while enrollment is still in flight.
// The marker suppresses confirmed repeats, but Bento and Postgres cannot
// commit atomically: an ambiguous failure can enroll the generation again.
export async function startOrgInvitationBentoFlow(c: Context<MiddlewareKeyVariables>, invitationId: string) {
  if (!isBentoConfigured(c))
    return
  const pgPool = await getPgClient(c)
  try {
    // Commit the target before contacting Bento. If acceptance is ambiguous
    // or the later marker rolls back, a close still knows which subscriber
    // needs reconciliation. Retries keep this identity after email changes.
    const email = await withPgTransaction(pgPool, async (client) => {
      const invitation = await selectOrgInvitationForUpdate(client, invitationId)
      if (!invitation?.sent_at || invitation.bento_synced_at || !invitation.is_pending)
        return null
      const email = (invitation.bento_email ?? invitation.email).trim().toLowerCase()
      await client.query('UPDATE public.org_invitation_email_requests SET bento_email = $2 WHERE id = $1', [invitationId, email])
      return email
    })
    if (!email)
      return
    await withPgTransaction(pgPool, async (client) => {
      // Serialize subscriber writes and confirmed retries without locking the
      // request row while the provider is processing the event.
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SET LOCAL idle_in_transaction_session_timeout = 60000')
      await lockBentoSubscriber(client, email)
      const invitation = await selectOrgInvitation(client, invitationId)
      if (!invitation?.sent_at || invitation.bento_synced_at || !invitation.is_pending) {
        cloudlog({ requestId: c.get('requestId'), message: 'organization invitation Bento flow skipped', invitationId })
        return
      }
      const openInvites = await readOpenInvites(client, email, invitation.id)
      // READ COMMITTED takes fresh snapshots after the subscriber lock, so a
      // queued close or a previous enrollment's marker cannot be missed.
      if (!openInvites.includes(invitation.id)) {
        cloudlog({ requestId: c.get('requestId'), message: 'organization invitation closed before Bento flow', invitationId })
        return
      }
      const event = buildInviteSentEvent(invitation, orgInvitationLink(c, invitation), openInvites)
      const accepted = await trackBentoEvents(c, email, [event], AbortSignal.timeout(10_000))
      if (accepted === false)
        throw new Error('Bento rejected the organization invitation event')
      // Without Bento configured there is no flow to start; leave it unmarked.
      if (accepted === undefined)
        return
      await client.query(`
        UPDATE public.org_invitation_email_requests
        SET bento_synced_at = pg_catalog.clock_timestamp(), bento_email = $2
        WHERE id = $1 AND bento_email = $2
      `, [invitationId, email])
    })
  }
  finally {
    closeClient(c, pgPool)
  }
}

// Rewrites a subscriber's open-invites field after an invitation closes or
// is resent, so running reminder flows for it stop at their next check.
export async function syncOrgInvitationBentoField(c: Context<MiddlewareKeyVariables>, email: string) {
  email = email.trim().toLowerCase()
  const pgPool = await getPgClient(c)
  try {
    await withPgTransaction(pgPool, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SET LOCAL idle_in_transaction_session_timeout = 60000')
      await lockBentoSubscriber(client, email)
      const openInvites = await readOpenInvites(client, email, null)
      const accepted = await updateBentoFields(c, email, { [OPEN_INVITES_FIELD]: openInvites.join(' ') }, AbortSignal.timeout(10_000))
      if (accepted !== true)
        throw new Error('Bento rejected the organization invitation field update')
    })
  }
  finally {
    closeClient(c, pgPool)
  }
}
