import type { PoolClient } from 'pg'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { z } from 'zod'
import { Hono } from 'hono/tiny'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { getEffectivePasswordMinLength, getPasswordPolicyValidationErrors } from '../utils/password_policy.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { emptySupabase, supabaseAdmin as useSupabaseAdmin } from '../utils/supabase.ts'
import { syncUserPreferenceTags } from '../utils/user_preferences.ts'
import { getEnv } from '../utils/utils.ts'

interface AcceptInvitation {
  password: string
  magic_invite_string: string
  opt_for_newsletters: boolean
  captchaToken?: string
}

interface PasswordPolicy {
  enabled: boolean
  min_length: number
  require_uppercase: boolean
  require_number: boolean
  require_special: boolean
}

// Default password policy (when org has no policy set)
const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  enabled: true,
  min_length: 6,
  require_uppercase: true,
  require_number: true,
  require_special: true,
}

// Base schema for initial validation (without password)
const baseInvitationSchema = z.object({
  password: z.string(),
  magic_invite_string: z.string().min(1),
  opt_for_newsletters: z.boolean(),
  captchaToken: z.string().min(1).optional(),
})

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

function isUserAlreadyExistsAuthError(err: unknown): boolean {
  const anyErr = err as any
  const msg = String(anyErr?.message ?? '').toLowerCase()
  const code = String(anyErr?.code ?? '').toLowerCase()
  // Supabase/GoTrue can vary message and code depending on version/config.
  return (
    (code.includes('user') && code.includes('exists'))
    || (code.includes('email') && code.includes('exists'))
    || (msg.includes('already') && (msg.includes('registered') || msg.includes('exists') || msg.includes('user')))
  )
}

function isMissingCreatedViaInviteColumnError(err: unknown): boolean {
  const anyErr = err as any
  const code = String(anyErr?.code ?? '').toUpperCase()
  const msg = String(anyErr?.message ?? '').toLowerCase()

  // PostgREST returns schema cache errors as PGRST204.
  // Some environments may surface a Postgres undefined_column code (42703).
  return code === 'PGRST204' || code === '42703' || msg.includes('created_via_invite')
}

async function rollbackCreatedUser(c: Parameters<typeof useSupabaseAdmin>[0], userId: string) {
  // Best-effort rollback so users can retry the invite flow if something fails mid-way.
  const admin = useSupabaseAdmin(c)
  try {
    await admin.from('role_bindings')
      .delete()
      .eq('principal_type', 'user')
      .eq('principal_id', userId)
  }
  catch {}
  try {
    await admin.from('org_users').delete().eq('user_id', userId)
  }
  catch {}
  try {
    await admin.from('users').delete().eq('id', userId)
  }
  catch {}
  try {
    await admin.auth.admin.deleteUser(userId)
  }
  catch {}
}

async function ensurePublicUserRowExists(
  c: Parameters<typeof useSupabaseAdmin>[0],
  supabaseAdmin: ReturnType<typeof useSupabaseAdmin>,
  userId: string,
  invitation: any,
  optForNewsletters: boolean,
) {
  const { data: existingRows, error: existingError } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('id', userId)

  if (existingError) {
    return quickError(500, 'failed_to_accept_invitation', 'Failed to check existing user row', { error: existingError.message })
  }

  if (existingRows && existingRows.length > 0)
    return

  const insertPayload = {
    id: userId,
    email: invitation.email,
    first_name: invitation.first_name,
    last_name: invitation.last_name,
    enable_notifications: true,
    opt_for_newsletters: optForNewsletters,
    created_via_invite: true,
  }

  let { error: insertError } = await supabaseAdmin.from('users').insert(insertPayload)

  // Log any initial error for observability during rollout
  if (insertError) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'ensurePublicUserRowExists: initial insert error',
      error: insertError,
    })
  }

  // Backward compatible rollout: if the column doesn't exist yet, retry without it.
  if (isMissingCreatedViaInviteColumnError(insertError)) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'ensurePublicUserRowExists: created_via_invite column missing, retrying without it',
    })
    const { created_via_invite: _createdViaInvite, ...fallbackPayload } = insertPayload
    ;({ error: insertError } = await supabaseAdmin.from('users').insert(fallbackPayload))
  }

  if (insertError) {
    return quickError(500, 'failed_to_accept_invitation', 'Failed to create user row', { error: insertError.message })
  }
}

