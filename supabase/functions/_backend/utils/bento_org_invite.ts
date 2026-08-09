import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import { syncBentoSubscriberTags } from './bento.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'
import { normalizeBentoEmail } from './bento_first_org.ts'

/** Bento Match on Invite-to-org reminders: stop when this tag is present. */
export const BENTO_ORG_INVITE_ACCEPTED_TAG = 'org:invite_accepted'

export const BENTO_ORG_INVITE_ACCEPTED_BINDING_REASON = 'Accepted invitation'

interface InviteAcceptedBinding {
  email: string | null
  id: string
  is_active: boolean
  is_direct: boolean
  org_id: string | null
  principal_id: string
  principal_type: string
  reason: string | null
  scope_type: string
}

/**
 * When a user-org role binding is created with reason "Accepted invitation",
 * tag the invitee in Bento so invite-reminder workflows can exit.
 */
export async function syncBentoOrgInviteAcceptedOnRoleBindingWrite(
  c: Context<MiddlewareKeyVariables>,
  roleBindingId: string,
) {
  const pgPool = getPgClient(c)
  try {
    let binding: InviteAcceptedBinding | undefined
    const pgClient = await pgPool.connect()
    try {
      const result = await pgClient.query<InviteAcceptedBinding>(
        `SELECT
           binding.id,
           binding.principal_type,
           binding.principal_id,
           binding.scope_type,
           binding.org_id,
           binding.reason,
           binding.is_direct,
           (binding.expires_at IS NULL OR binding.expires_at > pg_catalog.now()) AS is_active,
           users.email
         FROM public.role_bindings AS binding
         LEFT JOIN public.users AS users
           ON users.id = binding.principal_id
         WHERE binding.id = $1::uuid
         LIMIT 1`,
        [roleBindingId],
      )
      binding = result.rows[0]
    }
    finally {
      // Destroy this request-scoped socket before crossing into Bento.
      pgClient.release(true)
    }

    if (
      !binding
      || binding.principal_type !== 'user'
      || binding.scope_type !== 'org'
      || !binding.org_id
      || binding.is_direct !== true
      || binding.is_active !== true
      || binding.reason !== BENTO_ORG_INVITE_ACCEPTED_BINDING_REASON
      || !binding.email
    ) {
      return
    }

    const email = normalizeBentoEmail(binding.email)
    const result = await syncBentoSubscriberTags(c, {
      email,
      segments: [BENTO_ORG_INVITE_ACCEPTED_TAG],
      deleteSegments: [],
    })

    if (result === false) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'syncBentoOrgInviteAcceptedOnRoleBindingWrite failed',
        roleBindingId,
        orgId: binding.org_id,
        principalId: binding.principal_id,
      })
      return
    }

    cloudlog({
      requestId: c.get('requestId'),
      message: 'bento_org_invite_accepted_tagged',
      roleBindingId,
      orgId: binding.org_id,
      principalId: binding.principal_id,
      email,
      tag: BENTO_ORG_INVITE_ACCEPTED_TAG,
    })
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'syncBentoOrgInviteAcceptedOnRoleBindingWrite error',
      roleBindingId,
      error: serializeError(error),
    })
  }
  finally {
    await closeClient(c, pgPool)
  }
}
