import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { sValidator } from '@hono/standard-validator'
import { and, eq, sql } from 'drizzle-orm'
import { getErrorCode } from '../utils/errors.ts'
import { createHono, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { assertJwtMfaAssurance } from '../utils/jwt_mfa_assurance.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { schema } from '../utils/postgres_schema.ts'
import { checkPermission, checkPermissionPg } from '../utils/rbac.ts'
import { version } from '../utils/version.ts'
import {
  appIdParamSchema,
  bindingIdParamSchema,
  createRoleBindingBodyHook,
  createRoleBindingBodySchema,
  invalidAppIdHook,
  invalidBindingIdHook,
  invalidOrgIdHook,
  orgIdParamSchema,
  updateRoleBindingBodyHook,
  updateRoleBindingBodySchema,
  validateJsonBody,
} from './rbac_validation.ts'

type PrincipalType = 'user' | 'group' | 'apikey'
type ScopeType = 'org' | 'app' | 'channel'

interface RoleBindingBody {
  principal_type: PrincipalType
  principal_id: string
  role_name: string
  scope_type: ScopeType
  org_id: string
  app_id?: string | null
  channel_id?: string | number | null
  reason?: string
}

type ValidationResult<T> = { ok: true, data: T } | { ok: false, status: number, error: string }
type RouteValidationResult<T> = { ok: true, data: T } | { ok: false, response: Response }
type RoleBindingRecord = typeof schema.role_bindings.$inferSelect
type RoleRecord = typeof schema.roles.$inferSelect
interface AssignablePrincipal {
  type: 'user' | 'group'
  id: string
  label: string
  detail: string | null
}
const INVALID_APIKEY_ACCESS_ERROR = 'Invalid API key or access'
type DrizzleClient = ReturnType<typeof getDrizzleClient>
type DrizzleExecutor = Pick<DrizzleClient, 'execute'>

export async function lockRbacOrgs(
  drizzle: DrizzleExecutor,
  orgIds: Array<string | null | undefined>,
): Promise<void> {
  const sortedOrgIds = [...new Set(orgIds.filter((orgId): orgId is string => Boolean(orgId)))].sort((left, right) => left.localeCompare(right))

  for (let index = 0; index < sortedOrgIds.length; index += 2) {
    const firstOrgId = sortedOrgIds[index]!
    const secondOrgId = sortedOrgIds[index + 1]

    if (secondOrgId) {
      await drizzle.execute(sql`SELECT public.lock_rbac_orgs(${firstOrgId}::uuid, ${secondOrgId}::uuid)`)
    }
    else {
      await drizzle.execute(sql`SELECT public.lock_rbac_orgs(${firstOrgId}::uuid)`)
    }
  }
}

export const app = createHono('', version)

app.use('*', useCors)
app.use('*', middlewareAuth())

function createRequireAuthAndGuardLimitedKeys(requireMfa: boolean) {
  return async (c: Context<MiddlewareKeyVariables>, next: () => Promise<void>) => {
    const auth = c.get('auth')
    if (!auth?.userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    // API keys must not manage role bindings. V2 API-key permissions are scoped
    // by these bindings, so allowing keys to mutate them would let a key widen
    // its own access or mint another broad key.
    if (auth.authType === 'apikey') {
      return c.json({ error: 'API keys cannot manage role bindings' }, 403)
    }

    if (requireMfa) {
      await assertJwtMfaAssurance(c, auth)
    }

    await next()
  }
}

const requireAuthAndGuardLimitedKeys = createRequireAuthAndGuardLimitedKeys(false)
const requireAuthMfaAndGuardLimitedKeys = createRequireAuthAndGuardLimitedKeys(true)

function isSupportedChannelId(channelId: RoleBindingBody['channel_id']): channelId is string | number {
  if (typeof channelId === 'number') {
    return Number.isSafeInteger(channelId) && channelId > 0
  }

  return typeof channelId === 'string' && channelId.trim().length > 0
}

function getLegacyChannelRowId(channelId: string | number): number | null {
  if (typeof channelId === 'number') {
    return channelId
  }

  const trimmedChannelId = channelId.trim()
  if (!/^\d+$/.test(trimmedChannelId)) {
    return null
  }

  const parsedChannelId = Number(trimmedChannelId)
  return Number.isSafeInteger(parsedChannelId) && parsedChannelId > 0 ? parsedChannelId : null
}

function validateScope(scopeType: RoleBindingBody['scope_type'], appId?: string | null, channelId?: RoleBindingBody['channel_id']): ValidationResult<null> {
  if (scopeType === 'app' && !appId) {
    return { ok: false, status: 400, error: 'app_id required for app scope' }
  }
  if (scopeType === 'channel' && (!appId || !isSupportedChannelId(channelId))) {
    return { ok: false, status: 400, error: 'app_id and channel_id required for channel scope' }
  }
  return { ok: true, data: null }
}

async function validateScopedAppOwnership(
  drizzle: ReturnType<typeof getDrizzleClient>,
  scopeType: RoleBindingBody['scope_type'],
  orgId: string,
  appId?: string | null,
  channelId?: RoleBindingBody['channel_id'],
): Promise<ValidationResult<{ channelRbacId: string | null }>> {
  if (scopeType !== 'app' && scopeType !== 'channel') {
    return { ok: true, data: { channelRbacId: null } }
  }

  const [app] = await drizzle
    .select({
      id: schema.apps.id,
      publicAppId: schema.apps.app_id,
    })
    .from(schema.apps)
    .where(
      and(
        eq(schema.apps.id, appId!),
        eq(schema.apps.owner_org, orgId),
      ),
    )
    .limit(1)

  if (!app) {
    return { ok: false, status: 404, error: 'App not found in this org' }
  }

  if (scopeType === 'channel') {
    if (!isSupportedChannelId(channelId)) {
      return { ok: false, status: 400, error: 'app_id and channel_id required for channel scope' }
    }

    const legacyChannelRowId = getLegacyChannelRowId(channelId)
    const normalizedChannelId = typeof channelId === 'string' ? channelId.trim() : `${channelId}`
    const [channel] = await drizzle
      .select({ rbacId: schema.channels.rbac_id })
      .from(schema.channels)
      .where(
        and(
          legacyChannelRowId !== null
            ? eq(schema.channels.id, legacyChannelRowId)
            : eq(schema.channels.rbac_id, normalizedChannelId),
          eq(schema.channels.app_id, app.publicAppId),
          eq(schema.channels.owner_org, orgId),
        ),
      )
      .limit(1)

    if (!channel) {
      return { ok: false, status: 404, error: 'Channel not found in this app/org' }
    }

    return { ok: true, data: { channelRbacId: channel.rbacId } }
  }

  return { ok: true, data: { channelRbacId: null } }
}

export function validateRoleScope(roleScopeType: string, bindingScopeType: string): ValidationResult<null> {
  if (roleScopeType !== bindingScopeType) {
    return { ok: false, status: 400, error: 'Role scope_type does not match binding scope' }
  }
  return { ok: true, data: null }
}

async function validateUserPrincipalAccess(
  drizzle: ReturnType<typeof getDrizzleClient>,
  principalId: string,
  orgId: string,
): Promise<ValidationResult<null>> {
  const targetRbacAccess = await drizzle
    .select({ id: schema.role_bindings.id })
    .from(schema.role_bindings)
    .innerJoin(schema.roles, and(
      eq(schema.role_bindings.role_id, schema.roles.id),
      eq(schema.role_bindings.scope_type, schema.roles.scope_type),
    ))
    .where(
      and(
        eq(schema.role_bindings.principal_type, 'user'),
        eq(schema.role_bindings.principal_id, principalId),
        eq(schema.role_bindings.org_id, orgId),
        sql`(${schema.role_bindings.expires_at} IS NULL OR ${schema.role_bindings.expires_at} > now())`,
      ),
    )
    .limit(1)

  if (targetRbacAccess.length) {
    return { ok: true, data: null }
  }

  const pendingInvite = await drizzle
    .select({ id: schema.org_users.id })
    .from(schema.org_users)
    .where(
      and(
        eq(schema.org_users.user_id, principalId),
        eq(schema.org_users.org_id, orgId),
        eq(schema.org_users.is_invite, true),
      ),
    )
    .limit(1)

  if (pendingInvite.length) {
    return { ok: false, status: 400, error: 'User has not accepted the org invitation yet' }
  }

  return { ok: false, status: 400, error: 'User is not a member of this org' }
}

async function validateGroupPrincipalAccess(
  drizzle: ReturnType<typeof getDrizzleClient>,
  principalId: string,
  orgId: string,
): Promise<ValidationResult<null>> {
  const [group] = await drizzle
    .select()
    .from(schema.groups)
    .where(
      and(
        eq(schema.groups.id, principalId),
        eq(schema.groups.org_id, orgId),
      ),
    )
    .limit(1)

  if (!group) {
    return { ok: false, status: 400, error: 'Group not found in this org' }
  }

  return { ok: true, data: null }
}

async function validateApiKeyPrincipalAccess(
  drizzle: ReturnType<typeof getDrizzleClient>,
  principalId: string,
  orgId: string,
): Promise<ValidationResult<null>> {
  const [apiKey] = await drizzle
    .select({
      user_id: schema.apikeys.user_id,
    })
    .from(schema.apikeys)
    .where(eq(schema.apikeys.rbac_id, principalId))
    .limit(1)

  if (!apiKey) {
    cloudlogErr({
      message: 'validatePrincipalAccess: missing apiKey for role binding principal',
      principalId,
      orgId,
    })
    return { ok: false, status: 400, error: INVALID_APIKEY_ACCESS_ERROR }
  }

  const [ownerRbacAccess] = await drizzle
    .select({ id: schema.role_bindings.id })
    .from(schema.role_bindings)
    .where(
      and(
        eq(schema.role_bindings.principal_type, 'user'),
        eq(schema.role_bindings.principal_id, apiKey.user_id),
        eq(schema.role_bindings.org_id, orgId),
        sql`(${schema.role_bindings.expires_at} IS NULL OR ${schema.role_bindings.expires_at} > now())`,
      ),
    )
    .limit(1)

  if (ownerRbacAccess) {
    return { ok: true, data: null }
  }

  const [pendingInvite] = await drizzle
    .select({ id: schema.org_users.id })
    .from(schema.org_users)
    .where(
      and(
        eq(schema.org_users.user_id, apiKey.user_id),
        eq(schema.org_users.org_id, orgId),
        eq(schema.org_users.is_invite, true),
      ),
    )
    .limit(1)

  if (pendingInvite) {
    cloudlogErr({
      message: 'validatePrincipalAccess: apiKey owner has pending invite, not active member',
      principalId,
      orgId,
      apiKeyUserId: apiKey.user_id,
    })
    return { ok: false, status: 400, error: INVALID_APIKEY_ACCESS_ERROR }
  }

  cloudlogErr({
    message: 'validatePrincipalAccess: apiKey owner RBAC access not found',
    principalId,
    orgId,
    apiKeyUserId: apiKey.user_id,
  })
  return { ok: false, status: 400, error: INVALID_APIKEY_ACCESS_ERROR }
}

export async function validatePrincipalAccess(
  drizzle: ReturnType<typeof getDrizzleClient>,
  principalType: RoleBindingBody['principal_type'],
  principalId: string,
  orgId: string,
): Promise<ValidationResult<null>> {
  if (principalType === 'user') {
    return validateUserPrincipalAccess(drizzle, principalId, orgId)
  }

  if (principalType === 'group') {
    return validateGroupPrincipalAccess(drizzle, principalId, orgId)
  }

  if (principalType === 'apikey') {
    return validateApiKeyPrincipalAccess(drizzle, principalId, orgId)
  }

  return { ok: true, data: null }
}

async function loadRoleBindingLockOrgId(
  drizzle: DrizzleClient,
  bindingId: string,
): Promise<string | null> {
  const [binding] = await drizzle
    .select({ orgId: schema.role_bindings.org_id })
    .from(schema.role_bindings)
    .where(eq(schema.role_bindings.id, bindingId))
    .limit(1)

  return binding?.orgId ?? null
}

async function loadManagedBinding(
  c: Context<MiddlewareKeyVariables>,
  drizzle: ReturnType<typeof getDrizzleClient>,
  bindingId: string,
): Promise<RouteValidationResult<RoleBindingRecord>> {
  const [binding] = await drizzle
    .select()
    .from(schema.role_bindings)
    .where(eq(schema.role_bindings.id, bindingId))
    .limit(1)

  if (!binding) {
    return { ok: false, response: c.json({ error: 'Role binding not found' }, 404) }
  }

  if (!(await canManageRoleBindingScope(c, drizzle, binding))) {
    return { ok: false, response: c.json({ error: 'Forbidden - Admin rights required' }, 403) }
  }

  return { ok: true, data: binding }
}

async function canManageRoleBindingScope(
  c: Context<MiddlewareKeyVariables>,
  drizzle: DrizzleClient,
  binding: Pick<RoleBindingRecord, 'scope_type' | 'org_id' | 'app_id'>,
): Promise<boolean> {
  const auth = c.get('auth')
  if (!auth?.userId) {
    return false
  }

  const apikeyString = auth.apikey?.key ?? c.get('capgkey') ?? null
  if (binding.org_id && await checkPermissionPg(c, 'org.update_user_roles', { orgId: binding.org_id }, drizzle, auth.userId, apikeyString)) {
    return true
  }

  if ((binding.scope_type !== 'app' && binding.scope_type !== 'channel') || !binding.app_id) {
    return false
  }

  const [app] = await drizzle
    .select({
      publicAppId: schema.apps.app_id,
      ownerOrg: schema.apps.owner_org,
    })
    .from(schema.apps)
    .where(
      and(
        eq(schema.apps.id, binding.app_id),
        binding.org_id ? eq(schema.apps.owner_org, binding.org_id) : sql`true`,
      ),
    )
    .limit(1)

  if (!app) {
    return false
  }

  return await checkPermissionPg(c, 'app.update_user_roles', { appId: app.publicAppId }, drizzle, auth.userId, apikeyString)
}

async function loadAssignableRoleForBinding(
  c: Context<MiddlewareKeyVariables>,
  drizzle: ReturnType<typeof getDrizzleClient>,
  binding: RoleBindingRecord,
  roleName: string,
): Promise<RouteValidationResult<RoleRecord>> {
  const [role] = await drizzle
    .select()
    .from(schema.roles)
    .where(eq(schema.roles.name, roleName))
    .limit(1)

  if (!role) {
    return { ok: false, response: c.json({ error: 'Role not found' }, 404) }
  }

  if (!role.is_assignable) {
    return { ok: false, response: c.json({ error: 'Role is not assignable' }, 403) }
  }

  const principalValidation = binding.org_id
    ? await validatePrincipalAccess(drizzle, binding.principal_type as RoleBindingBody['principal_type'], binding.principal_id, binding.org_id)
    : { ok: true as const, data: null }
  if (!principalValidation.ok) {
    return { ok: false, response: c.json({ error: principalValidation.error }, principalValidation.status as ContentfulStatusCode) }
  }

  const roleScopeValidation = validateRoleScope(role.scope_type, binding.scope_type)
  if (!roleScopeValidation.ok) {
    return { ok: false, response: c.json({ error: roleScopeValidation.error }, roleScopeValidation.status as ContentfulStatusCode) }
  }

  return { ok: true, data: role }
}

async function getCallerMaxPriorityRank(
  drizzle: ReturnType<typeof getDrizzleClient>,
  authType: 'apikey' | 'jwt',
  principalId: string,
  orgId: string,
): Promise<number> {
  if (authType === 'apikey') {
    const result = await drizzle
      .select({ max_rank: sql<number>`MAX(${schema.roles.priority_rank})` })
      .from(schema.role_bindings)
      .innerJoin(schema.roles, and(
        eq(schema.role_bindings.role_id, schema.roles.id),
        eq(schema.role_bindings.scope_type, schema.roles.scope_type),
      ))
      .where(
        and(
          eq(schema.role_bindings.principal_type, 'apikey'),
          eq(schema.role_bindings.principal_id, principalId),
          eq(schema.role_bindings.org_id, orgId),
          sql`(${schema.role_bindings.expires_at} IS NULL OR ${schema.role_bindings.expires_at} > now())`,
        ),
      )
      .limit(1)

    return result[0]?.max_rank ?? 0
  }

  const result = await drizzle.execute(
    sql`
      WITH active_caller_bindings AS (
        SELECT role_bindings.role_id, role_bindings.scope_type
        FROM public.role_bindings role_bindings
        WHERE role_bindings.principal_type = public.rbac_principal_user()
          AND role_bindings.principal_id = ${principalId}::uuid
          AND role_bindings.org_id = ${orgId}::uuid
          AND (role_bindings.expires_at IS NULL OR role_bindings.expires_at > now())

        UNION ALL

        SELECT role_bindings.role_id, role_bindings.scope_type
        FROM public.group_members group_members
        INNER JOIN public.groups groups
          ON groups.id = group_members.group_id
          AND groups.org_id = ${orgId}::uuid
        INNER JOIN public.role_bindings role_bindings
          ON role_bindings.principal_type = public.rbac_principal_group()
          AND role_bindings.principal_id = group_members.group_id
          AND role_bindings.org_id = groups.org_id
        WHERE group_members.user_id = ${principalId}::uuid
          AND (role_bindings.expires_at IS NULL OR role_bindings.expires_at > now())
      )
      SELECT MAX(roles.priority_rank) AS max_rank
      FROM active_caller_bindings
      INNER JOIN public.roles roles
        ON roles.id = active_caller_bindings.role_id
        AND roles.scope_type = active_caller_bindings.scope_type
    `,
  )

  const maxRank = (result.rows[0] as { max_rank?: number | string | null } | undefined)?.max_rank
  if (typeof maxRank === 'number') {
    return maxRank
  }
  if (typeof maxRank === 'string') {
    return Number(maxRank)
  }

  return 0
}

// Reusable binding creation logic - used by both the POST route and apikey/post.ts
export interface CreateBindingParams {
  principal_type: PrincipalType
  principal_id: string
  role_name: string
  scope_type: ScopeType
  org_id: string
  app_id?: string | null
  channel_id?: string | number | null
  reason?: string
}

export type CreateBindingResult = {
  ok: true
  data: typeof schema.role_bindings.$inferSelect
} | {
  ok: false
  status: number
  error: string
}

export interface CreateBindingOptions {
  // Caller must already hold advisory locks for every org_id in this request.
  skipOrgLock?: boolean
  // Caller must already have proven the principal exists and the owner has
  // active org access. API key create may set this after inserting the key in
  // the same txn and asserting org.manage_apikeys for each org. Do not use this
  // to skip owner-active-member / pending-invite checks on an existing principal.
  skipPrincipalValidation?: boolean
}

export async function createRoleBindingForPrincipal(
  drizzle: ReturnType<typeof getDrizzleClient>,
  params: CreateBindingParams,
  grantedBy: string,
  authType: 'jwt' | 'apikey',
  callerPrincipalId: string,
  options?: CreateBindingOptions,
): Promise<CreateBindingResult> {
  const {
    principal_type,
    principal_id,
    role_name,
    scope_type,
    org_id,
    app_id,
    channel_id,
    reason,
  } = params

  if (!options?.skipOrgLock) {
    await lockRbacOrgs(drizzle, [org_id])
  }

  // 1. Resolve role by name
  const [role] = await drizzle
    .select()
    .from(schema.roles)
    .where(eq(schema.roles.name, role_name))
    .limit(1)

  if (!role) {
    return { ok: false, status: 404, error: 'Role not found' }
  }

  if (!role.is_assignable) {
    return { ok: false, status: 403, error: 'Role is not assignable' }
  }
  // 2. Role scope must match binding scope
  const roleScopeValidation = validateRoleScope(role.scope_type, scope_type)
  if (!roleScopeValidation.ok) {
    return { ok: false, status: roleScopeValidation.status, error: roleScopeValidation.error }
  }

  // 3. Anti-escalation: caller's max priority rank must be >= role.priority_rank
  const callerMaxRank = await getCallerMaxPriorityRank(drizzle, authType, callerPrincipalId, org_id)
  if (role.priority_rank > callerMaxRank) {
    return { ok: false, status: 403, error: 'Cannot assign a role with higher privileges than your own' }
  }

  // 4. Scope field validation (app_id / channel_id required when scope demands it)
  const scopeValidation = validateScope(scope_type, app_id, channel_id)
  if (!scopeValidation.ok) {
    return { ok: false, status: scopeValidation.status, error: scopeValidation.error }
  }

  // 5. App/channel ownership check; also normalises channel_id -> rbac_id
  const scopedAppValidation = await validateScopedAppOwnership(drizzle, scope_type, org_id, app_id, channel_id)
  if (!scopedAppValidation.ok) {
    return { ok: false, status: scopedAppValidation.status, error: scopedAppValidation.error }
  }
  const normalizedChannelId = scopedAppValidation.data.channelRbacId

  // 6. Principal existence & org-membership check
  if (!options?.skipPrincipalValidation) {
    const principalValidation = await validatePrincipalAccess(drizzle, principal_type, principal_id, org_id)
    if (!principalValidation.ok) {
      return { ok: false, status: principalValidation.status, error: principalValidation.error }
    }
  }

  // 7. Create the binding
  const [binding] = await drizzle
    .insert(schema.role_bindings)
    .values({
      principal_type,
      principal_id,
      role_id: role.id,
      scope_type,
      org_id,
      app_id: app_id || null,
      channel_id: normalizedChannelId,
      granted_by: grantedBy,
      reason: reason || null,
      is_direct: true,
    })
    .returning()

  return { ok: true, data: binding }
}

async function updateRoleBindingRole(
  drizzle: DrizzleExecutor,
  bindingId: string,
  binding: RoleBindingRecord,
  roleId: string,
  callerMaxRank: number,
): Promise<RoleBindingRecord | null> {
  const updateResult = await drizzle.execute(sql`
    UPDATE public.role_bindings AS rb
    SET role_id = ${roleId}::uuid
    FROM public.roles AS bound_role
    WHERE rb.id = ${bindingId}::uuid
      AND rb.org_id IS NOT DISTINCT FROM ${binding.org_id}::uuid
      AND rb.app_id IS NOT DISTINCT FROM ${binding.app_id}::uuid
      AND rb.bundle_id IS NOT DISTINCT FROM ${binding.bundle_id}::bigint
      AND rb.channel_id IS NOT DISTINCT FROM ${binding.channel_id}::uuid
      AND rb.scope_type = ${binding.scope_type}::text
      AND rb.principal_type = ${binding.principal_type}::text
      AND rb.principal_id = ${binding.principal_id}::uuid
      AND rb.role_id = bound_role.id
      AND bound_role.priority_rank <= ${callerMaxRank}::integer
    RETURNING rb.*
  `)

  return (updateResult.rows[0] as RoleBindingRecord | undefined) ?? null
}

function isLastSuperAdminDemotionError(error: unknown): boolean {
  const errorCodes = [
    'CANNOT_DEMOTE_LAST_SUPER_ADMIN_BINDING',
    'CANNOT_DELETE_LAST_SUPER_ADMIN_BINDING',
    'CANNOT_REMOVE_LAST_EFFECTIVE_SUPER_ADMIN',
  ]
  let currentError = error
  for (let depth = 0; depth < 4 && currentError !== null && currentError !== undefined; depth += 1) {
    const errorRecord = typeof currentError === 'object'
      ? currentError as { cause?: unknown, code?: unknown, message?: unknown }
      : null
    let errorMessage = ''
    if (typeof errorRecord?.message === 'string')
      errorMessage = errorRecord.message
    else if (typeof currentError === 'string')
      errorMessage = currentError
    if (errorCodes.some(code => errorMessage.includes(code) || errorRecord?.code === code))
      return true
    currentError = errorRecord?.cause
  }
  return false
}

async function deleteChannelPermissionOverridesForBinding(
  tx: Parameters<Parameters<ReturnType<typeof getDrizzleClient>['transaction']>[0]>[0],
  binding: RoleBindingRecord,
) {
  if (binding.scope_type === 'app' && binding.app_id) {
    await tx.execute(sql`
      DELETE FROM public.channel_permission_overrides AS overrides
      USING public.channels AS channels
      INNER JOIN public.apps AS apps
        ON apps.app_id = channels.app_id
      WHERE overrides.channel_id = channels.id
        AND apps.id = ${binding.app_id}
        AND overrides.principal_type = ${binding.principal_type}
        AND overrides.principal_id = ${binding.principal_id}
        AND NOT EXISTS (
          SELECT 1
          FROM public.role_bindings AS remaining_bindings
          WHERE remaining_bindings.id <> ${binding.id}
            AND remaining_bindings.principal_type = ${binding.principal_type}
            AND remaining_bindings.principal_id = ${binding.principal_id}
            AND remaining_bindings.app_id = ${binding.app_id}
            AND (remaining_bindings.expires_at IS NULL OR remaining_bindings.expires_at > now())
            AND (
              remaining_bindings.scope_type = 'app'
              OR (
                remaining_bindings.scope_type = 'channel'
                AND remaining_bindings.channel_id = channels.rbac_id
              )
            )
        )
    `)
    return
  }

  if (binding.scope_type === 'channel' && binding.app_id && binding.channel_id) {
    await tx.execute(sql`
      DELETE FROM public.channel_permission_overrides AS overrides
      USING public.channels AS channels
      INNER JOIN public.apps AS apps
        ON apps.app_id = channels.app_id
      WHERE overrides.channel_id = channels.id
        AND apps.id = ${binding.app_id}
        AND channels.rbac_id = ${binding.channel_id}
        AND overrides.principal_type = ${binding.principal_type}
        AND overrides.principal_id = ${binding.principal_id}
        AND NOT EXISTS (
          SELECT 1
          FROM public.role_bindings AS remaining_bindings
          WHERE remaining_bindings.id <> ${binding.id}
            AND remaining_bindings.principal_type = ${binding.principal_type}
            AND remaining_bindings.principal_id = ${binding.principal_id}
            AND remaining_bindings.app_id = ${binding.app_id}
            AND (remaining_bindings.expires_at IS NULL OR remaining_bindings.expires_at > now())
            AND (
              remaining_bindings.scope_type = 'app'
              OR (
                remaining_bindings.scope_type = 'channel'
                AND remaining_bindings.channel_id = ${binding.channel_id}
              )
            )
        )
    `)
    return
  }

  if (binding.scope_type === 'org' && binding.org_id) {
    await tx.execute(sql`
      DELETE FROM public.channel_permission_overrides AS overrides
      USING public.channels AS channels
      INNER JOIN public.apps AS apps
        ON apps.app_id = channels.app_id
      WHERE overrides.channel_id = channels.id
        AND apps.owner_org = ${binding.org_id}
        AND overrides.principal_type = ${binding.principal_type}
        AND overrides.principal_id = ${binding.principal_id}
        AND NOT EXISTS (
          SELECT 1
          FROM public.role_bindings AS remaining_bindings
          WHERE remaining_bindings.id <> ${binding.id}
            AND remaining_bindings.principal_type = ${binding.principal_type}
            AND remaining_bindings.principal_id = ${binding.principal_id}
            AND remaining_bindings.org_id = ${binding.org_id}
            AND (remaining_bindings.expires_at IS NULL OR remaining_bindings.expires_at > now())
        )
    `)
  }
}

async function loadRoleBindingApp(
  drizzle: ReturnType<typeof getDrizzleClient>,
  appId: string,
): Promise<{
  publicAppId: string
  ownerOrg: string
} | null> {
  const [appRow] = await drizzle
    .select({
      publicAppId: schema.apps.app_id,
      ownerOrg: schema.apps.owner_org,
    })
    .from(schema.apps)
    .where(eq(schema.apps.id, appId))
    .limit(1)

  return appRow ?? null
}

// GET /private/role_bindings/app/:app_id/channel - List direct channel role bindings for an app
app.get('/app/:app_id/channel', requireAuthAndGuardLimitedKeys, sValidator('param', appIdParamSchema, invalidAppIdHook), async (c) => {
  const { app_id: appId } = c.req.valid('param')

  let pgClient
  try {
    pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)

    const appRow = await loadRoleBindingApp(drizzle, appId)
    if (!appRow) {
      return c.json({ error: 'App not found' }, 404)
    }

    if (!(await checkPermission(c, 'app.read', { appId: appRow.publicAppId }))) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const bindings = await drizzle
      .select({
        id: schema.role_bindings.id,
        principal_type: schema.role_bindings.principal_type,
        principal_id: schema.role_bindings.principal_id,
        role_id: schema.role_bindings.role_id,
        role_name: schema.roles.name,
        role_description: schema.roles.description,
        scope_type: schema.role_bindings.scope_type,
        org_id: schema.role_bindings.org_id,
        app_id: schema.role_bindings.app_id,
        channel_id: schema.role_bindings.channel_id,
        granted_at: schema.role_bindings.granted_at,
        granted_by: schema.role_bindings.granted_by,
        expires_at: schema.role_bindings.expires_at,
        reason: schema.role_bindings.reason,
        is_direct: schema.role_bindings.is_direct,
        principal_name: sql<string>`
          CASE
            WHEN ${schema.role_bindings.principal_type} = 'user' THEN ${schema.users.email}
            WHEN ${schema.role_bindings.principal_type} = 'group' THEN ${schema.groups.name}
            ELSE ${schema.role_bindings.principal_id}::text
          END
        `,
      })
      .from(schema.role_bindings)
      .innerJoin(schema.roles, eq(schema.role_bindings.role_id, schema.roles.id))
      .leftJoin(schema.users, and(
        eq(schema.role_bindings.principal_type, 'user'),
        eq(schema.role_bindings.principal_id, schema.users.id),
      ))
      .leftJoin(schema.groups, and(
        eq(schema.role_bindings.principal_type, 'group'),
        eq(schema.role_bindings.principal_id, schema.groups.id),
      ))
      .where(and(
        eq(schema.role_bindings.scope_type, 'channel'),
        eq(schema.role_bindings.app_id, appId),
        eq(schema.role_bindings.org_id, appRow.ownerOrg),
      ))
      .orderBy(schema.role_bindings.granted_at)

    cloudlog({
      requestId: c.get('requestId'),
      message: 'role_bindings_app_channels_fetch',
      appId,
      orgId: appRow.ownerOrg,
      count: bindings.length,
    })

    return c.json(bindings)
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'role_bindings_app_channels_fetch_failed',
      appId,
      error,
    })
    return c.json({ error: 'Internal server error' }, 500)
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
})

