import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import { createHono, quickError, useCors } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_jwt.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import { getPgClient } from '../../utils/pg.ts'
import { supabaseAdmin } from '../../utils/supabase.ts'
import { version } from '../../utils/version.ts'

interface PublicUserSeed {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
}

type OrgRoleName
  = 'org_member'
    | 'org_billing_admin'
    | 'org_admin'
    | 'org_super_admin'

interface EnsureOrgMembershipResult {
  alreadyMember: boolean
}

interface SsoProviderRecord {
  id: string
  org_id: string
  provider_id: string | null
  enforce_sso?: boolean | null
}

export const app = createHono('', version)

app.use('*', useCors)
app.use('*', middlewareAuth)

async function findCanonicalAuthUserIdByEmail(pgClient: ReturnType<typeof getPgClient>, email: string, excludedUserId: string, trustedProviders: string[]): Promise<string | null> {
  const result = await pgClient.query<{ id: string }>(
    `
      select au.id
      from auth.users au
      left join public.users pu
        on pu.id = au.id
      where lower(au.email) = lower($1)
        and au.id <> $2
      order by
        case when pu.id is not null then 0 else 1 end,
        case when exists (
          select 1
          from auth.identities ai
          where ai.user_id = au.id
            and ai.provider = any($3::text[])
        ) then 0 else 1 end,
        au.created_at asc,
        au.id asc
      limit 1
    `,
    [email, excludedUserId, trustedProviders],
  )

  return result.rows[0]?.id ?? null
}

function getTrustedSsoProviders(userProvider: string, userIdentities: any[]): string[] {
  const trustedProviders = new Set<string>()
  const isTrustedSsoProvider = (provider: string) => provider === 'sso' || provider.startsWith('sso:')

  if (isTrustedSsoProvider(userProvider)) {
    trustedProviders.add(userProvider)
  }

  for (const identity of userIdentities) {
    const provider = identity?.provider
    if (provider && isTrustedSsoProvider(provider)) {
      trustedProviders.add(provider)
    }
  }

  return [...trustedProviders]
}

function extractProviderId(provider: unknown): string | null {
  if (typeof provider !== 'string' || !provider.startsWith('sso:')) {
    return null
  }

  const providerId = provider.slice('sso:'.length).trim()
  return providerId.length > 0 ? providerId : null
}

function getAuthenticatedSsoProviders(userProvider: string | undefined, userProviders: string[], userIdentities: any[]): string[] {
  const currentProviderId = extractProviderId(userProvider)
  if (currentProviderId) {
    return [`sso:${currentProviderId}`]
  }

  const providers = new Set<string>()
  const addProvider = (provider: unknown) => {
    const providerId = extractProviderId(provider)
    if (providerId) {
      providers.add(`sso:${providerId}`)
    }
  }

  for (const provider of userProviders) {
    addProvider(provider)
  }
  for (const identity of userIdentities) {
    addProvider(identity?.provider)
  }

  return [...providers]
}

function getAuthorizedSsoProviders(provider: SsoProviderRecord, authenticatedProviders: string[]): string[] {
  const authorizedProviderIds = new Set(
    [provider.provider_id]
      .filter((providerId): providerId is string => typeof providerId === 'string' && providerId.length > 0),
  )

  return authenticatedProviders.filter((authenticatedProvider) => {
    const providerId = extractProviderId(authenticatedProvider)
    return !!providerId && authorizedProviderIds.has(providerId)
  })
}

async function transferSsoIdentities(pgClient: ReturnType<typeof getPgClient>, originalUserId: string, duplicateUserId: string, trustedProviders: string[]): Promise<number> {
  const result = await pgClient.query(
    `
      update auth.identities
      set user_id = $1,
          updated_at = now()
      where user_id = $2
        and provider = any($3::text[])
    `,
    [originalUserId, duplicateUserId, trustedProviders],
  )

  return result.rowCount ?? 0
}

