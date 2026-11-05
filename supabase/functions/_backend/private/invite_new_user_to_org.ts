import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import dayjs from 'dayjs'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { containsDomainName } from '../../shared/invite-name.ts'
import { verifyCaptchaToken } from '../utils/captcha.ts'
import { BRES, parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { authPrincipal, withRlsTransaction } from '../utils/pg_rls.ts'
import { canCallerAssignOrgRole, checkPermission } from '../utils/rbac.ts'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { getEnv } from '../utils/utils.ts'

// Define the schema for the invite user request
const inviteUserSchema = z.object({
  email: z.email(),
  org_id: z.string().min(1),
  invite_type: z.enum(['org_member', 'org_billing_admin', 'org_admin', 'org_super_admin']),
  captcha_token: z.string().min(1).optional(),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
})

const rbacInviteRoles = ['org_member', 'org_billing_admin', 'org_admin', 'org_super_admin'] as const

type RbacInviteRole = (typeof rbacInviteRoles)[number]

const INVITE_RESEND_COOLDOWN_MINUTES = 5
// PostgREST's PGRST116 message for `.single()` on zero or several rows.
const SINGLE_ROW_ERROR_MESSAGE = 'JSON object requested, multiple (or no) rows returned'

function generateInviteMagicString() {
  const bytes = new Uint8Array(128)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function resolveInviteRoles(inviteType: string) {
  if (rbacInviteRoles.includes(inviteType as RbacInviteRole)) {
    const rbacRoleName = inviteType as RbacInviteRole
    return { rbacRoleName }
  }

  throw simpleError('invalid_request', 'Invalid invite type')
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

async function validateInvite(c: Context, rawBody: any) {
  const validationResult = safeParseSchema(inviteUserSchema, rawBody)
  if (!validationResult.success) {
    throw simpleError('invalid_request', 'Invalid request', { errors: validationResult.error.message })
  }

  const body = validationResult.data
  if (containsDomainName(body.first_name) || containsDomainName(body.last_name)) {
    throw simpleError('invite_name_domain_not_allowed', 'First and last names cannot contain domain names')
  }
  cloudlog({ requestId: c.get('requestId'), context: 'invite_new_user_to_org validated body', body })

  const authorization = c.get('authorization')
  if (!authorization)
    return quickError(401, 'not_authorized', 'Not authorized')

  // Verify the user has permission to invite
  // inviting super_admin requires org.update_user_roles, other roles require org.invite_user
  const isSuperAdminInvite = body.invite_type === 'org_super_admin'
  const requiredPermission = isSuperAdminInvite ? 'org.update_user_roles' : 'org.invite_user'
  if (!await checkPermission(c, requiredPermission, { orgId: body.org_id })) {
    return quickError(403, 'not_authorized', 'Not authorized', {
      requiredPermission,
      orgId: body.org_id,
    })
  }

  // Match invite_user_to_org_rbac: deny when caller max rank is below the target role.
  if (!await canCallerAssignOrgRole(c, body.org_id, body.invite_type)) {
    return quickError(403, 'not_authorized', 'Not authorized', {
      requiredPermission,
      orgId: body.org_id,
    })
  }

  // Verify captcha token with Cloudflare Turnstile
  const captchaSecret = getEnv(c, 'CAPTCHA_SECRET_KEY')
  if (captchaSecret.length > 0) {
    if (!body.captcha_token) {
      throw simpleError('invalid_request', 'Captcha token is required')
    }
    await verifyCaptchaToken(c, body.captcha_token, captchaSecret)
  }

  // Run as the caller - RLS will enforce access based on JWT
  const principal = authPrincipal(c)
  const pg = await getPgClient(c)
  let existingUserCount = 0
  let userError: unknown = null
  let org: { id: string } | undefined
  let orgError: unknown = null
  try {
    // Check if the user already exists
    try {
      existingUserCount = await withRlsTransaction(pg, principal, async (client) => {
        const { rows } = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM public.users WHERE email = $1', [body.email])
        return rows[0].count
      })
    }
    catch (error) {
      userError = error
    }

    // Create the invitation record in the database
    if (existingUserCount === 1 && !userError) {
      return { message: 'Failed to invite user', error: 'User already exists', status: 500 }
    }

    // Get org - RLS will block if user doesn't have access
    try {
      const orgRows = await withRlsTransaction(pg, principal, async (client) => {
        const { rows } = await client.query<{ id: string }>('SELECT id FROM public.orgs WHERE id = $1 LIMIT 2', [body.org_id])
        return rows
      })
      if (orgRows.length === 1)
        org = orgRows[0]
      else
        orgError = new Error(SINGLE_ROW_ERROR_MESSAGE)
    }
    catch (error) {
      orgError = error
    }
  }
  finally {
    closeClient(c, pg)
  }

  if (orgError || !org) {
    return { message: 'Failed to invite user', error: (orgError as Error | null)?.message ?? 'Organization not found', status: 500 }
  }

  const { rbacRoleName } = resolveInviteRoles(body.invite_type)

  // Get current user ID from JWT
  const authContext = c.get('auth')
  if (!authContext?.userId) {
    return { message: 'Failed to get current user', error: 'Not authorized', status: 500 }
  }

  return { org, body, authorization, rbacRoleName }
}

app.post('/', middlewareAuth, async (c) => {
  const rawBody = await parseBody<any>(c)
  cloudlog({ requestId: c.get('requestId'), context: 'invite_new_user_to_org raw body', rawBody })

  const res = await validateInvite(c, rawBody)
  if (!res.body) {
    throw simpleError('failed_to_invite_user', 'Failed to invite user', {}, res.error ?? 'Failed to invite user')
  }
  if (!res.org) {
    return quickError(404, 'organization_not_found', 'Organization not found')
  }
  const body = res.body
  const rbacRoleName = res.rbacRoleName
  const authContext = c.get('auth')
  if (!authContext?.userId) {
    throw simpleError('failed_to_invite_user', 'Failed to invite user', {}, 'Not authorized')
  }

  // Connection role for tmp_users operations since RLS blocks all access on that table
  const pg = await getPgClient(c)
  try {
    await upsertInvitation(pg, body, rbacRoleName, authContext.userId)
  }
  finally {
    closeClient(c, pg)
  }

  return c.json(BRES)
})

type TmpUser = Database['public']['Tables']['tmp_users']['Row']

async function upsertInvitation(
  pg: Awaited<ReturnType<typeof getPgClient>>,
  body: z.infer<typeof inviteUserSchema>,
  rbacRoleName: RbacInviteRole,
  inviterId: string,
) {
  let existingInvitation: TmpUser | undefined
  try {
    ({ rows: [existingInvitation] } = await pg.query<TmpUser>(
      'SELECT * FROM public.tmp_users WHERE email = $1 AND org_id = $2',
      [body.email, body.org_id],
    ))
  }
  catch (existingInvitationError) {
    throw simpleError('failed_to_invite_user', 'Failed to invite user', {}, (existingInvitationError as Error).message)
  }

  if (existingInvitation) {
    const nowMinusThreeHours = dayjs().subtract(3, 'hours')
    if (existingInvitation.cancelled_at && !dayjs(nowMinusThreeHours).isAfter(dayjs(existingInvitation.cancelled_at))) {
      throw simpleError('user_already_invited', 'User already invited and it hasn\'t been 3 hours since the last invitation was cancelled', {
        reason: 'invite_cancelled_recently',
        cooldown_minutes: 180,
      })
    }

    const lastInviteAt = existingInvitation.updated_at ?? existingInvitation.created_at
    if (!existingInvitation.cancelled_at && lastInviteAt) {
      const minutesSinceLastInvite = dayjs().diff(dayjs(lastInviteAt), 'minute')
      if (minutesSinceLastInvite < INVITE_RESEND_COOLDOWN_MINUTES) {
        throw simpleError('user_already_invited', 'User already invited recently. Please wait before resending.', {
          reason: 'invite_recently_sent',
          cooldown_minutes: INVITE_RESEND_COOLDOWN_MINUTES,
        })
      }
    }

    let updatedCount = 0
    try {
      const { rowCount } = await pg.query(
        `UPDATE public.tmp_users
        SET cancelled_at = NULL, first_name = $3, last_name = $4, rbac_role_name = $5, invited_by_user_id = $6, invite_magic_string = $7
        WHERE email = $1 AND org_id = $2`,
        [body.email, body.org_id, body.first_name, body.last_name, rbacRoleName, inviterId, generateInviteMagicString()],
      )
      updatedCount = rowCount ?? 0
    }
    catch (error) {
      const updateInvitationError = error as { code?: string, message: string }
      if (updateInvitationError.code === 'P0001' && updateInvitationError.message.includes('INVITE_EMAIL_COOLDOWN')) {
        throw simpleError('user_already_invited', 'User already invited recently. Please wait before resending.', {
          reason: 'invite_recently_sent',
          cooldown_minutes: INVITE_RESEND_COOLDOWN_MINUTES,
        })
      }
      throw simpleError('failed_to_invite_user', 'Failed to invite user', {}, updateInvitationError.message)
    }
    if (updatedCount !== 1)
      throw simpleError('failed_to_invite_user', 'Failed to invite user', {}, SINGLE_ROW_ERROR_MESSAGE)
  }
  else {
    try {
      await pg.query(
        `INSERT INTO public.tmp_users (email, org_id, rbac_role_name, first_name, last_name, invited_by_user_id)
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [body.email, body.org_id, rbacRoleName, body.first_name, body.last_name, inviterId],
      )
    }
    catch (createUserError) {
      throw simpleError('failed_to_invite_user', 'Failed to invite user', {}, (createUserError as Error).message)
    }
  }
}
