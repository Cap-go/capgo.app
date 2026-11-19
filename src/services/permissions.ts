/**
 * RBAC Permission System - Frontend
 *
 * This module provides the frontend interface to the backend RBAC permission system.
 * It calls the SQL function rbac_check_permissions(), which evaluates a batch of
 * rbac_check_permission() / rbac_check_permission_direct() checks in one round trip.
 * Checks queued in the same task are coalesced and results are cached per session.
 *
 * Usage:
 *   import { checkPermissions } from '~/services/permissions'
 *
 *   // Check app-level permission
 *   const canUpload = await checkPermissions('app.upload_bundle', { appId: 'com.example.app' })
 *
 *   // Check org-level permission
 *   const canInvite = await checkPermissions('org.invite_user', { orgId })
 *
 *   // Check channel-level permission (orgId and appId are auto-derived by backend)
 *   const canPromote = await checkPermissions('channel.promote_bundle', { channelId: 123 })
 */

import type { Database } from '~/types/database.types'
import { useConsole } from '~/services/console'
import { useMainStore } from '~/stores/main'

/**
 * All available RBAC permissions.
 * These match exactly the keys in the public.permissions table.
 */
export type Permission
  // Org permissions
  = | 'org.read'
    | 'org.update_settings'
    | 'org.read_members'
    | 'org.invite_user'
    | 'org.update_user_roles'
    | 'org.read_billing'
    | 'org.update_billing'
    | 'org.read_invoices'
    | 'org.read_audit'
    | 'org.read_billing_audit'
    | 'org.create_app'
    | 'org.manage_apikeys'
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
    | 'app.manage_apikeys'
    | 'app.transfer'
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
 * Scope identifiers for permission checks.
 * At least one must be provided. More specific scopes (channelId) will auto-derive
 * parent scopes (appId, orgId) if not explicitly provided by the backend.
 */
export interface PermissionScope {
  orgId?: string
  appId?: string
  channelId?: number
}

export type PermissionCheckMode = 'all' | 'any'

export interface CheckPermissionsOptions {
  mode?: PermissionCheckMode
}

/**
 * Maximum number of checks sent in one rbac_check_permissions call. The SQL
 * function rejects larger arrays, so bigger batches are split client-side.
 */
export const MAX_PERMISSION_CHECKS_PER_RPC = 200

/**
 * How long a resolved permission stays cached. Org switches, role changes and
 * sign-out clear the cache explicitly (invalidatePermissionCache); the TTL only
 * bounds staleness for changes made outside this tab.
 */
const PERMISSION_CACHE_TTL_MS = 30_000

interface AtomicCheck {
  permission: Permission
  scope: PermissionScope
  /** Set to check another user; omitted to check the signed-in user. */
  userId?: string
}

interface CacheEntry {
  promise: Promise<boolean>
  expiresAt: number
}

interface PendingCheck {
  check: AtomicCheck
  promise: Promise<boolean>
  resolve: (allowed: boolean) => void
}

const permissionCache = new Map<string, CacheEntry>()
let cacheOwnerId: string | null = null
let pendingChecks = new Map<string, PendingCheck>()
let flushScheduled = false

function atomicCheckKey(check: AtomicCheck) {
  return [
    check.userId ? `user:${check.userId}` : 'self',
    check.permission,
    check.scope.orgId ?? '',
    check.scope.appId ?? '',
    check.scope.channelId ?? '',
  ].join('|')
}

/**
 * Drop every cached permission result. Call it when the active org, the
 * caller's role or role bindings change, and on sign-out.
 */
export function invalidatePermissionCache() {
  permissionCache.clear()
}

function syncCacheOwner(ownerId: string) {
  if (cacheOwnerId !== ownerId) {
    permissionCache.clear()
    cacheOwnerId = ownerId
  }
}

/**
 * Single-check fallback, used only when the batch RPC fails (for example while
 * the console is deployed ahead of the API that serves rbac_check_permissions).
 */