async function setAuthUserSsoOnly(pgClient: ReturnType<typeof getPgClient>, userId: string, authorizedSsoProviders: string[]): Promise<void> {
  const primarySsoProvider = authorizedSsoProviders[0]
  if (!primarySsoProvider) {
    throw new Error('missing_sso_provider')
  }

  await pgClient.query(
    `
      update auth.users
      set is_sso_user = true,
          encrypted_password = null,
          raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
            || jsonb_build_object(
              'provider', $2::text,
              'providers', to_jsonb($3::text[])
            ),
          updated_at = now()
      where id = $1
    `,
    [userId, primarySsoProvider, authorizedSsoProviders],
  )

  await pgClient.query(
    `
      delete from auth.identities
      where user_id = $1
        and provider <> all($2::text[])
    `,
    [userId, authorizedSsoProviders],
  )

  await pgClient.query(
    `
      delete from auth.sessions
      where user_id = $1
    `,
    [userId],
  )
}

function buildPublicUserSeed(userId: string, email: string, userMetadata: Record<string, unknown> | undefined): PublicUserSeed {
  return {
    id: userId,
    email,
    first_name: typeof userMetadata?.first_name === 'string' ? userMetadata.first_name : null,
    last_name: typeof userMetadata?.last_name === 'string' ? userMetadata.last_name : null,
  }
}

async function ensureOrgMembership(
  pgClient: ReturnType<typeof getPgClient>,
  requestId: string,
  userId: string,
  orgId: string,
  fallbackRole: OrgRoleName = 'org_member',
): Promise<EnsureOrgMembershipResult> {
  await pgClient.query('begin')
  try {
    const membershipResult = await ensureOrgMembershipInTransaction(pgClient, requestId, userId, orgId, fallbackRole)
    await pgClient.query('commit')
    return membershipResult
  }
  catch (error) {
    try {
      await pgClient.query('rollback')
    }
    catch (rollbackError) {
      cloudlogErr({ requestId, message: 'Failed to roll back SSO provisioning transaction', userId, orgId, error: rollbackError })
    }
    throw error
  }
}

async function ensurePublicUserRowExists(
  admin: ReturnType<typeof supabaseAdmin>,
  requestId: string,
  user: PublicUserSeed,
): Promise<void> {
  const { data: existingUser, error: existingUserError } = await (admin as any)
    .from('users')
    .select('id, email')
    .eq('id', user.id)
    .maybeSingle()

  if (existingUserError) {
    cloudlogErr({ requestId, message: 'Failed to check public.users row during SSO provisioning', userId: user.id, error: existingUserError })
    throw new Error('public_user_lookup_failed')
  }

  if (!existingUser) {
    const { error: insertError } = await (admin as any)
      .from('users')
      .insert({
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        enable_notifications: true,
        opt_for_newsletters: true,
      })

    if (insertError) {
      const isDuplicate = insertError.code === '23505' || insertError.message?.toLowerCase().includes('duplicate')
      if (!isDuplicate) {
        cloudlogErr({ requestId, message: 'Failed to create public.users row during SSO provisioning', userId: user.id, email: user.email, error: insertError })
        throw new Error('public_user_insert_failed')
      }
    }
  }

  if (existingUser?.email !== user.email) {
    const { error: updateError } = await (admin as any)
      .from('users')
      .update({ email: user.email })
      .eq('id', user.id)

    if (updateError) {
      cloudlogErr({ requestId, message: 'Failed to sync public.users email during SSO provisioning', userId: user.id, email: user.email, error: updateError })
      throw new Error('public_user_update_failed')
    }
  }
}

async function ensurePublicUserRowExistsInTransaction(
  pgClient: ReturnType<typeof getPgClient>,
  requestId: string,
  user: PublicUserSeed,
): Promise<void> {
  try {
    await pgClient.query(
      `
        insert into public.users (id, email, first_name, last_name, enable_notifications, opt_for_newsletters)
        values ($1, $2, $3, $4, true, true)
        on conflict (id) do update
        set email = excluded.email
        where public.users.email is distinct from excluded.email
      `,
      [user.id, user.email, user.first_name, user.last_name],
    )
  }
  catch (error) {
    cloudlogErr({ requestId, message: 'Failed to sync public.users row during SSO merge transaction', userId: user.id, email: user.email, error })
    throw new Error('public_user_sync_failed')
  }
}

