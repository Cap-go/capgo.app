import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { sql } from 'drizzle-orm'
import { quickError } from '../../utils/hono.ts'
import { assertJwtMfaAssurance } from '../../utils/jwt_mfa_assurance.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../../utils/pg.ts'
import { checkPermission, checkPermissionPg } from '../../utils/rbac.ts'
import { supabaseAdmin, supabaseWithAuth } from '../../utils/supabase.ts'

type ApiKeyRow = Database['public']['Tables']['apikeys']['Row']
type ApiKeyManagementOrgMap = Map<string, string[]>

export function requireApiKeyManagementAuth(
  c: Context<MiddlewareKeyVariables>,
  errorCode: string,
  message: string,
  moreInfo: Record<string, unknown> = {},
): AuthInfo {
  const auth = c.get('auth') as AuthInfo | undefined
  if (!auth?.userId) {
    throw quickError(401, errorCode, message, moreInfo)
  }

  return auth
}

export async function requireJwtMfaForPrivilegedAction(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
): Promise<void> {
  await assertJwtMfaAssurance(c, auth)
}

export function isValidApiKeyIdFormat(id: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const numericRegex = /^\d+$/
  const legacyKeyRegex = /^[\w.:-]{8,256}$/
  return uuidRegex.test(id) || numericRegex.test(id) || legacyKeyRegex.test(id)
}

function isNumericApiKeyId(id: string): boolean {
  return /^\d+$/.test(id)
}

async function loadApiKeyBindingOrgIdsForRbacIds(
  c: Context<MiddlewareKeyVariables>,
  rbacIds: string[],
): Promise<ApiKeyManagementOrgMap> {
  const uniqueRbacIds = [...new Set(rbacIds.filter(Boolean))]
  const orgIdsByRbacId: ApiKeyManagementOrgMap = new Map(uniqueRbacIds.map(rbacId => [rbacId, []]))
  if (uniqueRbacIds.length === 0) {
    return orgIdsByRbacId
  }

  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const { rows } = await pgClient.query<{ principal_id: string, org_id: string }>(
      `
      SELECT DISTINCT principal_id::text, org_id::text
      FROM public.role_bindings
      WHERE principal_type = public.rbac_principal_apikey()
        AND principal_id = ANY($1::uuid[])
        AND org_id IS NOT NULL
        AND (expires_at IS NULL OR expires_at > now())
      `,
      [uniqueRbacIds],
    )

    for (const row of rows) {
      const orgIds = orgIdsByRbacId.get(row.principal_id) ?? []
      orgIds.push(row.org_id)
      orgIdsByRbacId.set(row.principal_id, orgIds)
    }

    return orgIdsByRbacId
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
}

export async function getApiKeyManageableOrgIds(
  c: Context<MiddlewareKeyVariables>,
  authApikey: ApiKeyRow | undefined,
): Promise<Set<string>> {
  if (!authApikey?.rbac_id) {
    return new Set()
  }

  const callerOrgIds = (await loadApiKeyBindingOrgIdsForRbacIds(c, [authApikey.rbac_id])).get(authApikey.rbac_id) ?? []
  const manageableOrgIds = new Set<string>()
  for (const orgId of callerOrgIds) {
    if (await checkPermission(c, 'org.manage_apikeys', { orgId })) {
      manageableOrgIds.add(orgId)
    }
  }

  return manageableOrgIds
}

function assertTargetOrgIdsAreManageable(
  manageableOrgIds: Set<string>,
  targetOrgIds: string[],
) {
  return targetOrgIds.length > 0 && targetOrgIds.every(orgId => manageableOrgIds.has(orgId))
}

export interface ClientBindingInput {
  role_name: string
  scope_type: 'org' | 'app' | 'channel'
  org_id: string
  app_id?: string | null
  channel_id?: string | number | null
  reason?: string
}

function parseOptionalAppId(value: unknown): string | null {
  if (value === undefined || value === null)
    return null
  if (typeof value !== 'string')
    throw quickError(400, 'invalid_bindings', 'app_id must be a string when provided')
  return value
}

function parseOptionalChannelId(value: unknown): string | number | null {
  if (value === undefined || value === null)
    return null
  if (typeof value !== 'string' && typeof value !== 'number')
    throw quickError(400, 'invalid_bindings', 'channel_id must be a string or number when provided')
  return value
}