async function ensureOrgMembership(
  c: Parameters<typeof useSupabaseAdmin>[0],
  _supabaseAdmin: ReturnType<typeof useSupabaseAdmin>,
  userId: string,
  invitation: any,
) {
  const pgPool = getPgClient(c, false)
  let pgClient: PoolClient | null = null
  let transactionStarted = false

  try {
    pgClient = await pgPool.connect()
    await pgClient.query('BEGIN')
    transactionStarted = true

    await pgClient.query(
      `SELECT public.lock_rbac_orgs($1::uuid)`,
      [invitation.org_id],
    )

    const inviteRoleResult = await pgClient.query<{ rbac_role_name: string | null }>(
      `SELECT invite_role.rbac_role_name
       FROM (
         SELECT public.tmp_users.rbac_role_name
         FROM public.tmp_users
         WHERE public.tmp_users.invite_magic_string = $1::text
           AND public.tmp_users.cancelled_at IS NULL
         UNION ALL
         SELECT public.org_users.rbac_role_name
         FROM public.org_users
         WHERE public.org_users.user_id = $2::uuid
           AND public.org_users.org_id = $3::uuid
           AND public.org_users.is_invite IS TRUE
           AND public.org_users.app_id IS NULL
           AND public.org_users.channel_id IS NULL
       ) AS invite_role
       WHERE invite_role.rbac_role_name IS NOT NULL
       LIMIT 1`,
      [invitation.invite_magic_string, userId, invitation.org_id],
    )

    const rbacRoleName = inviteRoleResult.rows[0]?.rbac_role_name?.trim() ?? ''
    if (!rbacRoleName) {
      await pgClient.query('ROLLBACK')
      transactionStarted = false
      return quickError(500, 'failed_to_accept_invitation', 'Failed to resolve RBAC role', { error: 'Missing RBAC role name' })
    }

    const roleResult = await pgClient.query<{ id: string }>(
      `SELECT public.roles.id
       FROM public.roles
       WHERE public.roles.name = $1::text
         AND public.roles.scope_type = 'org'
       LIMIT 1`,
      [rbacRoleName],
    )
    const role = roleResult.rows[0]
    if (!role) {
      await pgClient.query('ROLLBACK')
      transactionStarted = false
      return quickError(500, 'failed_to_accept_invitation', 'Failed to resolve RBAC role', { error: 'Role not found' })
    }

    const existingMembership = await pgClient.query<{ id: string }>(
      `SELECT public.org_users.id
       FROM public.org_users
       WHERE public.org_users.user_id = $1::uuid
         AND public.org_users.org_id = $2::uuid
         AND public.org_users.app_id IS NULL
         AND public.org_users.channel_id IS NULL
       LIMIT 1`,
      [userId, invitation.org_id],
    )

    if (existingMembership.rows.length > 0) {
      await pgClient.query(
        `UPDATE public.org_users
         SET rbac_role_name = $3::text,
             is_invite = false
         WHERE public.org_users.user_id = $1::uuid
           AND public.org_users.org_id = $2::uuid
           AND public.org_users.app_id IS NULL
           AND public.org_users.channel_id IS NULL`,
        [userId, invitation.org_id, rbacRoleName],
      )
    }
    else {
      await pgClient.query(
        `INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
         VALUES ($1::uuid, $2::uuid, $3::text, false)`,
        [userId, invitation.org_id, rbacRoleName],
      )
    }

    await pgClient.query(
      `DELETE FROM public.role_bindings
       WHERE public.role_bindings.principal_type = 'user'
         AND public.role_bindings.principal_id = $1::uuid
         AND public.role_bindings.scope_type = 'org'
         AND public.role_bindings.org_id = $2::uuid`,
      [userId, invitation.org_id],
    )

    await pgClient.query(
      `INSERT INTO public.role_bindings (
         principal_type,
         principal_id,
         role_id,
         scope_type,
         org_id,
         granted_by,
         granted_at,
         reason,
         is_direct
       ) VALUES (
         'user',
         $1::uuid,
         $2::uuid,
         'org',
         $3::uuid,
         $1::uuid,
         now(),
         'Accepted invitation',
         true
       )`,
      [userId, role.id, invitation.org_id],
    )

    await pgClient.query('COMMIT')
    transactionStarted = false
  }
  catch (error) {
    if (transactionStarted && pgClient) {
      await pgClient.query('ROLLBACK').catch(() => {})
    }
    cloudlog({
      requestId: c.get('requestId'),
      message: 'ensureOrgMembership transaction failed',
      userId,
      orgId: invitation.org_id,
      error,
    })
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return quickError(500, 'failed_to_accept_invitation', 'Failed to finalize org membership', { error: errorMessage })
  }
  finally {
    pgClient?.release()
    closeClient(c, pgPool)
  }
}