async function ensureOrgMembershipInTransaction(
  pgClient: ReturnType<typeof getPgClient>,
  requestId: string,
  userId: string,
  orgId: string,
  fallbackRole: OrgRoleName = 'org_member',
): Promise<EnsureOrgMembershipResult> {
  const ensureOrgRoleBinding = async (roleName: string, mode: 'replace' | 'repair' = 'replace') => {
    const roleResult = await pgClient.query<{ id: string }>(
      `
        select id
        from public.roles
        where name = $1
          and scope_type = public.rbac_scope_org()
        limit 1
      `,
      [roleName],
    )
    const roleId = roleResult.rows[0]?.id
    if (!roleId) {
      cloudlogErr({ requestId, message: 'Failed to resolve SSO org RBAC role', userId, orgId, roleName })
      throw new Error('missing_org_role')
    }

    if (mode === 'repair') {
      const existingBinding = await pgClient.query<{ id: string }>(
        `
          select id
          from public.role_bindings
          where principal_type = public.rbac_principal_user()
            and principal_id = $1
            and scope_type = public.rbac_scope_org()
            and org_id = $2
          limit 1
        `,
        [userId, orgId],
      )

      if (existingBinding.rows[0])
        return
    }
    else {
      await pgClient.query(
        `
          delete from public.role_bindings
          where principal_type = public.rbac_principal_user()
            and principal_id = $1
            and scope_type = public.rbac_scope_org()
            and org_id = $2
        `,
        [userId, orgId],
      )
    }

    await pgClient.query(
      `
        insert into public.role_bindings (
          principal_type,
          principal_id,
          role_id,
          scope_type,
          org_id,
          granted_by,
          reason,
          is_direct
        )
        values (
          public.rbac_principal_user(),
          $1,
          $3,
          public.rbac_scope_org(),
          $2,
          $1,
          'SSO org membership provisioning',
          true
        )
        on conflict do nothing
      `,
      [userId, orgId, roleId],
    )
  }

  const promoteExistingInvite = async (membershipId: string, isInvite: boolean, roleName: string | null): Promise<EnsureOrgMembershipResult> => {
    const effectiveRole = roleName ?? fallbackRole
    if (!isInvite) {
      await ensureOrgRoleBinding(effectiveRole, 'repair')
      return { alreadyMember: true }
    }

    await pgClient.query(
      `
        update public.org_users
        set is_invite = false,
            rbac_role_name = coalesce($1::text, rbac_role_name, $2::text)
        where id = $3
      `,
      [roleName, fallbackRole, membershipId],
    )

    await ensureOrgRoleBinding(effectiveRole)
    return { alreadyMember: false }
  }

  try {
    const existingMembership = await pgClient.query<{ id: string, is_invite: boolean, rbac_role_name: string | null }>(
      `
        select id, is_invite, rbac_role_name
        from public.org_users
        where user_id = $1
          and org_id = $2
        for update
      `,
      [userId, orgId],
    )

    const existing = existingMembership.rows[0]
    if (existing) {
      return await promoteExistingInvite(existing.id, existing.is_invite, existing.rbac_role_name)
    }

    const insertedMembership = await pgClient.query(
      `
        insert into public.org_users (user_id, org_id, rbac_role_name, is_invite)
        values ($1, $2, $3, false)
        on conflict do nothing
      `,
      [userId, orgId, fallbackRole],
    )

    if ((insertedMembership.rowCount ?? 0) > 0) {
      await ensureOrgRoleBinding(fallbackRole)
      return { alreadyMember: false }
    }

    const racedMembership = await pgClient.query<{ id: string, is_invite: boolean, rbac_role_name: string | null }>(
      `
        select id, is_invite, rbac_role_name
        from public.org_users
        where user_id = $1
          and org_id = $2
        for update
      `,
      [userId, orgId],
    )

    const raced = racedMembership.rows[0]
    if (raced) {
      return await promoteExistingInvite(raced.id, raced.is_invite, raced.rbac_role_name)
    }

    throw new Error('membership_insert_failed')
  }
  catch (error) {
    cloudlogErr({ requestId, message: 'Failed to ensure org membership during SSO merge transaction', userId, orgId, fallbackRole, error })
    throw new Error('provision_failed')
  }
}

