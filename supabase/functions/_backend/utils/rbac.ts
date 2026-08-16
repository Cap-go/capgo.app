/**
 * RBAC Permission System
 *
 * This module provides permission checks backed by role_bindings.
 *
 * Usage:
 *   import { checkPermission } from './rbac.ts'
 *
 *   // Check app-level permission
 *   const allowed = await checkPermission(c, 'app.upload_bundle', { appId: 'com.example.app' })
 *
 *   // Check channel-level permission (appId and orgId are auto-derived)
 *   const allowed = await checkPermission(c, 'channel.promote_bundle', { channelId: 123 })
 *
 *   // Check org-level permission
 *   const allowed = await checkPermission(c, 'org.invite_user', { orgId: 'uuid...' })
 */
import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import { sql } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { quickError } from './hono.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from './pg.ts'

// =============================================================================
// Types
// =============================================================================

/**
 * All available RBAC permissions from the permissions table.
 * These match exactly the keys in public.permissions.
 */
export type Permission
  = | 'org.read'
    | 'org.create_app'
    | 'org.update_settings'
    | 'org.delete'
    | 'org.read_members'
    | 'org.invite_user'
    | 'org.manage_apikeys'
    | 'org.update_user_roles'
    | 'org.read_billing'
    | 'org.update_billing'
    | 'org.read_invoices'
    | 'org.read_audit'
    | 'org.read_billing_audit'
    // App permissions
    | 'app.read'
    | 'app.update_settings'
    | 'app.delete'
    | 'app.read_bundles'
    | 'app.upload_bundle'
    | 'app.create_channel'
    | 'app.read_channels'
    | 'app.read_logs'
    | 'app.manage_notifications'
    | 'app.manage_devices'
    | 'app.read_devices'
    | 'app.build_native'
    | 'app.read_audit'
    | 'app.update_user_roles'
    // Bundle permissions
    | 'bundle.delete'
    // Channel permissions
    | 'channel.read'
    | 'channel.update_settings'
    | 'channel.delete'
    | 'channel.read_history'
    | 'channel.promote_bundle'
    | 'channel.rollback_bundle'
    | 'channel.manage_forced_devices'
    | 'channel.read_forced_devices'
    | 'channel.read_audit'

/**
 * Scope types for RBAC permissions
 */
export type ScopeType = 'org' | 'app' | 'channel'

/**
 * Scope identifiers for permission checks.
 * At least one must be provided. More specific scopes (channelId) will auto-derive
 * parent scopes (appId, orgId) if not explicitly provided.
 */
export interface PermissionScope {
  orgId?: string
  appId?: string
  channelId?: number
}

export interface ApiKeyOrgPermissions {
  canManageApiKeys: boolean
  canUpdateUserRoles: boolean
}

interface ApiKeyOrgPermissionRow extends Record<string, unknown> {
  org_id: string
  can_manage_apikeys: boolean
  can_update_user_roles: boolean
}

type ApiKeyPermissionFailure = 'org.manage_apikeys' | 'org.update_user_roles'

type DrizzleExecutor = Pick<ReturnType<typeof getDrizzleClient>, 'execute'>

const TRANSIENT_NODE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
])

// Postgres SQLSTATE classes/codes that mean the connection itself failed.
const TRANSIENT_PG_SQLSTATES = new Set([
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '08007', // transaction_resolution_unknown
  '08P01', // protocol_violation
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
  '57014', // query_canceled (statement_timeout / lock_timeout)
])

const TRANSIENT_ERROR_MESSAGE_RE = /connection (?:terminated|ended|closed|refused|reset)|timeout exceeded when trying to connect|connect(?:ion)? timed? ?out|canceling statement due to (?:statement|lock) timeout|network(?: |_)?error|socket hang up|hyperdrive|too many clients already/i

function readErrorField(error: unknown, key: string): unknown {
  if (!error || typeof error !== 'object')
    return undefined
  return (error as Record<string, unknown>)[key]
}