// GET /private/role_bindings/app/:app_id/principals - List users/groups assignable for app/channel access
app.get('/app/:app_id/principals', requireAuthAndGuardLimitedKeys, sValidator('param', appIdParamSchema, invalidAppIdHook), async (c) => {
  const { app_id: appId } = c.req.valid('param')

  let pgClient
  try {
    pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)

    const appRow = await loadRoleBindingApp(drizzle, appId)
    if (!appRow) {
      return c.json({ error: 'App not found' }, 404)
    }

    const canManageOrgRoles = await checkPermission(c, 'org.update_user_roles', { orgId: appRow.ownerOrg })
    const canManageAppRoles = await checkPermission(c, 'app.update_user_roles', { appId: appRow.publicAppId })
    if (!canManageOrgRoles && !canManageAppRoles) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const principalResult = await pgClient.query<AssignablePrincipal>(`
      WITH active_users AS (
        SELECT DISTINCT
          'user'::text AS type,
          users.id,
          users.email AS label,
          NULL::text AS detail
        FROM public.users users
        WHERE EXISTS (
          SELECT 1
          FROM public.role_bindings role_bindings
          WHERE role_bindings.principal_type = public.rbac_principal_user()
            AND role_bindings.principal_id = users.id
            AND role_bindings.org_id = $1::uuid
            AND (role_bindings.expires_at IS NULL OR role_bindings.expires_at > now())
        )
      ),
      org_groups AS (
        SELECT
          'group'::text AS type,
          groups.id,
          groups.name AS label,
          groups.description AS detail
        FROM public.groups groups
        WHERE groups.org_id = $1::uuid
      )
      SELECT type, id, label, detail
      FROM active_users
      UNION ALL
      SELECT type, id, label, detail
      FROM org_groups
      ORDER BY label
    `, [appRow.ownerOrg])

    cloudlog({
      requestId: c.get('requestId'),
      message: 'role_bindings_app_principals_fetch',
      appId,
      orgId: appRow.ownerOrg,
      count: principalResult.rows.length,
    })

    return c.json(principalResult.rows)
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'role_bindings_app_principals_fetch_failed',
      appId,
      error,
    })
    return c.json({ error: 'Internal server error' }, 500)
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
})