export function sanitizeClientBindings(bindings: unknown[]): ClientBindingInput[] {
  return bindings.map((binding) => {
    if (!binding || typeof binding !== 'object') {
      throw quickError(400, 'invalid_bindings', 'Each binding must be an object')
    }
    const value = binding as Record<string, unknown>
    const role_name = value.role_name
    const scope_type = value.scope_type
    const org_id = value.org_id
    if (typeof role_name !== 'string' || !role_name) {
      throw quickError(400, 'invalid_bindings', 'Each binding must have a role_name')
    }
    if (scope_type !== 'org' && scope_type !== 'app' && scope_type !== 'channel') {
      throw quickError(400, 'invalid_bindings', 'Each binding must have a valid scope_type (org, app, channel)')
    }
    if (typeof org_id !== 'string' || !org_id) {
      throw quickError(400, 'invalid_bindings', 'Each binding must have an org_id')
    }
    return {
      role_name,
      scope_type,
      org_id,
      app_id: parseOptionalAppId(value.app_id),
      channel_id: parseOptionalChannelId(value.channel_id),
      reason: typeof value.reason === 'string' ? value.reason : undefined,
    }
  })
}

const APIKEY_MANAGER_DENIED_ASSIGNABLE_ROLES = new Set([
  'org_super_admin',
  'org_admin',
  'app_admin',
  'app_preview',
  'channel_admin',
])

export async function assertApiKeyManagerCanAssignBindings(
  c: Parameters<typeof checkPermission>[0],
  auth: AuthInfo,
  bindings: Array<{ role_name: string, org_id: string }>,
  drizzle?: ReturnType<typeof getDrizzleClient>,
) {
  // API-key managers use JWT sessions to create keys. Determine whether the
  // caller can assign sensitive roles from RBAC permissions, not auth type.
  const apikeyString = auth.apikey?.key ?? c.get('capgkey') ?? null
  const orgIds = [...new Set(bindings.map(binding => binding.org_id))]
  for (const orgId of orgIds) {
    const canUpdateUserRoles = drizzle
      ? await checkPermissionPg(c, 'org.update_user_roles', { orgId }, drizzle, auth.userId, apikeyString)
      : await checkPermission(c, 'org.update_user_roles', { orgId })
    if (canUpdateUserRoles) {
      continue
    }

    for (const binding of bindings) {
      if (binding.org_id !== orgId) {
        continue
      }
      if (APIKEY_MANAGER_DENIED_ASSIGNABLE_ROLES.has(binding.role_name)) {
        throw quickError(403, 'forbidden_binding', `Forbidden - API key managers cannot assign the ${binding.role_name} role`)
      }
    }
  }
}

async function loadApiKeyOrgRoleBindings(
  c: Context<MiddlewareKeyVariables>,
  apikeyRbacId: string,
): Promise<Array<{ role_name: string, org_id: string }>> {
  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const { rows } = await pgClient.query<{ role_name: string, org_id: string }>(
      `
      SELECT DISTINCT r.name AS role_name, rb.org_id::text AS org_id
      FROM public.role_bindings rb
      JOIN public.roles r ON r.id = rb.role_id
      WHERE rb.principal_type = public.rbac_principal_apikey()
        AND rb.principal_id = $1::uuid
        AND rb.org_id IS NOT NULL
        AND (rb.expires_at IS NULL OR rb.expires_at > now())
      `,
      [apikeyRbacId],
    )
    return rows
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
}

export async function assertApiKeyManagerCanRotateTarget(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
  targetRbacId: string,
) {
  const bindings = await loadApiKeyOrgRoleBindings(c, targetRbacId)
  await assertApiKeyManagerCanAssignBindings(c, auth, bindings)
}

export async function ensureApiKeyManagementAllowed(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
  authApikey: ApiKeyRow | undefined,
  errorCode: string,
  moreInfo: Record<string, unknown> = {},
) {
  if (auth.authType === 'jwt') {
    return
  }

  const manageableOrgIds = await getApiKeyManageableOrgIds(c, authApikey)
  if (manageableOrgIds.size === 0) {
    throw quickError(401, errorCode, 'API key management requires RBAC org role management permission', { ...moreInfo, apikeyId: authApikey?.id ?? auth.apikey?.id })
  }
}

export async function getApiKeyBindingOrgIds(
  c: Context<MiddlewareKeyVariables>,
  apikeyRbacId: string,
): Promise<string[]> {
  return (await loadApiKeyBindingOrgIdsForRbacIds(c, [apikeyRbacId])).get(apikeyRbacId) ?? []
}

