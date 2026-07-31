import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { getDrizzleClient } from '../../utils/pg.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { quickError } from '../../utils/hono.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
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

export function isValidApiKeyIdFormat(id: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const numericRegex = /^\d+$/
  const legacyKeyRegex = /^[A-Za-z0-9._:-]{8,256}$/
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

async function getApiKeyManageableOrgIds(
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

export async function selectOwnedApiKeyByIdentifier<T = ApiKeyRow>(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
  id: string,
  columns = '*',
) {
  const query = (auth.authType === 'apikey' ? supabaseAdmin(c) : supabaseWithAuth(c, auth))
    .from('apikeys')
    .select(columns)
    .eq('user_id', auth.userId)

  const filteredQuery = isNumericApiKeyId(id)
    ? query.eq('id', Number(id))
    : query.eq('key', id)

  const { data, error } = await filteredQuery.single()
  return { data: data as T | null, error }
}

export async function deleteOwnedApiKeyByIdentifier(c: Context<MiddlewareKeyVariables>, auth: AuthInfo, id: string) {
  const query = (auth.authType === 'apikey' ? supabaseAdmin(c) : supabaseWithAuth(c, auth))
    .from('apikeys')
    .delete()
    .eq('user_id', auth.userId)

  const filteredQuery = isNumericApiKeyId(id)
    ? query.eq('id', Number(id))
    : query.eq('key', id)

  return filteredQuery
}
