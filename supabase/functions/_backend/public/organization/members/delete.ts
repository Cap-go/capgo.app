import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../../utils/hono.ts'
import type { Database } from '../../../utils/supabase.types.ts'
import { z } from 'zod'
import { HTTPException } from 'hono/http-exception'
import { safeParseSchema } from '../../../utils/schema_validation.ts'
import { BRES, quickError, simpleError } from '../../../utils/hono.ts'
import { cloudlog } from '../../../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../../../utils/pg.ts'
import { checkPermission, checkPermissionPg } from '../../../utils/rbac.ts'
import { supabaseAdmin } from '../../../utils/supabase.ts'

const deleteBodySchema = z.object({
  orgId: z.string(),
  email: z.email(),
})

interface MemberRemovalRanks {
  caller_max_rank: number | string | null
  target_max_rank: number | string | null
}

interface PinnedPgClient {
  query: <T = unknown>(query: string, params?: unknown[]) => Promise<{
    rowCount?: number | null
    rows: T[]
  }>
  release: () => void
}

interface MemberRemovalRequest {
  orgId: string
  email: string
}

type DrizzleClient = ReturnType<typeof getDrizzleClient>

function priorityRank(value: number | string | null | undefined): number {
  const rank = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(rank) ? rank : 0
}

async function resolveMemberRemovalTargetUserId(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
  body: MemberRemovalRequest,
  canManageRoles: boolean,
): Promise<string> {
  const adminClient = supabaseAdmin(c)
  if (canManageRoles) {
    const { data: userData, error: userError } = await adminClient
      .from('users')
      .select('id')
      .eq('email', body.email)
      .single()

    if (userError || !userData)
      throw quickError(404, 'user_not_found', 'User not found', { error: userError })
    return userData.id
  }

  if (auth.authType !== 'jwt')
    throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId: body.orgId })

  const { data: callerData, error: callerError } = await adminClient
    .from('users')
    .select('id, email')
    .eq('id', auth.userId)
    .single()

  if (callerError || !callerData || callerData.email?.toLowerCase() !== body.email.toLowerCase())
    throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId: body.orgId })
  return callerData.id
}

async function getMemberRemovalRanks(
  pgClient: PinnedPgClient,
  authType: 'apikey' | 'jwt',
  callerPrincipalId: string,
  orgId: string,
  targetUserId: string,
): Promise<MemberRemovalRanks> {
  const result = await pgClient.query<MemberRemovalRanks>(
    `
    WITH active_caller_bindings AS (
      SELECT role_bindings.role_id, role_bindings.scope_type
      FROM public.role_bindings role_bindings
      WHERE role_bindings.principal_id = $1::uuid
        AND role_bindings.org_id = $2::uuid
        AND (role_bindings.expires_at IS NULL OR role_bindings.expires_at > now())
        AND (
          ($4::text = 'apikey' AND role_bindings.principal_type = public.rbac_principal_apikey())
          OR ($4::text = 'jwt' AND role_bindings.principal_type = public.rbac_principal_user())
        )

      UNION ALL

      SELECT role_bindings.role_id, role_bindings.scope_type
      FROM public.group_members group_members
      INNER JOIN public.groups groups
        ON groups.id = group_members.group_id
        AND groups.org_id = $2::uuid
      INNER JOIN public.role_bindings role_bindings
        ON role_bindings.principal_type = public.rbac_principal_group()
        AND role_bindings.principal_id = group_members.group_id
        AND role_bindings.org_id = groups.org_id
      WHERE $4::text = 'jwt'
        AND group_members.user_id = $1::uuid
        AND (role_bindings.expires_at IS NULL OR role_bindings.expires_at > now())
    ),
    active_target_bindings AS (
      SELECT role_bindings.role_id, role_bindings.scope_type
      FROM public.role_bindings role_bindings
      WHERE role_bindings.principal_type = public.rbac_principal_user()
        AND role_bindings.principal_id = $3::uuid
        AND role_bindings.org_id = $2::uuid
        AND (role_bindings.expires_at IS NULL OR role_bindings.expires_at > now())

      UNION ALL

      SELECT role_bindings.role_id, role_bindings.scope_type
      FROM public.group_members group_members
      INNER JOIN public.groups groups
        ON groups.id = group_members.group_id
        AND groups.org_id = $2::uuid
      INNER JOIN public.role_bindings role_bindings
        ON role_bindings.principal_type = public.rbac_principal_group()
        AND role_bindings.principal_id = group_members.group_id
        AND role_bindings.org_id = groups.org_id
      WHERE group_members.user_id = $3::uuid
        AND (role_bindings.expires_at IS NULL OR role_bindings.expires_at > now())
    )
    SELECT
      COALESCE((
        SELECT MAX(roles.priority_rank)
        FROM active_caller_bindings
        INNER JOIN public.roles roles
          ON roles.id = active_caller_bindings.role_id
          AND roles.scope_type = active_caller_bindings.scope_type
      ), 0) AS caller_max_rank,
      COALESCE((
        SELECT MAX(roles.priority_rank)
        FROM active_target_bindings
        INNER JOIN public.roles roles
          ON roles.id = active_target_bindings.role_id
          AND roles.scope_type = active_target_bindings.scope_type
      ), 0) AS target_max_rank
    `,
    [callerPrincipalId, orgId, targetUserId, authType],
  )

  return result.rows[0] ?? { caller_max_rank: 0, target_max_rank: 0 }
}