export async function ensureApiKeyCanManageTargetOrgIds(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
  authApikey: ApiKeyRow | undefined,
  targetOrgIds: string[],
  errorCode: string,
  moreInfo: Record<string, unknown> = {},
) {
  if (auth.authType === 'jwt') {
    return
  }

  const manageableOrgIds = await getApiKeyManageableOrgIds(c, authApikey)
  if (!assertTargetOrgIdsAreManageable(manageableOrgIds, targetOrgIds)) {
    throw quickError(401, errorCode, 'API key cannot manage this API key', { ...moreInfo, apikeyId: authApikey?.id ?? auth.apikey?.id })
  }
}
export async function filterApiKeysManageableByAuth<T extends Pick<ApiKeyRow, 'rbac_id'>>(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
  authApikey: ApiKeyRow | undefined,
  apikeys: T[],
): Promise<T[]> {
  if (auth.authType === 'jwt') {
    return apikeys
  }

  const manageableOrgIds = await getApiKeyManageableOrgIds(c, authApikey)
  if (manageableOrgIds.size === 0) {
    return []
  }

  const apikeyRbacIds = apikeys.map(apikey => apikey.rbac_id).filter((rbacId): rbacId is string => !!rbacId)
  const orgIdsByRbacId = await loadApiKeyBindingOrgIdsForRbacIds(c, apikeyRbacIds)
  return apikeys.filter((apikey) => {
    if (!apikey.rbac_id) {
      return false
    }
    return assertTargetOrgIdsAreManageable(manageableOrgIds, orgIdsByRbacId.get(apikey.rbac_id) ?? [])
  })
}

// Personal keys are managed by their owner. Shared keys (owner_org_id) are
// managed by whoever holds org.manage_apikeys in the owner org; user_id is
// attribution only. JWT callers are scoped by RLS, API-key callers by the orgs
// the calling key can manage.
export async function selectManageableApiKeyByIdentifier<T = ApiKeyRow>(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
  id: string,
  columns = '*',
) {
  let query
  if (auth.authType === 'apikey') {
    const manageableOrgIds = [...await getApiKeyManageableOrgIds(c, c.get('apikey') as ApiKeyRow | undefined)]
    const ownershipFilters = [`and(user_id.eq.${auth.userId},owner_org_id.is.null)`]
    if (manageableOrgIds.length > 0) {
      ownershipFilters.push(`owner_org_id.in.(${manageableOrgIds.join(',')})`)
    }
    query = supabaseAdmin(c)
      .from('apikeys')
      .select(columns)
      .or(ownershipFilters.join(','))
  }
  else {
    query = supabaseWithAuth(c, auth)
      .from('apikeys')
      .select(columns)
  }

  const filteredQuery = isNumericApiKeyId(id)
    ? query.eq('id', Number(id))
    : query.eq('key', id)

  const { data, error } = await filteredQuery.single()
  return { data: data as T | null, error }
}

// Call only after selectManageableApiKeyByIdentifier authorized this key.
// JWT callers delete through RLS (the audit trigger sees auth.uid()); API-key
// callers delete on a service connection that carries the calling key as actor.
export async function deleteManageableApiKeyById(c: Context<MiddlewareKeyVariables>, auth: AuthInfo, apikeyId: number): Promise<{ error: unknown }> {
  if (auth.authType === 'apikey') {
    try {
      await withApiKeyAuditActor(c, auth, tx => tx.execute(sql`DELETE FROM public.apikeys WHERE id = ${apikeyId}::bigint`))
      return { error: null }
    }
    catch (error) {
      return { error }
    }
  }

  return supabaseWithAuth(c, auth)
    .from('apikeys')
    .delete()
    .eq('id', apikeyId)
}

type DrizzleExecutor = Pick<ReturnType<typeof getDrizzleClient>, 'execute'>