/**
 * Walk Drizzle/node-postgres cause chains for connection/timeout signals.
 * Invalid query params (e.g. bad UUID cast 22P02) are NOT transient — those
 * must keep looking like ACL deny so authz endpoints stay stable.
 */
function isTransientPermissionCheckError(error: unknown, depth = 0): boolean {
  if (!error || depth > 6)
    return false

  if (typeof error === 'string')
    return TRANSIENT_ERROR_MESSAGE_RE.test(error)

  const code = readErrorField(error, 'code')
  if (typeof code === 'string') {
    if (TRANSIENT_NODE_ERROR_CODES.has(code) || TRANSIENT_PG_SQLSTATES.has(code))
      return true
  }

  const message = readErrorField(error, 'message')
  if (typeof message === 'string' && TRANSIENT_ERROR_MESSAGE_RE.test(message))
    return true

  const errno = readErrorField(error, 'errno')
  if (typeof errno === 'string' && TRANSIENT_NODE_ERROR_CODES.has(errno))
    return true

  const cause = readErrorField(error, 'cause')
  if (cause !== undefined && isTransientPermissionCheckError(cause, depth + 1))
    return true

  const errors = readErrorField(error, 'errors')
  if (Array.isArray(errors)) {
    return errors.some(entry => isTransientPermissionCheckError(entry, depth + 1))
  }

  return false
}

/**
 * Permission helpers must never map infrastructure failures to "denied".
 * Callers treat `false` as ACL deny (401/403). Transient Hyperdrive/Postgres
 * errors must surface as 503 so clients (especially TUS) can retry.
 * Non-transient query failures (invalid UUID, etc.) still deny.
 */
function handlePermissionCheckError(
  c: Context<MiddlewareKeyVariables>,
  permission: Permission,
  scope: PermissionScope,
  error: unknown,
  source: 'checkPermission' | 'checkPermissionPg',
): false {
  if (error instanceof HTTPException)
    throw error

  const transient = isTransientPermissionCheckError(error)

  cloudlogErr({
    requestId: c.get('requestId'),
    message: `${source} error`,
    error,
    permission,
    scope,
    transient,
  })

  if (transient) {
    quickError(
      503,
      'upstream_unavailable',
      'Permission check temporarily unavailable',
      { permission, scope },
      error,
      { alert: false },
    )
  }

  return false
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Main permission check function.
 *
 * Uses the SQL function rbac_check_permission_direct.
 *
 * @param c - Hono context with auth info
 * @param permission - The RBAC permission to check (e.g., 'app.upload_bundle')
 * @param scope - Scope identifiers (orgId, appId, channelId). Parent scopes are auto-derived by SQL function.
 * @returns true if the user has the permission, false otherwise
 *
 * @example
 * // Check app-level permission
 * if (await checkPermission(c, 'app.upload_bundle', { appId: 'com.example.app' })) {
 *   // User can upload bundles
 * }
 *
 * @example
 * // Check channel-level permission (appId and orgId are auto-derived)
 * if (await checkPermission(c, 'channel.promote_bundle', { channelId: 123 })) {
 *   // User can promote bundles on this channel
 * }
 *
 * @example
 * // Check org-level permission
 * if (await checkPermission(c, 'org.invite_user', { orgId: 'uuid...' })) {
 *   // User can invite members
 * }
 */
export async function checkPermission(
  c: Context<MiddlewareKeyVariables>,
  permission: Permission,
  scope: PermissionScope,
): Promise<boolean> {
  const auth = c.get('auth')
  if (!auth?.userId) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'checkPermission: no auth',
      permission,
    })
    return false
  }

  const { userId, apikey } = auth

  // For hashed keys, apikey.key is null, so we use capgkey from the request header
  const apikeyString = apikey?.key ?? c.get('capgkey') ?? null
  const { orgId = null, appId = null, channelId = null } = scope

  cloudlog({
    requestId: c.get('requestId'),
    message: 'checkPermission: checking',
    permission,
    scope,
    userId,
    hasApikey: !!apikeyString,
  })

  let pgClient
  try {
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)

    if (auth.authType === 'apikey' && apikey?.rbac_id) {
      if (!apikeyString)
        return false

      const rbacOnlyResult = await drizzleClient.execute(
        sql`SELECT public.rbac_check_permission_direct(
          ${permission},
          ${userId}::uuid,
          ${orgId}::uuid,
          ${appId},
          ${channelId}::bigint,
          ${apikeyString}
        ) AS allowed`,
      )

      const rbacOnlyAllowed = (rbacOnlyResult.rows[0] as any)?.allowed === true
      cloudlog({
        requestId: c.get('requestId'),
        message: 'checkPermission: rbac-only apikey result',
        permission,
        scope,
        allowed: rbacOnlyAllowed,
      })
      return rbacOnlyAllowed
    }

    // Use the unified SQL function for JWT checks and non-key fallbacks.
    const result = await drizzleClient.execute(
      sql`SELECT public.rbac_check_permission_direct(
        ${permission},
        ${userId}::uuid,
        ${orgId}::uuid,
        ${appId},
        ${channelId}::bigint,
        ${apikeyString}
      ) as allowed`,
    )

    const allowed = (result.rows[0] as any)?.allowed === true

    cloudlog({
      requestId: c.get('requestId'),
      message: 'checkPermission: result',
      permission,
      scope,
      allowed,
    })

    return allowed
  }
  catch (e) {
    return handlePermissionCheckError(c, permission, scope, e, 'checkPermission')
  }
  finally {
    if (pgClient) {
      closeClient(c, pgClient)
    }
  }
}