// GET /private/role_bindings/:org_id - List role bindings for an org
app.get('/:org_id', requireAuthAndGuardLimitedKeys, sValidator('param', orgIdParamSchema, invalidOrgIdHook), async (c) => {
  const { org_id: orgId } = c.req.valid('param')

  let pgClient
  try {
    pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)

    if (!(await checkPermission(c, 'org.read_members', { orgId }))) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    // Retrieve all role bindings for the org with associated info
    const bindings = await drizzle
      .select({
        id: schema.role_bindings.id,
        principal_type: schema.role_bindings.principal_type,
        principal_id: schema.role_bindings.principal_id,
        role_id: schema.role_bindings.role_id,
        role_name: schema.roles.name,
        role_description: schema.roles.description,
        scope_type: schema.role_bindings.scope_type,
        org_id: schema.role_bindings.org_id,
        app_id: schema.role_bindings.app_id,
        channel_id: schema.role_bindings.channel_id,
        granted_at: schema.role_bindings.granted_at,
        granted_by: schema.role_bindings.granted_by,
        expires_at: schema.role_bindings.expires_at,
        reason: schema.role_bindings.reason,
        is_direct: schema.role_bindings.is_direct,
      })
      .from(schema.role_bindings)
      .innerJoin(schema.roles, eq(schema.role_bindings.role_id, schema.roles.id))
      .where(eq(schema.role_bindings.org_id, orgId))
      .orderBy(schema.role_bindings.granted_at)

    cloudlog({
      requestId: c.get('requestId'),
      message: 'role_bindings_fetch',
      orgId,
      count: bindings.length,
    })

    return c.json(bindings)
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'role_bindings_fetch_failed',
      orgId,
      error,
    })
    return c.json({ error: 'Internal server error' }, 500)
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
})

