/**
 * RBAC Permission System - Frontend
 *
 * This module provides the frontend interface to the backend RBAC permission system.
 * It calls the SQL function rbac_check_permission(), backed by role_bindings.
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

import type { Database } from '~/types/supabase.types'
import { useSupabase } from '~/services/supabase'
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
 * Low-level single-permission check (RPC wrapper).
 * Prefer checkPermissions() for new usage.
 */
export async function hasPermission(
  permission: Permission,
  scope: PermissionScope,
): Promise<boolean> {
  const mainStore = useMainStore()
  const supabase = useSupabase()

  // Get current user ID
  const userId = mainStore.user?.id
  if (!userId) {
    console.warn('[hasPermission] No user ID found')
    return false
  }

  try {
    const { data, error } = await supabase.rpc('rbac_check_permission', {
      p_permission_key: permission,
      p_org_id: scope.orgId ?? undefined,
      p_app_id: scope.appId ?? undefined,
      p_channel_id: scope.channelId ?? undefined,
    })

    if (error) {
      console.error('[hasPermission] RPC error:', error)
      return false
    }

    return data === true
  }
  catch (err) {
    console.error('[hasPermission] Exception:', err)
    return false
  }
}

/**
 * Main permission check function.
 *
 * Calls the SQL function rbac_check_permission(), backed by role_bindings.
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
  const perms = Array.isArray(permissions) ? permissions : [permissions]
  if (perms.length === 0)
    return false

  const mode = options.mode ?? 'all'
  if (mode === 'any') {
    for (const perm of perms) {
      if (await hasPermission(perm, scope))
        return true
    }
    return false
  }

  for (const perm of perms) {
    if (!(await hasPermission(perm, scope)))
      return false
  }
  return true
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
  const supabase = useSupabase()

  if (!userId || !scope.orgId)
    return false

  try {
    // p_app_id / p_channel_id are nullable in SQL for org-scoped checks, but the
    // generated types mark them required; pass null explicitly for an org-only check.
    const { data, error } = await supabase.rpc('rbac_check_permission_direct', {
      p_permission_key: permission,
      p_user_id: userId,
      p_org_id: scope.orgId,
      p_app_id: scope.appId ?? null,
      p_channel_id: scope.channelId ?? null,
    } as unknown as Database['public']['Functions']['rbac_check_permission_direct']['Args'])

    if (error) {
      console.error('[userHasPermission] RPC error:', error)
      return false
    }

    return data === true
  }
  catch (err) {
    console.error('[userHasPermission] Exception:', err)
    return false
  }
}
