import type { EligibleUser, Evaluation, InvitationDetails, ReadOnlyContext, ResolvedAction } from '../contracts.ts'
import { buildInvitationEvent } from '../operations.ts'

export const INVITATION_FLOW = 'org:invitation'
export type InvitationKind = 'new' | 'existing'

// The active partial index supplies the entire live cohort for one variant.
// Each source/history join is bounded by a primary/unique key; membership
// evidence begins at the indexed org_id, never at all users or all invitations.
export const INVITATION_SELECTION_SQL = `
  WITH active AS (
    SELECT d.* FROM public.bento_event_dispatches d
    WHERE d.flow_key = 'org:invitation' AND d.tag = 'flow:started' AND d.closed_at IS NULL
      AND d.details->>'kind' = $1 AND ($4::uuid IS NULL OR d.id = $4)
  ), state AS (
    SELECT start.*, o.id AS current_org_id, t.id AS tmp_id, ou.id AS member_id,
      t.cancelled_at, ou.is_invite, ou.app_id, ou.channel_id,
      LOWER(COALESCE(t.email, u.email)) AS current_email,
      GREATEST(t.updated_at, t.created_at) AS token_created_at,
      COALESCE(rn.id, re.id)::text AS current_generation,
      COALESCE(rn.sent_at, re.sent_at) AS initial_sent_at,
      first_reminder.event_at AS first_accepted_at,
      last_reminder.event_at AS last_accepted_at,
      target.status AS target_status, target.attempt_count AS target_attempts,
      EXISTS (
        SELECT 1 FROM public.org_users membership
        JOIN public.users member_user ON member_user.id = membership.user_id
        WHERE membership.org_id = (start.details->>'orgId')::uuid
          AND NOT membership.is_invite AND membership.app_id IS NULL AND membership.channel_id IS NULL
          AND CASE WHEN $1 = 'existing' THEN membership.user_id = (start.details->>'userId')::uuid
            ELSE LOWER(member_user.email) = start.email END
      ) AS has_membership
    FROM active start
    LEFT JOIN public.orgs o ON o.id = (start.details->>'orgId')::uuid
    LEFT JOIN public.tmp_users t ON $1 = 'new' AND t.id = (start.details->>'invitationId')::int
    LEFT JOIN public.org_users ou ON $1 = 'existing' AND ou.id = (start.details->>'invitationId')::bigint
    LEFT JOIN public.users u ON u.id = ou.user_id
    LEFT JOIN public.org_invitation_email_requests rn ON rn.tmp_user_id = t.id
    LEFT JOIN public.org_invitation_email_requests re ON re.org_user_id = ou.id
    LEFT JOIN public.bento_event_dispatches first_reminder ON first_reminder.flow_key = start.flow_key
      AND first_reminder.context_key = start.context_key AND first_reminder.recipient_key = start.recipient_key
      AND first_reminder.tag = 'org:invite_' || $1 || '_user_reminder_1' AND first_reminder.status = 'accepted'
    LEFT JOIN public.bento_event_dispatches last_reminder ON last_reminder.flow_key = start.flow_key
      AND last_reminder.context_key = start.context_key AND last_reminder.recipient_key = start.recipient_key
      AND last_reminder.tag = 'org:invite_' || $1 || '_user_reminder_2' AND last_reminder.status = 'accepted'
    LEFT JOIN public.bento_event_dispatches target ON target.flow_key = start.flow_key
      AND target.context_key = start.context_key AND target.recipient_key = start.recipient_key AND target.tag = $3
  ), decision AS (
    SELECT *, CASE
      WHEN current_org_id IS NULL THEN 'removed'
      WHEN has_membership THEN 'accepted'
      WHEN ($1 = 'new' AND tmp_id IS NULL) OR ($1 = 'existing' AND member_id IS NULL) THEN 'removed'
      WHEN $1 = 'new' AND cancelled_at IS NOT NULL THEN 'cancelled'
      WHEN current_generation IS DISTINCT FROM context_key OR current_email IS DISTINCT FROM email THEN 'superseded'
      WHEN $1 = 'existing' AND (NOT is_invite OR app_id IS NOT NULL OR channel_id IS NOT NULL) THEN 'removed'
      WHEN $1 = 'new' AND token_created_at IS DISTINCT FROM (details->>'tokenCreatedAt')::timestamptz THEN 'superseded'
      WHEN $1 = 'new' AND token_created_at + INTERVAL '7 days' <= CURRENT_TIMESTAMP THEN 'expired'
      WHEN last_accepted_at IS NOT NULL THEN 'completed'
      ELSE NULL END AS terminal_reason
    FROM state
  )
  SELECT flow_key AS "flowKey", context_key AS "contextKey", recipient_key AS "recipientKey", email,
    $3::text AS tag, CASE WHEN terminal_reason IS NULL THEN 'send' ELSE 'end' END AS action,
    COALESCE(terminal_reason, CASE WHEN $2 = 1 THEN 'first_reminder_due' ELSE 'final_reminder_due' END) AS reason,
    jsonb_build_object('startId', id, 'kind', $1::text, 'invitationId', details->'invitationId',
      'orgId', details->'orgId', 'generation', context_key,
      'initialSentAt', event_at, 'firstReminderAcceptedAt', first_accepted_at,
      'finalReminderAcceptedAt', last_accepted_at,
      'invitationExpiresAt', CASE WHEN $1 = 'new' THEN token_created_at + INTERVAL '7 days' ELSE NULL END,
      'evaluatedAt', CURRENT_TIMESTAMP,
      'eligibleAt', CASE WHEN $2 = 1 THEN event_at + INTERVAL '2 days'
        WHEN $1 = 'existing' THEN first_accepted_at + INTERVAL '5 days'
        ELSE token_created_at + INTERVAL '7 days' - INTERVAL '1 hour' END,
      'waitCondition', CASE WHEN $2 = 1 THEN 'initial_acceptance_plus_2_days'
        WHEN $1 = 'existing' THEN 'first_reminder_acceptance_plus_5_days'
        ELSE 'first_reminder_accepted_and_expiry_minus_1_hour' END,
      'waitSatisfied', COALESCE(CASE WHEN $2 = 1 THEN event_at + INTERVAL '2 days' <= CURRENT_TIMESTAMP
        WHEN $1 = 'existing' THEN first_accepted_at + INTERVAL '5 days' <= CURRENT_TIMESTAMP
        ELSE first_accepted_at IS NOT NULL AND token_created_at + INTERVAL '7 days' - INTERVAL '1 hour' <= CURRENT_TIMESTAMP
          AND token_created_at + INTERVAL '7 days' > CURRENT_TIMESTAMP END, false)) AS metadata
  FROM decision
  WHERE terminal_reason IS NOT NULL OR (
    initial_sent_at IS NOT NULL AND target_status IS DISTINCT FROM 'accepted' AND ($4::uuid IS NOT NULL OR COALESCE(target_attempts, 0) < 5)
    AND CASE WHEN $2 = 1 THEN event_at + INTERVAL '2 days' <= CURRENT_TIMESTAMP
      WHEN $1 = 'existing' THEN first_accepted_at + INTERVAL '5 days' <= CURRENT_TIMESTAMP
      ELSE first_accepted_at IS NOT NULL AND token_created_at + INTERVAL '7 days' - INTERVAL '1 hour' <= CURRENT_TIMESTAMP END
  )
  ORDER BY event_at, id
`