// POST /private/role_bindings - Assign a role
app.post('/', requireAuthMfaAndGuardLimitedKeys, async (c) => {
  const auth = c.get('auth')!
  const userId = auth.userId

  const bodyResult = await validateJsonBody(c, createRoleBindingBodySchema, createRoleBindingBodyHook)
  if (!bodyResult.ok) {
    return bodyResult.response
  }

  const {
    principal_type,
    principal_id,
    role_name,
    scope_type,
    org_id,
    app_id,
    channel_id,
    reason,
  } = bodyResult.data

  let pgClient
  try {
    pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)
    const result = await drizzle.transaction(async (tx) => {
      const txDrizzle = tx as unknown as DrizzleClient
      await lockRbacOrgs(txDrizzle, [org_id])

      if (!(await canManageRoleBindingScope(c, txDrizzle, {
        scope_type,
        org_id,
        app_id: app_id || null,
      } as Pick<RoleBindingRecord, 'scope_type' | 'org_id' | 'app_id'>))) {
        return { ok: false as const, status: 403, error: 'Forbidden - Admin rights required' }
      }

      return createRoleBindingForPrincipal(txDrizzle, {
        principal_type,
        principal_id,
        role_name,
        scope_type,
        org_id,
        app_id,
        channel_id,
        reason: reason ?? undefined,
      }, userId, 'jwt', userId)
    })

    if (!result.ok) {
      return c.json({ error: result.error }, result.status as ContentfulStatusCode)
    }

    const binding = result.data
    cloudlog({
      requestId: c.get('requestId'),
      message: 'role_binding_created',
      orgId: org_id,
      bindingId: binding?.id,
      principal_type,
      principal_id,
      role_id: binding.role_id,
      scope_type,
      app_id,
      channel_id: binding.channel_id,
      granted_by: userId,
    })

    return c.json(binding)
  }
  catch (error: unknown) {
    if (getErrorCode(error) === '23505') {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'role_binding_duplicate',
        orgId: org_id,
        principal_type,
        principal_id,
        scope_type,
        app_id,
        channel_id,
      })
      return c.json({ error: 'User already has a role in this family at this scope' }, 409)
    }

    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'role_binding_create_failed',
      orgId: org_id,
      principal_type,
      principal_id,
      scope_type,
      app_id,
      channel_id,
      error,
    })

    return c.json({ error: 'Internal server error' }, 500)
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
})