async function mergeSsoIdentityWithExistingAccount(
  pgClient: ReturnType<typeof getPgClient>,
  requestId: string,
  params: {
    originalUserId: string
    duplicateUserId: string
    publicUser: PublicUserSeed
    orgId: string
    authorizedSsoProviders: string[]
  },
): Promise<void> {
  await pgClient.query('begin')
  try {
    let transferredIdentityCount = 0
    try {
      transferredIdentityCount = await transferSsoIdentities(pgClient, params.originalUserId, params.duplicateUserId, params.authorizedSsoProviders)
    }
    catch (identityTransferError) {
      cloudlogErr({ requestId, message: 'Failed to transfer SSO identity during merge', userId: params.duplicateUserId, originalUserId: params.originalUserId, error: identityTransferError })
      throw new Error('identity_transfer_failed')
    }

    if (transferredIdentityCount === 0) {
      cloudlogErr({ requestId, message: 'No SSO identities were transferred during merge', userId: params.duplicateUserId, originalUserId: params.originalUserId })
      throw new Error('identity_transfer_failed')
    }

    await ensurePublicUserRowExistsInTransaction(pgClient, requestId, params.publicUser)
    await ensureOrgMembershipInTransaction(pgClient, requestId, params.originalUserId, params.orgId)

    try {
      await setAuthUserSsoOnly(pgClient, params.originalUserId, params.authorizedSsoProviders)
    }
    catch (ssoFlagError) {
      cloudlogErr({ requestId, message: 'Failed to enforce SSO-only auth state on original user during merge', originalUserId: params.originalUserId, error: ssoFlagError })
      throw new Error('sso_flag_update_failed')
    }

    await pgClient.query('commit')
  }
  catch (error) {
    try {
      await pgClient.query('rollback')
    }
    catch (rollbackError) {
      cloudlogErr({ requestId, message: 'Failed to roll back SSO merge transaction', userId: params.duplicateUserId, originalUserId: params.originalUserId, error: rollbackError })
    }
    throw error
  }
}

