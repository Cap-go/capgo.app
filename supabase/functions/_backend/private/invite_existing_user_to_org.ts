import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../utils/hono.ts'
import { z } from 'zod'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { trackBentoEvent } from '../utils/bento.ts'
import { CacheHelper } from '../utils/cache.ts'
import { BRES, createHono, parseBody, quickError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { checkPermission } from '../utils/rbac.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { getEnv } from '../utils/utils.ts'
import { version } from '../utils/version.ts'

const inviteExistingUserSchema = z.object({
  email: z.email(),
  org_id: z.string().min(1),
})
const INVITE_RESEND_COOLDOWN_MINUTES = 5
// CacheHelper is the durable cross-instance cooldown layer. Keep this in-memory
// fallback to throttle same-instance resend bursts when the Cache API is
// unavailable in local/test runtimes.
const inviteNotificationCooldowns = new Map<string, number>()

type AppContext = Context<MiddlewareKeyVariables, any, any>

export const app = createHono('', version)

app.use('/', useCors)

function maskEmail(email: string) {
  const [localPart, domain = ''] = email.trim().toLowerCase().split('@')
  if (!localPart)
    return `***@${domain}`
  return `${localPart[0]}***@${domain}`
}

function getInviteNotificationCooldownKey(orgId: string, userId: string) {
  return `${orgId}:${userId}`
}

function getInviteNotificationLockKey(orgId: string, userId: string) {
  return `org-invite-notification:${orgId}:${userId}`
}

export function getInviteResendRequiredPermission(
  roleName: string | null | undefined,
  canInviteUser: boolean,
  canUpdateUserRoles: boolean,
) {
  if (!roleName?.trim())
    return null
  if (roleName === 'org_super_admin')
    return canUpdateUserRoles ? null : 'org.update_user_roles'
  return canInviteUser ? null : 'org.invite_user'
}

async function canCallerResendInviteRole(
  c: AppContext,
  auth: AuthInfo,
  orgId: string,
  roleName?: string | null,
) {
  const targetRoleName = roleName?.trim()
  if (!targetRoleName)
    return false

  let principalType = 'user'
  let principalId = auth.userId
  if (auth.authType === 'apikey' && auth.apikey?.rbac_id) {
    principalType = 'apikey'
    principalId = auth.apikey.rbac_id
  }
  if (!principalId)
    return false

  const pgClient = getPgClient(c)
  try {
    const result = await pgClient.query<{ allowed: boolean }>(`
      WITH target_role AS (
        SELECT r.priority_rank
        FROM public.roles r
        WHERE r.name = $4
          AND r.scope_type = public.rbac_scope_org()
          AND r.is_assignable = true
        LIMIT 1
      ),
      caller_priority AS (
        SELECT COALESCE(MAX(r.priority_rank), 0) AS max_priority
        FROM public.role_bindings rb
        JOIN public.roles r
          ON r.id = rb.role_id
          AND r.scope_type = rb.scope_type
        WHERE rb.principal_type = $1
          AND rb.principal_id = $2::uuid
          AND rb.scope_type = public.rbac_scope_org()
          AND rb.org_id = $3::uuid
          AND (rb.expires_at IS NULL OR rb.expires_at > now())
      )
      SELECT
        (SELECT max_priority FROM caller_priority) >= COALESCE(
          (SELECT priority_rank FROM target_role),
          2147483647
        ) AS allowed
    `, [principalType, principalId, orgId, targetRoleName])

    return result.rows[0]?.allowed === true
  }
  finally {
    closeClient(c, pgClient)
  }
}

async function lockInviteNotification(c: AppContext, orgId: string, userId: string) {
  const pgClient = getPgClient(c)
  const inviteNotificationLockKey = getInviteNotificationLockKey(orgId, userId)

  try {
    await pgClient.query('SELECT pg_advisory_lock(hashtext($1))', [inviteNotificationLockKey])
    return pgClient
  }
  catch (error) {
    closeClient(c, pgClient)
    cloudlog({
      requestId: c.get('requestId'),
      context: 'invite_existing_user_to_org lock_failed',
      orgId,
      invitedUserId: userId,
      error,
    })
    throw error
  }
}

async function unlockInviteNotification(
  c: AppContext,
  pgClient: ReturnType<typeof getPgClient>,
  orgId: string,
  userId: string,
) {
  const inviteNotificationLockKey = getInviteNotificationLockKey(orgId, userId)

  try {
    await pgClient.query('SELECT pg_advisory_unlock(hashtext($1))', [inviteNotificationLockKey])
  }
  catch (error) {
    cloudlog({
      requestId: c.get('requestId'),
      context: 'invite_existing_user_to_org unlock_failed',
      orgId,
      invitedUserId: userId,
      error,
    })
  }
  finally {
    closeClient(c, pgClient)
  }
}

async function validateRequest(c: AppContext, rawBody: unknown) {
  const validationResult = safeParseSchema(inviteExistingUserSchema, rawBody)
  if (!validationResult.success)
    return quickError(400, 'invalid_request', 'Invalid request', { errors: validationResult.error.message })

  const body = validationResult.data
  // Check org-scoped permissions before fetching org details so this endpoint
  // does not become an organization-existence oracle for arbitrary ids.
  const canInviteUser = await checkPermission(c, 'org.invite_user', { orgId: body.org_id })
  const canUpdateUserRoles = await checkPermission(c, 'org.update_user_roles', { orgId: body.org_id })

  if (!canInviteUser && !canUpdateUserRoles) {
    return quickError(403, 'not_authorized', 'Not authorized', {
      requiredPermission: 'org.invite_user',
      orgId: body.org_id,
    })
  }

  return { body, canInviteUser, canUpdateUserRoles }
}

app.post('/', middlewareAuth, async (c) => {
  const requestId = c.get('requestId')
  const cooldownCache = new CacheHelper(c)
  const rawBody = await parseBody<unknown>(c)
  const validation = await validateRequest(c, rawBody)

  const { body, canInviteUser, canUpdateUserRoles } = validation
  const authContext = c.get('auth')
  const inviterId = authContext?.userId
  if (!inviterId) {
    cloudlog({ requestId, context: 'invite_existing_user_to_org unauthorized_inviter' })
    return quickError(401, 'not_authorized', 'Not authorized')
  }

  cloudlog({
    requestId,
    context: 'invite_existing_user_to_org validated body',
    inviterId,
    canUpdateUserRoles,
    body: {
      email: maskEmail(body.email),
      org_id: body.org_id,
    },
  })

  const supabaseAdminClient = supabaseAdmin(c)

  cloudlog({ requestId, context: 'invite_existing_user_to_org fetch organization', orgId: body.org_id })
  const { data: org, error: orgError } = await supabaseAdminClient
    .from('orgs')
    .select('id, name')
    .eq('id', body.org_id)
    .maybeSingle()

  if (orgError) {
    return quickError(500, 'failed_to_invite_user', 'Failed to fetch organization', { error: orgError.message })
  }

  if (!org) {
    return quickError(404, 'organization_not_found', 'Organization not found')
  }

  cloudlog({ requestId, context: 'invite_existing_user_to_org fetch inviter', inviterId, orgId: body.org_id })
  const { data: inviter, error: inviterError } = await supabaseAdminClient
    .from('users')
    .select('id, first_name, last_name')
    .eq('id', inviterId)
    .maybeSingle()

  if (inviterError) {
    return quickError(500, 'failed_to_invite_user', 'Failed to fetch inviter', { error: inviterError.message })
  }

  cloudlog({
    requestId,
    context: 'invite_existing_user_to_org fetch invited user',
    orgId: body.org_id,
    invitedEmail: maskEmail(body.email),
  })
  const { data: invitedUser, error: invitedUserError } = await supabaseAdminClient
    .from('users')
    .select('id, email, first_name, last_name')
    .eq('email', body.email)
    .maybeSingle()

  if (invitedUserError) {
    return quickError(500, 'failed_to_invite_user', 'Failed to fetch invited user', { error: invitedUserError.message })
  }

  if (!invitedUser) {
    return quickError(404, 'user_not_found', 'User not found')
  }

  cloudlog({
    requestId,
    context: 'invite_existing_user_to_org fetch membership',
    orgId: body.org_id,
    invitedUserId: invitedUser.id,
  })
  const { data: membership, error: membershipError } = await supabaseAdminClient
    .from('org_users')
    .select('id, is_invite, rbac_role_name')
    .eq('org_id', body.org_id)
    .eq('user_id', invitedUser.id)
    .maybeSingle()

  if (membershipError) {
    return quickError(500, 'failed_to_invite_user', 'Failed to fetch organization membership', { error: membershipError.message })
  }

  if (!membership) {
    return quickError(404, 'invite_not_found', 'Pending invitation not found')
  }

  if (!membership.is_invite) {
    return quickError(409, 'invite_already_accepted', 'Invitation already accepted')
  }

  if (!membership.rbac_role_name) {
    return quickError(500, 'failed_to_invite_user', 'Invitation has no RBAC role')
  }

  const missingPermission = getInviteResendRequiredPermission(
    membership.rbac_role_name,
    canInviteUser,
    canUpdateUserRoles,
  )

  if (missingPermission) {
    return quickError(403, 'not_authorized', 'Not authorized', {
      requiredPermission: missingPermission,
      orgId: body.org_id,
    })
  }

  const canManageInviteRole = await canCallerResendInviteRole(
    c,
    authContext,
    body.org_id,
    membership.rbac_role_name,
  )
  if (!canManageInviteRole) {
    return quickError(403, 'not_authorized', 'Not authorized', {
      requiredPermission: 'org.update_user_roles',
      orgId: body.org_id,
    })
  }

  const inviteCooldownStorageKey = getInviteNotificationCooldownKey(body.org_id, invitedUser.id)
  const inviteCooldownKey = cooldownCache.buildRequest('/private/invite_existing_user_to_org/cooldown', {
    org_id: body.org_id,
    user_id: invitedUser.id,
  })
  const inviterName = [inviter?.first_name, inviter?.last_name].filter(Boolean).join(' ').trim() || 'Capgo team'
  const invitedFirstName = invitedUser.first_name?.trim() || body.email.split('@')[0] || ''
  const invitedLastName = invitedUser.last_name?.trim() || ''
  const inviteNotificationLock = await lockInviteNotification(c, body.org_id, invitedUser.id)
  try {
    const now = Date.now()
    const inMemoryCooldownUntil = inviteNotificationCooldowns.get(inviteCooldownStorageKey) ?? 0
    if (inMemoryCooldownUntil <= now)
      inviteNotificationCooldowns.delete(inviteCooldownStorageKey)
    const cachedInviteNotification = await cooldownCache.matchJson<{ sentAt: string }>(inviteCooldownKey)
    if (inMemoryCooldownUntil > now || cachedInviteNotification) {
      cloudlog({
        requestId,
        context: 'invite_existing_user_to_org rate_limited',
        orgId: body.org_id,
        invitedUserId: invitedUser.id,
        inviterId,
      })
      return quickError(409, 'user_already_invited', 'User already invited recently. Please wait before resending.', {
        reason: 'invite_recently_sent',
        cooldown_minutes: INVITE_RESEND_COOLDOWN_MINUTES,
      })
    }

    cloudlog({
      requestId,
      context: 'invite_existing_user_to_org track bento event',
      orgId: body.org_id,
      invitedUserId: invitedUser.id,
      inviterId,
    })
    const bentoEvent = await trackBentoEvent(c, invitedUser.email, {
      org_admin_name: inviterName,
      org_name: org.name,
      invite_link: `${getEnv(c, 'WEBAPP_URL')}/dashboard?invite_org=${body.org_id}`,
      invited_first_name: invitedFirstName,
      invited_last_name: invitedLastName,
    }, 'org:invite_existing_capgo_user_to_org')

    if (bentoEvent === false) {
      return quickError(500, 'failed_to_send_invite_email', 'Failed to send invitation email')
    }

    inviteNotificationCooldowns.set(
      inviteCooldownStorageKey,
      now + INVITE_RESEND_COOLDOWN_MINUTES * 60 * 1000,
    )
    await cooldownCache.putJson(
      inviteCooldownKey,
      { sentAt: new Date().toISOString() },
      INVITE_RESEND_COOLDOWN_MINUTES * 60,
    )
  }
  finally {
    await unlockInviteNotification(c, inviteNotificationLock, body.org_id, invitedUser.id)
  }

  cloudlog({
    requestId,
    context: 'invite_existing_user_to_org success',
    orgId: body.org_id,
    invitedUserId: invitedUser.id,
    inviterId,
  })
  return c.json(BRES)
})