// PATCH /private/role_bindings/:binding_id - Update a role binding
app.patch(
  '/:binding_id',
  requireAuthMfaAndGuardLimitedKeys,
  sValidator('param', bindingIdParamSchema, invalidBindingIdHook),
  async (c) => {
    const { binding_id: bindingId } = c.req.valid('param')
    const auth = c.get('auth')!

    const bodyResult = await validateJsonBody(c, updateRoleBindingBodySchema, updateRoleBindingBodyHook)
    if (!bodyResult.ok) {
      return bodyResult.response
    }

    const { role_name: roleName } = bodyResult.data

    let pgClient
    try {
      pgClient = getPgClient(c)
      const drizzle = getDrizzleClient(pgClient)
      const lockOrgId = await loadRoleBindingLockOrgId(drizzle, bindingId)
      if (!lockOrgId) {
        return c.json({ error: 'Role binding not found' }, 404)
      }

      const result = await drizzle.transaction(async (tx) => {
        const txDrizzle = tx as unknown as DrizzleClient
        await lockRbacOrgs(txDrizzle, [lockOrgId])

        const bindingResult = await loadManagedBinding(c, txDrizzle, bindingId)
        if (!bindingResult.ok) {
          return bindingResult
        }
        const binding = bindingResult.data

        const roleResult = await loadAssignableRoleForBinding(c, txDrizzle, binding, roleName)
        if (!roleResult.ok) {
          return roleResult
        }
        const role = roleResult.data

        const callerMaxRank = await getCallerMaxPriorityRank(txDrizzle, 'jwt', auth.userId, binding.org_id!)
        if (role.priority_rank > callerMaxRank) {
          return { ok: false as const, response: c.json({ error: 'Cannot assign a role with higher privileges than your own' }, 403) }
        }

        const updated = await updateRoleBindingRole(txDrizzle, bindingId, binding, role.id, callerMaxRank)
        if (!updated) {
          return { ok: false as const, response: c.json({ error: 'Cannot modify a binding for a role with higher privileges than your own' }, 403) }
        }

        return { ok: true as const, data: { binding, role, updated } }
      })

      if (!result.ok) {
        return result.response
      }

      const { binding, role, updated } = result.data
      cloudlog({
        requestId: c.get('requestId'),
        message: 'role_binding_updated',
        bindingId,
        orgId: binding.org_id,
        principal_type: binding.principal_type,
        principal_id: binding.principal_id,
        old_role_id: binding.role_id,
        new_role_id: role.id,
        scope_type: binding.scope_type,
        app_id: binding.app_id,
        channel_id: binding.channel_id,
      })

      return c.json(updated)
    }
    catch (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'role_binding_update_failed',
        bindingId,
        error,
      })
      if (isLastSuperAdminDemotionError(error)) {
        return c.json({ error: 'Cannot demote the last org_super_admin' }, 409)
      }
      return c.json({ error: 'Internal server error' }, 500)
    }
    finally {
      if (pgClient) {
        await closeClient(c, pgClient)
      }
    }
  },
)