export function findInvitationUsers(ctx: ReadOnlyContext, kind: InvitationKind, stage: 1 | 2, startId: string | null = null): Promise<EligibleUser[]> {
  return ctx.query<EligibleUser>(INVITATION_SELECTION_SQL, [kind, stage, `org:invite_${kind}_user_reminder_${stage}`, startId])
}

export async function resolveInvitation(ctx: ReadOnlyContext, user: EligibleUser, kind: InvitationKind, stage: 1 | 2, webappUrl: string): Promise<ResolvedAction> {
  const startId = user.metadata.startId
  if (typeof startId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(startId))
    return { action: 'skip', reason: 'invalid_start_id' }
  const [current] = await findInvitationUsers(ctx, kind, stage, startId)
  if (!current)
    return { action: 'skip', reason: 'selection_stale_or_not_due' }
  if (current.action === 'end')
    return { action: 'end', reason: current.reason as 'accepted' | 'cancelled' | 'expired' | 'removed' | 'superseded' | 'completed' }
  const [invitation] = await ctx.query<InvitationDetails>(`
    SELECT LOWER(COALESCE(t.email, u.email)) AS email, o.id AS org_id, o.name AS org_name,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', inviter.first_name, inviter.last_name)), ''), 'Capgo team') AS org_admin_name,
      COALESCE(t.first_name, u.first_name) AS first_name, COALESCE(t.last_name, u.last_name) AS last_name,
      t.invite_magic_string, r.tmp_user_id IS NOT NULL AS is_new_user
    FROM public.org_invitation_email_requests r
    LEFT JOIN public.tmp_users t ON t.id = r.tmp_user_id
    LEFT JOIN public.org_users ou ON ou.id = r.org_user_id
    LEFT JOIN public.users u ON u.id = ou.user_id
    LEFT JOIN public.users inviter ON inviter.id = r.invited_by_user_id
    JOIN public.orgs o ON o.id = COALESCE(t.org_id, ou.org_id)
    WHERE r.id = $1::uuid`, [user.contextKey])
  if (!invitation)
    return { action: 'skip', reason: 'source_changed' }
  return { action: 'send', buildEvent: id => buildInvitationEvent({ id, tag: user.tag }, invitation, webappUrl) }
}

export function invitationEvaluation(kind: InvitationKind, stage: 1 | 2, options?: { everyMinutes: number }): Evaluation {
  return {
    key: `org:invite_${kind}_user_reminder_${stage}`,
    everyMinutes: options?.everyMinutes ?? 1,
    findEligibleUsers: ctx => findInvitationUsers(ctx, kind, stage),
    handleEligibleUsers: async (ctx, users) => {
      const resolve = (user: EligibleUser, read: ReadOnlyContext) => resolveInvitation(read, user, kind, stage, ctx.settings.WEBAPP_URL)
      const outcomes = await ctx.sendBentoEvents(users, resolve)
      if (stage === 2) {
        for (const item of outcomes) {
          if (item.outcome === 'accepted')
            await ctx.endFlow(item.user, read => resolve(item.user, read))
        }
      }
      return { selected: users.length, accepted: outcomes.filter(item => item.outcome === 'accepted').length, ended: outcomes.filter(item => item.outcome === 'ended').length, failed: outcomes.filter(item => item.outcome === 'failed').length, skipped: outcomes.filter(item => item.outcome === 'skipped').length, deferred: outcomes.filter(item => item.outcome === 'deferred').length }
    },
  }
}