async function runSinglePermissionCheck({ permission, scope, userId }: AtomicCheck): Promise<boolean | null> {
  const capgo = useConsole()
  try {
    const { data, error } = userId
      // p_app_id / p_channel_id are nullable in SQL for org-scoped checks, but the
      // generated types mark them required; pass null explicitly for an org-only check.
      ? await capgo.rpc('rbac_check_permission_direct', {
          p_permission_key: permission,
          p_user_id: userId,
          p_org_id: scope.orgId,
          p_app_id: scope.appId ?? null,
          p_channel_id: scope.channelId ?? null,
        } as unknown as Database['public']['Functions']['rbac_check_permission_direct']['Args'])
      : await capgo.rpc('rbac_check_permission', {
          p_permission_key: permission,
          p_org_id: scope.orgId ?? undefined,
          p_app_id: scope.appId ?? undefined,
          p_channel_id: scope.channelId ?? undefined,
        })
    if (error) {
      console.error('[checkPermissions] single RPC error:', error)
      return null
    }
    return data === true
  }
  catch (err) {
    console.error('[checkPermissions] single RPC exception:', err)
    return null
  }
}

/** Resolves one entry per check: true / false, or null when the check errored. */
async function runPermissionChecks(checks: PendingCheck[]): Promise<Array<boolean | null>> {
  const capgo = useConsole()
  try {
    const { data, error } = await capgo.rpc('rbac_check_permissions', {
      p_checks: checks.map(({ check }, idx) => ({
        key: String(idx),
        permission_key: check.permission,
        org_id: check.scope.orgId ?? null,
        app_id: check.scope.appId ?? null,
        channel_id: check.scope.channelId ?? null,
        ...(check.userId ? { user_id: check.userId } : {}),
      })),
    })
    if (error)
      throw error

    const allowedByIdx = new Map<number, boolean>()
    for (const row of (data ?? []) as Array<{ idx: number, allowed: boolean | null }>)
      allowedByIdx.set(Number(row.idx), row.allowed === true)
    return checks.map((_check, idx) => allowedByIdx.get(idx) ?? false)
  }
  catch (err) {
    console.error('[checkPermissions] batch RPC error, falling back to single checks:', err)
    return Promise.all(checks.map(({ check }) => runSinglePermissionCheck(check)))
  }
}

async function flushPendingChecks() {
  flushScheduled = false
  const batch = [...pendingChecks.entries()]
  pendingChecks = new Map()

  for (let start = 0; start < batch.length; start += MAX_PERMISSION_CHECKS_PER_RPC) {
    const chunk = batch.slice(start, start + MAX_PERMISSION_CHECKS_PER_RPC)
    try {
      const results = await runPermissionChecks(chunk.map(([, pending]) => pending))
      chunk.forEach(([key, pending], idx) => {
        const allowed = results[idx]
        // Errors deny, as in the single-check path, and are not cached.
        if (allowed === null)
          permissionCache.delete(key)
        pending.resolve(allowed === true)
      })
    }
    catch (err) {
      console.error('[checkPermissions] unexpected error:', err)
      // Errors deny, as in the single-check path, and are not cached.
      for (const [key, pending] of chunk) {
        permissionCache.delete(key)
        pending.resolve(false)
      }
    }
  }
}

/**
 * Queue one check. Every check queued in the same task goes out in a single
 * rbac_check_permissions RPC; repeated checks are served from the cache.
 */
function enqueueCheck(check: AtomicCheck): Promise<boolean> {
  const key = atomicCheckKey(check)
  const now = Date.now()
  const cached = permissionCache.get(key)
  if (cached && cached.expiresAt > now)
    return cached.promise

  // The cache may have been cleared while this check is still queued: reuse the
  // queued request so every caller of the key settles with the same result.
  const queued = pendingChecks.get(key)
  if (queued)
    return queued.promise

  let resolve!: (allowed: boolean) => void
  const promise = new Promise<boolean>((res) => {
    resolve = res
  })
  pendingChecks.set(key, { check, promise, resolve })
  permissionCache.set(key, { promise, expiresAt: now + PERMISSION_CACHE_TTL_MS })
  if (!flushScheduled) {
    flushScheduled = true
    setTimeout(() => {
      void flushPendingChecks()
    }, 0)
  }
  return promise
}

function currentUserId(): string | null {
  const mainStore = useMainStore()
  const userId = mainStore.user?.id ?? null
  if (userId)
    syncCacheOwner(userId)
  return userId
}

export interface PermissionCheckRequest {
  permissions: Permission | Permission[]
  scope: PermissionScope
  mode?: PermissionCheckMode
}