// DELETE /private/role_bindings/:binding_id - Remove a role
app.delete('/:binding_id', requireAuthMfaAndGuardLimitedKeys, sValidator('param', bindingIdParamSchema, invalidBindingIdHook), async (c) => {
  const { binding_id: bindingId } = c.req.valid('param')

  const auth = c.get('auth')!

  let pgClient
  try {
    pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)
    const lockOrgId = await loadRoleBindingLockOrgId(drizzle, bindingId)
    if (!lockOrgId) {
      return c.json({ error: 'Role binding not found' }, 404)
    }

    const result = await drizzle.transaction(async (tx) => {
      const txDrizzle = tx as unknown as DrizzleClient
      await lockRbacOrgs(txDrizzle, [lockOrgId])

      const bindingResult = await loadManagedBinding(c, txDrizzle, bindingId)
      if (!bindingResult.ok) {
        return bindingResult
      }
      const binding = bindingResult.data

      const callerMaxRank = await getCallerMaxPriorityRank(txDrizzle, 'jwt', auth.userId, binding.org_id!)
      const [targetRole] = await txDrizzle
        .select({ priority_rank: schema.roles.priority_rank })
        .from(schema.roles)
        .where(eq(schema.roles.id, binding.role_id!))
        .limit(1)

      if (targetRole && targetRole.priority_rank > callerMaxRank) {
        return { ok: false as const, response: c.json({ error: 'Cannot delete a binding for a role with higher privileges than your own' }, 403) }
      }

      await deleteChannelPermissionOverridesForBinding(tx, binding)
      await tx
        .delete(schema.role_bindings)
        .where(eq(schema.role_bindings.id, bindingId))

      if (binding.principal_type === 'user' && binding.scope_type === 'org' && binding.org_id) {
        await tx
          .update(schema.org_users)
          .set({
            rbac_role_name: null,
            is_invite: false,
            updated_at: sql`now()`,
          })
          .where(
            and(
              eq(schema.org_users.user_id, binding.principal_id),
              eq(schema.org_users.org_id, binding.org_id),
              sql`${schema.org_users.app_id} IS NULL`,
              sql`${schema.org_users.channel_id} IS NULL`,
              eq(schema.org_users.is_invite, false),
            ),
          )
      }

      return { ok: true as const, data: binding }
    })

    if (!result.ok) {
      return result.response
    }

    const binding = result.data
    cloudlog({
      requestId: c.get('requestId'),
      message: 'role_binding_deleted',
      bindingId,
      orgId: binding.org_id,
      principal_type: binding.principal_type,
      principal_id: binding.principal_id,
      role_id: binding.role_id,
      scope_type: binding.scope_type,
      app_id: binding.app_id,
      channel_id: binding.channel_id,
    })

    return c.json({ success: true })
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'role_binding_delete_failed',
      bindingId,
      error,
    })
    if (isLastSuperAdminDemotionError(error)) {
      return c.json({ error: 'Cannot demote the last org_super_admin' }, 409)
    }
    return c.json({ error: 'Internal server error' }, 500)
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
})