app.post('/', async (c: Context<MiddlewareKeyVariables>) => {
  const auth = c.get('auth')
  if (!auth) {
    return quickError(401, 'not_authorized', 'Not authorized')
  }

  const userId = auth.userId
  const requestId = c.get('requestId')

  if (!userId) {
    return quickError(401, 'not_authorized', 'User ID not found in auth context')
  }

  const admin = supabaseAdmin(c)
  let pgClient: ReturnType<typeof getPgClient> | undefined
  const getSharedPgClient = () => {
    pgClient ??= getPgClient(c)
    return pgClient
  }

  try {
    // Verify the user actually authenticated via SSO (not email/password)
    const { data: userAuth, error: userAuthError } = await admin.auth.admin.getUserById(userId)

    if (userAuthError || !userAuth?.user) {
      cloudlogErr({ requestId, message: 'Failed to retrieve user auth data for SSO verification', userId, error: userAuthError })
      return quickError(500, 'user_auth_check_failed', 'Failed to verify authentication method')
    }

    const userProvider = userAuth.user.app_metadata?.provider
    const userProviders: string[] = userAuth.user.app_metadata?.providers ?? []
    const isSsoProvider = (p: string) => p === 'sso' || p.startsWith('sso:')
    if (!isSsoProvider(userProvider ?? '') && !userProviders.some(isSsoProvider)) {
      cloudlog({ requestId, message: 'User did not authenticate via SSO, rejecting provisioning', userId, provider: userProvider, providers: userProviders })
      return quickError(403, 'sso_auth_required', 'User must authenticate via SSO to be provisioned')
    }

    const userIdentities = userAuth.user.identities ?? []
    const trustedSsoProviders = getTrustedSsoProviders(userProvider ?? '', userIdentities)
    if (trustedSsoProviders.length === 0) {
      cloudlog({ requestId, message: 'User has no SSO identity, rejecting provisioning', userId })
      return quickError(403, 'sso_identity_required', 'User must have an SSO identity to be provisioned')
    }
    const authenticatedSsoProviders = getAuthenticatedSsoProviders(userProvider, userProviders, userIdentities)

    const userEmail = userAuth.user.email
    if (!userEmail) {
      return quickError(400, 'no_email', 'User has no email address')
    }
    const publicUserSeed = buildPublicUserSeed(userId, userEmail, userAuth.user.user_metadata)

    const userDomain = userEmail.split('@')[1]?.toLowerCase().trim()
    if (!userDomain) {
      return quickError(400, 'invalid_email', 'User email has no domain')
    }

    // Detect pre-existing auth identity with the same trusted email (different UUID).
    // This happens when SSO is enabled for a domain where users already had email/password accounts.
    // Supabase Auth creates a new auth.users record instead of linking — we fix this by merging.
    //
    // Security note: never resolve the merge candidate from public.users.email. That profile
    // column is user-editable; only auth.users.email and the current verified SSO session are
    // trusted identity sources for account linking.
    let resolvedExistingUserId: string | null = null
    try {
      resolvedExistingUserId = await findCanonicalAuthUserIdByEmail(getSharedPgClient(), userEmail, userId, trustedSsoProviders)
      if (resolvedExistingUserId) {
        cloudlog({ requestId, message: 'Canonical pre-existing auth account found — will merge SSO identity after provider authorization', userId, originalUserId: resolvedExistingUserId, email: userEmail })
      }
    }
    catch (existingAuthUserError) {
      cloudlogErr({ requestId, message: 'Failed to check auth.users for pre-existing account by email', userId, email: userEmail, error: existingAuthUserError })
      return quickError(500, 'user_lookup_failed', 'Failed to resolve existing account for SSO merge')
    }

    if (resolvedExistingUserId) {
      const originalUserId = resolvedExistingUserId
      cloudlog({ requestId, message: 'Pre-existing user found with same email — merging SSO identity', userId, originalUserId, email: userEmail })

      if (trustedSsoProviders.length === 0) {
        cloudlog({ requestId, message: 'User has no trusted SSO provider to transfer during merge', userId, originalUserId, provider: userProvider })
        return quickError(403, 'sso_identity_required', 'User must have a trusted SSO identity to be provisioned')
      }

      // Step 1: Resolve the SSO provider org so we can ensure the original user is a member
      const { data: mergeProvider, error: mergeProviderError } = await (admin as any)
        .from('sso_providers')
        .select('id, org_id, provider_id')
        .eq('domain', userDomain)
        .eq('status', 'active')
        .maybeSingle()

      if (mergeProviderError) {
        cloudlogErr({ requestId, message: 'Failed to resolve SSO provider during merge', originalUserId, domain: userDomain, error: mergeProviderError })
        return quickError(500, 'provider_lookup_failed', 'Failed to resolve SSO provider for your email domain')
      }

      if (!mergeProvider) {
        cloudlogErr({ requestId, message: 'No active SSO provider found during merge', originalUserId, domain: userDomain })
        return quickError(404, 'provider_not_found', 'No active SSO provider found for your email domain')
      }

      const authorizedSsoProviders = getAuthorizedSsoProviders(mergeProvider, authenticatedSsoProviders)
      if (authorizedSsoProviders.length === 0) {
        cloudlog({ requestId, message: 'Authenticating SSO provider does not match email domain provider — aborting merge', userId, originalUserId, domain: userDomain, providerId: mergeProvider.id, externalProviderId: mergeProvider.provider_id, authenticatedProviders: authenticatedSsoProviders })
        return quickError(403, 'provider_mismatch', 'SSO provider does not match the email domain provider')
      }

      // Step 2: Transfer the SSO identity and provision the merged account atomically.
      try {
        await mergeSsoIdentityWithExistingAccount(getSharedPgClient(), requestId, {
          originalUserId,
          duplicateUserId: userId,
          publicUser: {
            ...publicUserSeed,
            id: originalUserId,
          },
          orgId: mergeProvider.org_id,
          authorizedSsoProviders,
        })
      }
      catch (mergeError) {
        if (mergeError instanceof Error) {
          if (mergeError.message === 'identity_transfer_failed') {
            return quickError(500, 'identity_transfer_failed', 'Failed to merge SSO identity with existing account')
          }
          if (mergeError.message === 'public_user_sync_failed') {
            return quickError(500, 'public_user_sync_failed', 'Failed to create user profile for merged SSO account')
          }
          if (mergeError.message === 'provision_failed') {
            return quickError(500, 'provision_failed', 'Failed to provision user to organization')
          }
          if (mergeError.message === 'sso_flag_update_failed') {
            return quickError(500, 'sso_flag_update_failed', 'Failed to enforce SSO on merged account')
          }
        }

        cloudlogErr({ requestId, message: 'Failed to complete SSO merge transaction', userId, originalUserId, error: mergeError })
        return quickError(500, 'merge_failed', 'Failed to merge SSO account')
      }

      // Step 3: Delete the duplicate auth user (cascades to public.users, orgs, org_users)
      const { error: deleteError } = await admin.auth.admin.deleteUser(userId)
      if (deleteError) {
        cloudlogErr({ requestId, message: 'Failed to delete duplicate SSO user after identity transfer', userId, originalUserId, error: deleteError })
        // Identity already transferred — log but still return merged so frontend redirects to login
      }

      cloudlog({ requestId, message: 'SSO account merged successfully — user must re-login', userId, originalUserId })
      return c.json({ success: true, merged: true })
    }

    // Resolve the provider from the user's email domain server-side
    const { data: provider, error: providerError } = await (admin as any)
      .from('sso_providers')
      .select('id, org_id, domain, status, provider_id')
      .eq('domain', userDomain)
      .eq('status', 'active')
      .maybeSingle()

    if (providerError) {
      cloudlogErr({ requestId, message: 'Failed to resolve SSO provider for domain', userId, domain: userDomain, error: providerError })
      return quickError(500, 'provider_lookup_failed', 'Failed to resolve SSO provider for your email domain')
    }

    if (!provider) {
      cloudlog({ requestId, message: 'No active SSO provider found for domain', userId, domain: userDomain })
      return quickError(404, 'provider_not_found', 'No active SSO provider found for your email domain')
    }

    const authorizedSsoProviders = getAuthorizedSsoProviders(provider, authenticatedSsoProviders)
    if (authorizedSsoProviders.length === 0) {
      cloudlog({ requestId, message: 'Authenticating SSO provider does not match email domain provider — rejecting provisioning', userId, domain: userDomain, providerId: provider.id, externalProviderId: provider.provider_id, authenticatedProviders: authenticatedSsoProviders })
      return quickError(403, 'provider_mismatch', 'SSO provider does not match the email domain provider')
    }

    try {
      await ensurePublicUserRowExists(admin, requestId, publicUserSeed)
    }
    catch {
      return quickError(500, 'public_user_sync_failed', 'Failed to create user profile for SSO account')
    }

    let membershipResult: EnsureOrgMembershipResult
    try {
      membershipResult = await ensureOrgMembership(getSharedPgClient(), requestId, userId, provider.org_id)
    }
    catch {
      return quickError(500, 'provision_failed', 'Failed to provision user to organization')
    }

    if (membershipResult.alreadyMember) {
      cloudlog({ requestId, message: 'User already belongs to org', userId, orgId: provider.org_id })
      return c.json({ success: true, already_member: true })
    }

    cloudlog({ requestId, message: 'SSO user provisioned successfully', userId, orgId: provider.org_id, providerId: provider.id })
    return c.json({ success: true })
  }
  finally {
    if (pgClient) {
      await pgClient.end()
    }
  }
})