async function assertMemberRemovalAuthorizedAfterLock(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
  body: MemberRemovalRequest,
  targetUserId: string,
  dbClient: PinnedPgClient,
): Promise<void> {
  const pinnedDrizzle = getDrizzleClient(dbClient as unknown as ReturnType<typeof getPgClient>) as DrizzleClient
  const apikeyString = auth.apikey?.key ?? c.get('capgkey') ?? null
  const canManageRoles = await checkPermissionPg(
    c,
    'org.update_user_roles',
    { orgId: body.orgId },
    pinnedDrizzle,
    auth.userId,
    apikeyString,
  )
  const isSelfRemoval = auth.authType === 'jwt' && targetUserId === auth.userId
  if (!canManageRoles && !isSelfRemoval)
    throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId: body.orgId })

  if (!canManageRoles || isSelfRemoval)
    return

  const callerPrincipalId = auth.authType === 'apikey' ? auth.apikey!.rbac_id : auth.userId
  const ranks = await getMemberRemovalRanks(dbClient, auth.authType, callerPrincipalId, body.orgId, targetUserId)
  if (priorityRank(ranks.target_max_rank) > priorityRank(ranks.caller_max_rank)) {
    throw quickError(403, 'cannot_delete_higher_priority_role', 'Cannot delete a member with a role higher than your own', { orgId: body.orgId })
  }
}

export async function deleteMember(c: Context<MiddlewareKeyVariables>, bodyRaw: any, _apikey: Database['public']['Tables']['apikeys']['Row']) {
  const bodyParsed = safeParseSchema(deleteBodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data
  const auth = c.get('auth')
  if (!auth?.userId) {
    throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId: body.orgId })
  }

  // Arbitrary target lookup stays behind role-management permission to avoid user enumeration.
  const canManageRoles = await checkPermission(c, 'org.update_user_roles', { orgId: body.orgId })
  const targetUserId = await resolveMemberRemovalTargetUserId(c, auth, body, canManageRoles)
  const adminClient = supabaseAdmin(c)

  const { data: existingMembership, error: membershipLookupError } = await adminClient
    .from('org_users')
    .select('org_id, user_id')
    .eq('user_id', targetUserId)
    .eq('org_id', body.orgId)
    .is('app_id', null)
    .is('channel_id', null)
    .limit(1)
    .maybeSingle()

  if (membershipLookupError) {
    throw simpleError('error_deleting_user_from_organization', 'Error finding user organization membership', { error: membershipLookupError })
  }

  if (!existingMembership) {
    throw quickError(404, 'organization_member_not_found', 'User is not a member of this organization', { orgId: body.orgId, email: body.email })
  }

  // Pin the transaction to one connection: rank read, cleanup, and membership deletion
  // must share the organization lock with every RBAC mutation trigger.
  const pgPool = getPgClient(c)
  let dbClient: PinnedPgClient | undefined
  let transactionOpen = false
  cloudlog({ requestId: c.get('requestId'), message: 'targetUserId', data: targetUserId })
  cloudlog({ requestId: c.get('requestId'), message: 'body.orgId', data: body.orgId })
  try {
    dbClient = await pgPool.connect() as unknown as PinnedPgClient
    await dbClient.query('BEGIN')
    transactionOpen = true
    await dbClient.query('SELECT public.lock_rbac_orgs($1::uuid)', [body.orgId])
    await assertMemberRemovalAuthorizedAfterLock(c, auth, body, targetUserId, dbClient)

    // The base-row AFTER DELETE trigger atomically revokes direct/group/key access,
    // channel overrides, and any remaining scoped org_users rows in this org.
    const deletedMembership = await dbClient.query(
      `
      DELETE FROM public.org_users
      WHERE user_id = $1::uuid
        AND org_id = $2::uuid
        AND app_id IS NULL
        AND channel_id IS NULL
      RETURNING org_id, user_id
      `,
      [targetUserId, body.orgId],
    )

    if ((deletedMembership.rowCount ?? 0) < 1) {
      throw quickError(404, 'organization_member_not_found', 'User is not a member of this organization', { orgId: body.orgId, email: body.email })
    }

    await dbClient.query('COMMIT')
  }
  catch (error) {
    if (dbClient && transactionOpen)
      await dbClient.query('ROLLBACK').catch(() => {})

    const message = error instanceof Error ? error.message : ''
    if (message.includes('CANNOT_DELETE_LAST_SUPER_ADMIN_BINDING') || message.includes('CANNOT_REMOVE_LAST_EFFECTIVE_SUPER_ADMIN')) {
      throw simpleError('CANNOT_REMOVE_LAST_SUPER_ADMIN', 'Cannot remove the last super admin from the organization', { orgId: body.orgId })
    }
    if (error instanceof HTTPException) {
      throw error
    }
    throw simpleError('error_deleting_user_from_organization', 'Error deleting user from organization', { error })
  }
  finally {
    dbClient?.release()
    closeClient(c, pgPool)
  }

  cloudlog({ requestId: c.get('requestId'), message: 'User deleted from organization', data: { user_id: targetUserId, org_id: body.orgId } })
  return c.json(BRES)
}
