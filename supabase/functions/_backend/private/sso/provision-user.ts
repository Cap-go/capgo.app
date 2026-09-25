import type { Context } from 'hono'
import type { PoolClient } from 'pg'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { SsoAccess } from './role-mapping.ts'
import { createHono, quickError, useCors } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_jwt.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import { getPgClient, withPgTransaction } from '../../utils/pg.ts'
import { supabaseAdmin } from '../../utils/supabase.ts'
import { version } from '../../utils/version.ts'
import { mappedAttributes, parseStoredRoleMapping, readAttributeValues, resolveSsoAccess } from './role-mapping.ts'

// Transactions go through withPgTransaction (one checked-out connection);
// plain reads may use the pool directly.
type PgExecutor = ReturnType<typeof getPgClient> | PoolClient

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
  // The provider's role mapping grants no role: org access was revoked.
  noAccess?: boolean
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

async function findCanonicalAuthUserIdByEmail(pgClient: PgExecutor, email: string, excludedUserId: string, trustedProviders: string[]): Promise<string | null> {
  const result = await pgClient.query<{ id: string }>(
    `
      select au.id
      from auth.users au
      left join public.users pu
        on pu.id = au.id
      where lower(au.email) = lower($1)
        and au.id <> $2
        and au.email_confirmed_at is not null
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

// Role mapping input comes from the SSO identity that authenticated this login;
// Supabase Auth refreshes its identity_data on every SAML login.
function resolveMappedAccess(provider: { role_mapping?: unknown }, authorizedSsoProviders: string[], identities: any[]): SsoAccess | null {
  const mapping = parseStoredRoleMapping(provider.role_mapping)
  if (!mapping)
    return null
  const identity = identities.find(candidate => authorizedSsoProviders.includes(candidate?.provider))
  return resolveSsoAccess(mapping, readAttributeValues(identity?.identity_data, mappedAttributes(mapping)))
}

async function transferSsoIdentities(pgClient: PgExecutor, originalUserId: string, duplicateUserId: string, trustedProviders: string[]): Promise<number> {
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

async function setAuthUserSsoOnly(pgClient: PgExecutor, userId: string, authorizedSsoProviders: string[]): Promise<void> {
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
  pgPool: ReturnType<typeof getPgClient>,
  requestId: string,
  userId: string,
  orgId: string,
  access: SsoAccess | null,
): Promise<EnsureOrgMembershipResult> {
  try {
    return await withPgTransaction(pgPool, client => access
      ? applyMappedAccessInTransaction(client, requestId, userId, orgId, access)
      : ensureOrgMembershipInTransaction(client, requestId, userId, orgId))
  }
  catch (error) {
    cloudlogErr({ requestId, message: 'SSO provisioning transaction rolled back', userId, orgId, error })
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
  pgClient: PgExecutor,
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

// org_users has no unique (user_id, org_id) constraint and FOR UPDATE cannot
// lock a missing row, so concurrent provisioning of the same user (callback
// and auth guard, or a retry after a client timeout) is serialized here.
async function lockOrgMembership(pgClient: PgExecutor, userId: string, orgId: string): Promise<void> {
  await pgClient.query('select pg_advisory_xact_lock(hashtext($1))', [`sso_org_membership:${orgId}:${userId}`])
}

async function ensureOrgMembershipInTransaction(
  pgClient: PgExecutor,
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
    await lockOrgMembership(pgClient, userId, orgId)
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

async function countOtherOrgSuperAdmins(client: PoolClient, orgId: string, userId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `
      select count(*) as count
      from public.role_bindings rb
      join public.roles r on r.id = rb.role_id
      where rb.scope_type = public.rbac_scope_org()
        and rb.org_id = $1
        and rb.principal_type = public.rbac_principal_user()
        and rb.principal_id <> $2
        and r.name = public.rbac_role_org_super_admin()
        and (rb.expires_at is null or rb.expires_at > now())
    `,
    [orgId, userId],
  )
  return Number(result.rows[0]?.count ?? 0)
}

async function getOrgRoleName(client: PoolClient, orgId: string, userId: string): Promise<string | null> {
  const result = await client.query<{ name: string }>(
    `
      select r.name
      from public.role_bindings rb
      join public.roles r on r.id = rb.role_id
      where rb.principal_type = public.rbac_principal_user()
        and rb.principal_id = $1
        and rb.scope_type = public.rbac_scope_org()
        and rb.org_id = $2
      limit 1
    `,
    [userId, orgId],
  )
  return result.rows[0]?.name ?? null
}

// Applies a role mapping result on every login: the IdP is the source of
// truth for the org role and for membership of the groups the mapping
// references (upgrades and downgrades). The org's last super admin is never
// demoted or removed, so a misconfigured IdP cannot orphan the org.
async function applyMappedAccessInTransaction(
  client: PoolClient,
  requestId: string,
  userId: string,
  orgId: string,
  access: SsoAccess,
): Promise<EnsureOrgMembershipResult> {
  await lockOrgMembership(client, userId, orgId)
  const membership = await client.query<{ id: string, is_invite: boolean }>(
    `
      select id, is_invite
      from public.org_users
      where user_id = $1
        and org_id = $2
      for update
    `,
    [userId, orgId],
  )
  const existing = membership.rows[0]
  const currentRole = await getOrgRoleName(client, orgId, userId)
  // Two super admins demoted by concurrent logins could each still count the
  // other: serialize on the same org-wide lock the last-super-admin triggers use.
  if (currentRole === 'org_super_admin')
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [orgId])
  const isLastSuperAdmin = currentRole === 'org_super_admin' && await countOtherOrgSuperAdmins(client, orgId, userId) === 0

  if (access.orgRole === null) {
    if (isLastSuperAdmin) {
      cloudlog({ requestId, message: 'SSO role mapping grants no access but user is the last super admin; keeping membership', userId, orgId })
      return { alreadyMember: true, noAccess: true }
    }
    // Every group of the org, not only mapped ones: group bindings grant
    // permissions without an org_users row.
    await client.query(
      'delete from public.group_members gm using public.groups g where g.id = gm.group_id and g.org_id = $2 and gm.user_id = $1',
      [userId, orgId],
    )
    await client.query(
      `
        delete from public.role_bindings
        where principal_type = public.rbac_principal_user()
          and principal_id = $1
          and org_id = $2
      `,
      [userId, orgId],
    )
    await client.query('delete from public.org_users where user_id = $1 and org_id = $2', [userId, orgId])
    cloudlog({ requestId, message: 'SSO role mapping revoked org access', userId, orgId, hadMembership: !!existing })
    return { alreadyMember: false, noAccess: true }
  }

  const targetRole = isLastSuperAdmin ? 'org_super_admin' : access.orgRole
  if (isLastSuperAdmin && access.orgRole !== 'org_super_admin')
    cloudlog({ requestId, message: 'SSO role mapping would demote the last super admin; keeping org_super_admin', userId, orgId, mappedRole: access.orgRole })

  if (existing) {
    await client.query('update public.org_users set is_invite = false, rbac_role_name = $1 where id = $2', [targetRole, existing.id])
  }
  else {
    await client.query(
      'insert into public.org_users (user_id, org_id, rbac_role_name, is_invite) values ($1, $2, $3, false)',
      [userId, orgId, targetRole],
    )
  }

  if (currentRole !== targetRole) {
    await client.query(
      `
        delete from public.role_bindings
        where principal_type = public.rbac_principal_user()
          and principal_id = $1
          and scope_type = public.rbac_scope_org()
          and org_id = $2
      `,
      [userId, orgId],
    )
    await client.query(
      `
        insert into public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by, reason, is_direct)
        select public.rbac_principal_user(), $1, r.id, public.rbac_scope_org(), $2, $1, 'SSO role mapping', true
        from public.roles r
        where r.name = $3
          and r.scope_type = public.rbac_scope_org()
      `,
      [userId, orgId, targetRole],
    )
  }

  if (access.managedAppIds.length > 0) {
    const appRoles = JSON.stringify(access.appRoles)
    // Drop bindings on mapped apps the user no longer matches, or whose role changed.
    await client.query(
      `
        delete from public.role_bindings rb
        using public.roles r
        where r.id = rb.role_id
          and rb.principal_type = public.rbac_principal_user()
          and rb.principal_id = $1
          and rb.scope_type = public.rbac_scope_app()
          and rb.app_id = any($2::uuid[])
          and r.name is distinct from ($3::jsonb ->> rb.app_id::text)
      `,
      [userId, access.managedAppIds, appRoles],
    )
    await client.query(
      `
        insert into public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by, reason, is_direct)
        select public.rbac_principal_user(), $1, r.id, public.rbac_scope_app(), $2, a.id, $1, 'SSO role mapping', true
        from jsonb_each_text($3::jsonb) mapped
        join public.apps a on a.id = mapped.key::uuid and a.owner_org = $2
        join public.roles r on r.name = mapped.value and r.scope_type = public.rbac_scope_app()
        on conflict do nothing
      `,
      [userId, orgId, appRoles],
    )
  }

  const removedGroupIds = access.managedGroupIds.filter(groupId => !access.groupIds.includes(groupId))
  if (removedGroupIds.length > 0)
    await client.query('delete from public.group_members where user_id = $1 and group_id = any($2::uuid[])', [userId, removedGroupIds])
  if (access.groupIds.length > 0) {
    await client.query(
      `
        insert into public.group_members (group_id, user_id, added_by)
        select g.id, $1, $1
        from public.groups g
        where g.id = any($2::uuid[])
          and g.org_id = $3
        on conflict do nothing
      `,
      [userId, access.groupIds, orgId],
    )
  }

  return { alreadyMember: !!existing && !existing.is_invite }
}

async function mergeSsoIdentityWithExistingAccount(
  pgPool: ReturnType<typeof getPgClient>,
  requestId: string,
  params: {
    originalUserId: string
    duplicateUserId: string
    publicUser: PublicUserSeed
    orgId: string
    authorizedSsoProviders: string[]
    access: SsoAccess | null
  },
): Promise<{ noAccess: boolean }> {
  try {
    return await withPgTransaction(pgPool, async (pgClient) => {
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
      const membership = params.access
        ? await applyMappedAccessInTransaction(pgClient, requestId, params.originalUserId, params.orgId, params.access)
        : await ensureOrgMembershipInTransaction(pgClient, requestId, params.originalUserId, params.orgId)

      try {
        await setAuthUserSsoOnly(pgClient, params.originalUserId, params.authorizedSsoProviders)
      }
      catch (ssoFlagError) {
        cloudlogErr({ requestId, message: 'Failed to enforce SSO-only auth state on original user during merge', originalUserId: params.originalUserId, error: ssoFlagError })
        throw new Error('sso_flag_update_failed')
      }
      // The identity is still linked: the account belongs to this person even
      // when the mapping currently grants them no access.
      return { noAccess: membership.noAccess === true }
    })
  }
  catch (error) {
    cloudlogErr({ requestId, message: 'SSO merge transaction rolled back', userId: params.duplicateUserId, originalUserId: params.originalUserId, error })
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
    // trusted identity sources for account linking. Unconfirmed auth.users rows are ignored
    // so a pre-signup cannot become the merge target.
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
        .select('id, org_id, provider_id, role_mapping')
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
      let mergeResult: { noAccess: boolean }
      try {
        mergeResult = await mergeSsoIdentityWithExistingAccount(getSharedPgClient(), requestId, {
          originalUserId,
          duplicateUserId: userId,
          publicUser: {
            ...publicUserSeed,
            id: originalUserId,
          },
          orgId: mergeProvider.org_id,
          authorizedSsoProviders,
          access: resolveMappedAccess(mergeProvider, authorizedSsoProviders, userIdentities),
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

      if (mergeResult.noAccess)
        return quickError(403, 'sso_no_access', 'Your identity provider does not grant you access to this organization. Contact your administrator.')

      cloudlog({ requestId, message: 'SSO account merged successfully — user must re-login', userId, originalUserId })
      return c.json({ success: true, merged: true })
    }

    // Resolve the provider from the user's email domain server-side
    const { data: provider, error: providerError } = await (admin as any)
      .from('sso_providers')
      .select('id, org_id, domain, status, provider_id, role_mapping')
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
      membershipResult = await ensureOrgMembership(getSharedPgClient(), requestId, userId, provider.org_id, resolveMappedAccess(provider, authorizedSsoProviders, userIdentities))
    }
    catch {
      return quickError(500, 'provision_failed', 'Failed to provision user to organization')
    }

    if (membershipResult.noAccess) {
      return quickError(403, 'sso_no_access', 'Your identity provider does not grant you access to this organization. Contact your administrator.')
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