app.post('/', async (c) => {
  const rawBody = await parseBody<AcceptInvitation>(c)

  // First, validate base schema (without password policy checks)
  const baseValidationResult = safeParseSchema(baseInvitationSchema, rawBody)
  if (!baseValidationResult.success) {
    throw simpleError('invalid_json_body', 'Invalid request', { errors: baseValidationResult.error.message })
  }

  const baseBody = baseValidationResult.data
  const { password: _password, captchaToken: _captchaToken, magic_invite_string: _magicInviteString, ...baseBodyWithoutSecrets } = baseBody
  cloudlog({ requestId: c.get('requestId'), context: 'accept_invitation raw body', rawBody: baseBodyWithoutSecrets })

  const supabaseAdmin = useSupabaseAdmin(c)

  // Get the invitation to find the org_id
  const { data: invitation, error: invitationError } = await supabaseAdmin.from('tmp_users')
    .select('*')
    .eq('invite_magic_string', baseBody.magic_invite_string)
    .maybeSingle()

  if (invitationError) {
    return quickError(500, 'failed_to_accept_invitation', 'Failed to accept invitation get tmp_users', { error: invitationError.message })
  }

  if (!invitation) {
    return quickError(404, 'failed_to_accept_invitation', 'Invitation not found', { error: 'Invitation not found' })
  }

  if (invitation.cancelled_at) {
    return quickError(410, 'invitation_cancelled', 'Invitation was cancelled', { error: 'Invitation was cancelled' })
  }

  // Get the org's password policy
  const { data: org, error: orgError } = await supabaseAdmin.from('orgs')
    .select('password_policy_config')
    .eq('id', invitation.org_id)
    .single()

  if (orgError) {
    return quickError(500, 'failed_to_accept_invitation', 'Failed to get org password policy', { error: orgError.message })
  }

  const captchaSecret = getEnv(c, 'CAPTCHA_SECRET_KEY')
  if (captchaSecret.length > 0 && !baseBody.captchaToken) {
    throw simpleError('invalid_request', 'Captcha token is required')
  }

  // Recovery + compatibility: if the user already exists, sign-in and finish the org membership.
  // This also recovers from partial failures where the user was created but the invite wasn't finalized.
  const { data: existingUser } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('email', invitation.email)
    .maybeSingle()

  if (existingUser?.id) {
    const userSupabase = emptySupabase(c)
    const { data: session, error: sessionError } = await userSupabase.auth.signInWithPassword({
      email: invitation.email,
      password: baseBody.password,
      options: captchaSecret.length > 0 && baseBody.captchaToken
        ? { captchaToken: baseBody.captchaToken }
        : undefined,
    })

    if (sessionError) {
      return quickError(400, 'sign_in_failed', 'Sign in failed, please retry', { error: sessionError.message })
    }

    const userId = session.user?.id ?? existingUser.id
    const membershipError = await ensureOrgMembership(c, supabaseAdmin, userId, invitation)
    if (membershipError)
      return membershipError

    // Remove the invite only after the org membership is created successfully.
    const { error: tmpUserDeleteError } = await supabaseAdmin.from('tmp_users').delete().eq('invite_magic_string', baseBody.magic_invite_string)
    if (tmpUserDeleteError) {
      return quickError(500, 'failed_to_accept_invitation', 'Failed to accept invitation delete tmp_users', { error: tmpUserDeleteError.message })
    }

    return c.json({
      access_token: session.session?.access_token,
      refresh_token: session.session?.refresh_token,
    })
  }

  // Use org's password policy if enabled, otherwise use default (new user only)
  const policyConfig = org?.password_policy_config as unknown as PasswordPolicy | null
  const passwordPolicy: PasswordPolicy = policyConfig?.enabled
    ? {
        ...policyConfig,
        min_length: getEffectivePasswordMinLength(policyConfig.min_length),
      }
    : DEFAULT_PASSWORD_POLICY

  const passwordPolicyErrors = getPasswordPolicyValidationErrors(baseBody.password, passwordPolicy)
  if (passwordPolicyErrors.length > 0) {
    throw simpleError('invalid_password', 'Password does not meet requirements', {
      errors: passwordPolicyErrors,
      policy: {
        min_length: passwordPolicy.min_length,
        require_uppercase: passwordPolicy.require_uppercase,
        require_number: passwordPolicy.require_number,
        require_special: passwordPolicy.require_special,
      },
    })
  }

  const body = {
    ...baseBody,
    password: baseBody.password,
  }
  const { password: _pwd, captchaToken: _cap, magic_invite_string: _magicInviteString2, ...bodyWithoutSecrets } = body
  cloudlog({ requestId: c.get('requestId'), context: 'accept_invitation validated body', body: bodyWithoutSecrets })

  // here the real magic happens
  const { data: user, error: userError } = await supabaseAdmin.auth.admin.createUser({
    email: invitation.email,
    password: body.password,
    email_confirm: true,
    id: invitation.future_uuid,
  })

  if (userError || !user) {
    if (isUserAlreadyExistsAuthError(userError)) {
      // Possible partial state: auth user exists but public.users is missing.
      const userSupabase = emptySupabase(c)
      const { data: session, error: sessionError } = await userSupabase.auth.signInWithPassword({
        email: invitation.email,
        password: body.password,
        options: captchaSecret.length > 0 && body.captchaToken
          ? { captchaToken: body.captchaToken }
          : undefined,
      })
      if (!sessionError && session.user?.id) {
        const publicUserError = await ensurePublicUserRowExists(c, supabaseAdmin, session.user.id, invitation, body.opt_for_newsletters)
        if (publicUserError)
          return publicUserError

        const membershipError = await ensureOrgMembership(c, supabaseAdmin, session.user.id, invitation)
        if (membershipError)
          return membershipError

        const { error: tmpUserDeleteError } = await supabaseAdmin.from('tmp_users').delete().eq('invite_magic_string', body.magic_invite_string)
        if (tmpUserDeleteError) {
          return quickError(500, 'failed_to_accept_invitation', 'Failed to accept invitation delete tmp_users', { error: tmpUserDeleteError.message })
        }

        return c.json({
          access_token: session.session?.access_token,
          refresh_token: session.session?.refresh_token,
        })
      }

      return quickError(409, 'user_already_exists', 'Account already exists. Please login and accept the invitation from the dashboard.', {
        error: userError?.message ?? 'User already exists',
      })
    }
    return quickError(500, 'failed_to_accept_invitation', 'Failed to accept invitation createUser', { error: userError?.message ?? 'Unknown error' })
  }

  let didRollback = false
  try {
    // TODO: improve error handling
    const insertUserPayload = {
      id: user.user.id,
      email: invitation.email,
      first_name: invitation.first_name,
      last_name: invitation.last_name,
      enable_notifications: true,
      opt_for_newsletters: body.opt_for_newsletters,
      created_via_invite: true,
    }

    let {
      error: userNormalTableError,
      data,
    } = await supabaseAdmin.from('users').insert(insertUserPayload).select().single()

    // Log any initial error for observability during rollout
    if (userNormalTableError) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'accept_invitation: initial user insert error',
        error: userNormalTableError,
      })
    }

    // Backward compatible rollout: if the column doesn't exist yet, retry without it.
    if (isMissingCreatedViaInviteColumnError(userNormalTableError)) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'accept_invitation: created_via_invite column missing, retrying without it',
      })
      const { created_via_invite: _createdViaInvite, ...fallbackPayload } = insertUserPayload
      ;({ error: userNormalTableError, data } = await supabaseAdmin.from('users').insert(fallbackPayload).select().single())
    }

    if (userNormalTableError) {
      didRollback = true
      await rollbackCreatedUser(c, user.user.id)
      return quickError(500, 'failed_to_accept_invitation', 'Failed to accept invitation insert', { error: userNormalTableError.message })
    }

    await syncUserPreferenceTags(c, invitation.email, data)

    // let's now login the user in. The rough idea is that we will create a session and then return the session to the client
    // then the client will use the session to redirect to login page.
    const userSupabase = emptySupabase(c)
    const { data: session, error: sessionError } = await userSupabase.auth.signInWithPassword({
      email: invitation.email,
      password: body.password,
      options: captchaSecret.length > 0 && body.captchaToken
        ? { captchaToken: body.captchaToken }
        : undefined,
    })

    if (sessionError) {
      // Rollback so retrying the same invitation does not get stuck on `createUser`.
      didRollback = true
      await rollbackCreatedUser(c, user.user.id)
      return quickError(400, 'sign_in_failed', 'Sign in failed, please retry', { error: sessionError.message })
    }

    const membershipError = await ensureOrgMembership(c, supabaseAdmin, user.user.id, invitation)
    if (membershipError) {
      didRollback = true
      await rollbackCreatedUser(c, user.user.id)
      return membershipError
    }
    // Remove the invite only after the account + org membership are created successfully.
    const { error: tmpUserDeleteError } = await supabaseAdmin.from('tmp_users').delete().eq('invite_magic_string', body.magic_invite_string)
    if (tmpUserDeleteError) {
      return quickError(500, 'failed_to_accept_invitation', 'Failed to accept invitation delete tmp_users', { error: tmpUserDeleteError.message })
    }

    return c.json({
      access_token: session.session?.access_token,
      refresh_token: session.session?.refresh_token,
    })
  }
  catch (e) {
    if (!didRollback) {
      await rollbackCreatedUser(c, user.user.id)
    }
    throw e
  }
})
