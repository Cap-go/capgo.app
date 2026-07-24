import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { z } from 'zod'
import { Hono } from 'hono/tiny'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { getEffectivePasswordMinLength, getPasswordPolicyValidationErrors } from '../utils/password_policy.ts'
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
  supabaseAdmin: ReturnType<typeof useSupabaseAdmin>,
  userId: string,
  invitation: any,
) {
  const rbacRoleName = typeof invitation.rbac_role_name === 'string'
    ? invitation.rbac_role_name.trim()
    : ''

  if (!rbacRoleName) {
    return quickError(500, 'failed_to_accept_invitation', 'Failed to resolve RBAC role', { error: 'Missing RBAC role name' })
  }

  let rbacRoleId: string | null = null

  const { data: role, error: roleError } = await supabaseAdmin
    .from('roles')
    .select('id')
    .eq('name', rbacRoleName)
    .eq('scope_type', 'org')
    .single()

  if (roleError || !role) {
    return quickError(500, 'failed_to_accept_invitation', 'Failed to resolve RBAC role', { error: roleError?.message ?? 'Role not found' })
  }

  rbacRoleId = role.id

  // Avoid creating duplicates: org_users does not have a unique constraint on (org_id, user_id).
  const { data: existingMembershipRows, error: existingMembershipError } = await supabaseAdmin
    .from('org_users')
    .select('id')
    .eq('user_id', userId)
    .eq('org_id', invitation.org_id)
    .is('app_id', null)
    .is('channel_id', null)

  if (existingMembershipError) {
    return quickError(500, 'failed_to_accept_invitation', 'Failed to check existing org membership', { error: existingMembershipError.message })
  }

  if (existingMembershipRows && existingMembershipRows.length > 0) {
    const { error: updateMembershipError } = await supabaseAdmin
      .from('org_users')
      .update({
        rbac_role_name: rbacRoleName,
        is_invite: false,
      })
      .eq('user_id', userId)
      .eq('org_id', invitation.org_id)
      .is('app_id', null)
      .is('channel_id', null)

    if (updateMembershipError) {
      return quickError(500, 'failed_to_accept_invitation', 'Failed to update org membership', { error: updateMembershipError.message })
    }
  }
  else {
    const { error: insertIntoMainTableError } = await supabaseAdmin.from('org_users').insert({
      user_id: userId,
      org_id: invitation.org_id,
      rbac_role_name: rbacRoleName,
      is_invite: false,
    })

    if (insertIntoMainTableError) {
      return quickError(500, 'failed_to_accept_invitation', 'Failed to accept invitation insert into org_users', { error: insertIntoMainTableError.message })
    }
  }

  const { error: deleteBindingError } = await supabaseAdmin
    .from('role_bindings')
    .delete()
    .eq('principal_type', 'user')
    .eq('principal_id', userId)
    .eq('scope_type', 'org')
    .eq('org_id', invitation.org_id)

  if (deleteBindingError) {
    return quickError(500, 'failed_to_accept_invitation', 'Failed to clear existing RBAC role bindings', { error: deleteBindingError.message })
  }

  const { error: insertBindingError } = await supabaseAdmin
    .from('role_bindings')
    .insert({
      principal_type: 'user',
      principal_id: userId,
      role_id: rbacRoleId as string,
      scope_type: 'org',
      org_id: invitation.org_id,
      granted_by: userId,
      granted_at: new Date().toISOString(),
      reason: 'Accepted invitation',
      is_direct: true,
    })

  if (insertBindingError) {
    return quickError(500, 'failed_to_accept_invitation', 'Failed to create RBAC role binding', { error: insertBindingError.message })
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
    const membershipError = await ensureOrgMembership(supabaseAdmin, userId, invitation)
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

        const membershipError = await ensureOrgMembership(supabaseAdmin, session.user.id, invitation)
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

    const membershipError = await ensureOrgMembership(supabaseAdmin, user.user.id, invitation)
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