/**
 * Require a permission, throwing an error if not allowed.
 * Use this for endpoints that should return 403 if permission is denied.
 *
 * @throws HTTPException with status 403 if permission is denied
 */
export async function requirePermission(
  c: Context<MiddlewareKeyVariables>,
  permission: Permission,
  scope: PermissionScope,
): Promise<void> {
  const allowed = await checkPermission(c, permission, scope)
  if (!allowed) {
    const { quickError } = await import('./hono.ts')
    quickError(403, 'permission_denied', `Permission denied: ${permission}`, {
      permission,
      scope,
    })
  }
}

/**
 * Check multiple permissions at once.
 * Returns true only if ALL permissions are granted.
 */
export async function checkPermissions(
  c: Context<MiddlewareKeyVariables>,
  permissions: Permission[],
  scope: PermissionScope,
): Promise<boolean> {
  for (const permission of permissions) {
    if (!(await checkPermission(c, permission, scope))) {
      return false
    }
  }
  return true
}

/**
 * Check if ANY of the given permissions is granted.
 */
export async function checkAnyPermission(
  c: Context<MiddlewareKeyVariables>,
  permissions: Permission[],
  scope: PermissionScope,
): Promise<boolean> {
  for (const permission of permissions) {
    if (await checkPermission(c, permission, scope)) {
      return true
    }
  }
  return false
}

/**
 * Check permission using an existing Drizzle client.
 * Use this when you already have a connection open and want to avoid opening a new one.
 *
 * @param c - Hono context with auth info
 * @param permission - The RBAC permission to check
 * @param scope - Scope identifiers
 * @param drizzleClient - An existing Drizzle client
 * @param userId - User ID to check (required, as it may come from API key lookup)
 * @param apikeyString - Optional API key string for additional validation
 */