function combine(results: boolean[], mode: PermissionCheckMode) {
  if (results.length === 0)
    return false
  return mode === 'any' ? results.some(Boolean) : results.every(Boolean)
}

/**
 * Evaluate many permission checks for the signed-in user with one RPC
 * (split into chunks of MAX_PERMISSION_CHECKS_PER_RPC). Each request behaves
 * exactly like checkPermissions(request.permissions, request.scope, { mode }).
 *
 * @returns one boolean per request, in request order
 */
export async function checkPermissionsBatch(requests: PermissionCheckRequest[]): Promise<boolean[]> {
  if (requests.length === 0)
    return []
  if (!currentUserId()) {
    console.warn('[checkPermissionsBatch] No user ID found')
    return requests.map(() => false)
  }

  return Promise.all(requests.map(async (request) => {
    const perms = Array.isArray(request.permissions) ? request.permissions : [request.permissions]
    const results = await Promise.all(perms.map(permission => enqueueCheck({ permission, scope: request.scope })))
    return combine(results, request.mode ?? 'all')
  }))
}

/**
 * Main permission check function.
 *
 * Goes through the batched, cached rbac_check_permissions() RPC, which applies
 * rbac_check_permission() to each check (backed by role_bindings).
 *
 * The backend will:
 * 1. Auto-derive parent scopes (orgId from appId, appId from channelId) if needed
 * 2. Check role_bindings → roles → role_permissions → permissions
 *
 * @param permissions - A permission key or a list of permission keys
 * @param scope - Scope identifiers. Parent scopes are auto-derived by the backend.
 * @param options - Configure ALL/ANY behavior (default: ALL)
 * @returns Promise<boolean> - true if the permission check passes, false otherwise
 *
 * @example
 * // Check if user can upload bundles to an app
 * if (await checkPermissions('app.upload_bundle', { appId: 'com.example.app' })) {
 *   // Show upload button
 * }
 *
 * @example
 * // Check if user can invite members to org
 * if (await checkPermissions('org.invite_user', { orgId })) {
 *   // Show invite button
 * }
 *
 * @example
 * // Check channel permission (backend will auto-derive appId and orgId)
 * if (await checkPermissions('channel.promote_bundle', { channelId: 123 })) {
 *   // Allow bundle promotion
 * }
 *
 * @example
 * // Check multiple permissions (ALL)
 * if (await checkPermissions(['app.update_settings', 'app.delete'], { appId })) {
 *   // Show dangerous actions
 * }
 *
 * @example
 * // Check multiple permissions (ANY)
 * if (await checkPermissions(['org.read_billing', 'org.read_invoices'], { orgId }, { mode: 'any' })) {
 *   // Show billing read-only UI
 * }
 */
export async function checkPermissions(
  permissions: Permission | Permission[],
  scope: PermissionScope,
  options: CheckPermissionsOptions = {},
): Promise<boolean> {
  const [allowed] = await checkPermissionsBatch([{ permissions, scope, mode: options.mode }])
  return allowed ?? false
}

/**
 * Check whether a SPECIFIC user holds a permission in a scope.
 *
 * Unlike checkPermissions() (which checks the current user), this resolves another
 * member's access. It is used to surface "who can grant you access" when the current
 * user is blocked, so we list the people who actually hold the required permission.
 */
export async function userHasPermission(
  permission: Permission,
  userId: string,
  scope: PermissionScope,
): Promise<boolean> {
  const [allowed] = await userHasPermissionsBatch([{ permissions: permission, userId, scope }])
  return allowed ?? false
}

export interface UserPermissionCheckRequest extends PermissionCheckRequest {
  userId: string
}

/**
 * Batch variant of userHasPermission(): one RPC for every member and permission.
 * A request with several permissions defaults to ANY (the member holds at least one).
 */
export async function userHasPermissionsBatch(requests: UserPermissionCheckRequest[]): Promise<boolean[]> {
  if (requests.length === 0)
    return []
  const callerId = currentUserId()
  return Promise.all(requests.map(async (request) => {
    if (!callerId || !request.userId || !request.scope.orgId)
      return false
    const perms = Array.isArray(request.permissions) ? request.permissions : [request.permissions]
    const results = await Promise.all(perms.map(permission => enqueueCheck({
      permission,
      scope: request.scope,
      userId: request.userId,
    })))
    return combine(results, request.mode ?? 'any')
  }))
}