// Returns the first permission the key grants that the caller does not hold:
// role permissions (including inherited roles, in the binding scope) and
// channel allow-overrides on their channel. Runs on the given executor so it
// can see bindings created earlier in the same transaction.
async function findApiKeyPermissionMissingForCaller(
  db: DrizzleExecutor,
  apikeyRbacId: string,
  callerUserId: string,
): Promise<{ hasBindings: boolean, missingPermission: string | null }> {
  const result = await db.execute<{ has_bindings: boolean, missing_permission: string | null }>(sql`
      WITH RECURSIVE key_bindings AS (
        SELECT rb.role_id, rb.scope_type, rb.org_id, a.app_id AS public_app_id, ch.id AS channel_id
        FROM public.role_bindings rb
        LEFT JOIN public.apps a ON a.id = rb.app_id
        LEFT JOIN public.channels ch ON ch.rbac_id = rb.channel_id
        WHERE rb.principal_type = public.rbac_principal_apikey()
          AND rb.principal_id = ${apikeyRbacId}::uuid
          AND rb.org_id IS NOT NULL
          AND (rb.expires_at IS NULL OR rb.expires_at > now())
      ),
      -- Same closure as rbac_has_permission: inherited roles stay in the
      -- scope of the binding that grants them.
      role_closure AS (
        SELECT key_bindings.role_id AS effective_role_id, key_bindings.scope_type, key_bindings.org_id, key_bindings.public_app_id, key_bindings.channel_id
        FROM key_bindings

        UNION

        SELECT role_hierarchy.child_role_id, role_closure.scope_type, role_closure.org_id, role_closure.public_app_id, role_closure.channel_id
        FROM role_closure
        JOIN public.role_hierarchy ON role_hierarchy.parent_role_id = role_closure.effective_role_id
        JOIN public.roles AS child_role
          ON child_role.id = role_hierarchy.child_role_id
          AND child_role.scope_type = role_closure.scope_type
      ),
      required_permissions AS (
        SELECT permission.key AS permission_key, role_closure.org_id, role_closure.public_app_id, role_closure.channel_id
        FROM role_closure
        JOIN public.role_permissions ON role_permissions.role_id = role_closure.effective_role_id
        JOIN public.permissions AS permission ON permission.id = role_permissions.permission_id

        UNION

        -- Channel allow-overrides grant permissions beyond the key's roles.
        SELECT overrides.permission_key, channels.owner_org, channels.app_id, channels.id
        FROM public.channel_permission_overrides AS overrides
        JOIN public.channels AS channels ON channels.id = overrides.channel_id
        WHERE overrides.principal_type = public.rbac_principal_apikey()
          AND overrides.principal_id = ${apikeyRbacId}::uuid
          AND overrides.is_allowed
      )
      SELECT
        EXISTS (SELECT 1 FROM key_bindings) AS has_bindings,
        (
          SELECT required_permissions.permission_key
          FROM required_permissions
          WHERE NOT public.rbac_check_permission_direct(
            required_permissions.permission_key,
            ${callerUserId}::uuid,
            required_permissions.org_id,
            required_permissions.public_app_id,
            required_permissions.channel_id,
            NULL
          )
          LIMIT 1
        ) AS missing_permission
      `)
  const row = result.rows[0]
  return { hasBindings: row?.has_bindings === true, missingPermission: row?.missing_permission ?? null }
}

// Anyone who gets the secret of a shared key uses its rights, even after they
// leave the org. Creating or regenerating one therefore requires the caller to
// already hold every effective permission of the key.
export async function assertCallerHoldsSharedApiKeyPermissions(
  db: DrizzleExecutor,
  auth: AuthInfo,
  apikeyRbacId: string,
) {
  if (auth.authType !== 'jwt' || !auth.userId) {
    throw quickError(403, 'cannot_update_apikey', 'Only user sessions can create or regenerate shared API keys')
  }

  const { hasBindings, missingPermission } = await findApiKeyPermissionMissingForCaller(db, apikeyRbacId, auth.userId)
  if (!hasBindings) {
    throw quickError(403, 'cannot_update_apikey', 'Shared API key has no active bindings')
  }
  if (missingPermission) {
    throw quickError(403, 'forbidden_binding', `Forbidden - this shared API key requires the ${missingPermission} permission, which you do not hold`)
  }
}

export async function assertCallerCanTakeOverSharedApiKey(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
  targetRbacId: string,
) {
  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    await assertCallerHoldsSharedApiKeyPermissions(getDrizzleClient(pgClient), auth, targetRbacId)
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
}

// Backend writes use a service connection, so the audit trigger cannot see the
// caller. Pass it through transaction-local settings (see audit_log_trigger).
export async function setApiKeyAuditActor(db: DrizzleExecutor, auth: AuthInfo) {
  const actorApiKeyId = auth.authType === 'apikey' && auth.apikey?.id ? String(auth.apikey.id) : ''
  await db.execute(sql`SELECT
    pg_catalog.set_config('capgo.audit_actor_user_id', ${auth.userId ?? ''}, true),
    pg_catalog.set_config('capgo.audit_actor_apikey_id', ${actorApiKeyId}, true)`)
}

export async function withApiKeyAuditActor<T>(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
  fn: (tx: ReturnType<typeof getDrizzleClient>) => Promise<T>,
): Promise<T> {
  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)
    return await drizzle.transaction(async (tx) => {
      const txDrizzle = tx as unknown as ReturnType<typeof getDrizzleClient>
      await setApiKeyAuditActor(txDrizzle, auth)
      return fn(txDrizzle)
    })
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
}