export async function checkPermissionPg(
  c: Context<MiddlewareKeyVariables>,
  permission: Permission,
  scope: PermissionScope,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  userId: string,
  apikeyString?: string | null,
): Promise<boolean> {
  if (!userId) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'checkPermissionPg: no userId',
      permission,
    })
    return false
  }

  const { orgId = null, appId = null, channelId = null } = scope
  const auth = c.get('auth')

  cloudlog({
    requestId: c.get('requestId'),
    message: 'checkPermissionPg: checking',
    permission,
    scope,
    userId,
    hasApikey: !!apikeyString,
  })

  try {
    if (auth?.authType === 'apikey' && auth.apikey?.rbac_id) {
      if (!apikeyString)
        return false

      const rbacOnlyResult = await drizzleClient.execute(
        sql`SELECT public.rbac_check_permission_direct(
          ${permission},
          ${userId}::uuid,
          ${orgId}::uuid,
          ${appId},
          ${channelId}::bigint,
          ${apikeyString}
        ) AS allowed`,
      )

      const rbacOnlyAllowed = (rbacOnlyResult.rows[0] as any)?.allowed === true
      cloudlog({
        requestId: c.get('requestId'),
        message: 'checkPermissionPg: rbac-only apikey result',
        permission,
        scope,
        allowed: rbacOnlyAllowed,
      })
      return rbacOnlyAllowed
    }

    // Use the unified SQL function for JWT checks and non-key fallbacks.
    const result = await drizzleClient.execute(
      sql`SELECT public.rbac_check_permission_direct(
        ${permission},
        ${userId}::uuid,
        ${orgId}::uuid,
        ${appId},
        ${channelId}::bigint,
        ${apikeyString ?? null}
      ) as allowed`,
    )

    const allowed = (result.rows[0] as any)?.allowed === true

    cloudlog({
      requestId: c.get('requestId'),
      message: 'checkPermissionPg: result',
      permission,
      scope,
      allowed,
    })

    return allowed
  }
  catch (e) {
    return handlePermissionCheckError(c, permission, scope, e, 'checkPermissionPg')
  }
}

export async function checkApiKeyOrgPermissionsPg(
  c: Context<MiddlewareKeyVariables>,
  orgIds: string[],
  drizzleClient: DrizzleExecutor,
  userId: string,
  apikeyString: string | null,
  failurePermission: ApiKeyPermissionFailure,
): Promise<Map<string, ApiKeyOrgPermissions>> {
  if (!userId || orgIds.length === 0)
    return new Map()

  try {
    const result = await drizzleClient.execute<ApiKeyOrgPermissionRow>(
      sql`SELECT
        requested_orgs.org_id,
        CASE WHEN pg_input_is_valid(requested_orgs.org_id, 'uuid') THEN
          public.rbac_check_permission_direct(
            'org.manage_apikeys',
            ${userId}::uuid,
            requested_orgs.org_id::uuid,
            NULL::varchar,
            NULL::bigint,
            ${apikeyString}::text
          )
        ELSE false END AS can_manage_apikeys,
        CASE WHEN pg_input_is_valid(requested_orgs.org_id, 'uuid') THEN
          public.rbac_check_permission_direct(
            'org.update_user_roles',
            ${userId}::uuid,
            requested_orgs.org_id::uuid,
            NULL::varchar,
            NULL::bigint,
            ${apikeyString}::text
          )
        ELSE false END AS can_update_user_roles
      FROM unnest(${orgIds}::text[]) WITH ORDINALITY AS requested_orgs(org_id, ordinal)
      ORDER BY requested_orgs.ordinal`,
    )

    return new Map(result.rows.map(row => [
      row.org_id,
      {
        canManageApiKeys: row.can_manage_apikeys === true,
        canUpdateUserRoles: row.can_update_user_roles === true,
      },
    ] as const))
  }
  catch (error) {
    handlePermissionCheckError(c, failurePermission, { orgId: orgIds[0] }, error, 'checkPermissionPg')
    return new Map()
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Infer the scope type from a permission key.
 */
export function getScopeTypeFromPermission(permission: Permission): ScopeType {
  if (permission.startsWith('org.'))
    return 'org'
  if (permission.startsWith('app.') || permission.startsWith('bundle.'))
    return 'app'
  if (permission.startsWith('channel.'))
    return 'channel'
  return 'org' // Default fallback
}
