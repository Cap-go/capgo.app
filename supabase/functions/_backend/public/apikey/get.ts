import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { honoFactory, quickError, simpleError } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_middleware.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { supabaseAdmin, supabaseWithAuth } from '../../utils/supabase.ts'
import { attachApiKeyGlobalPermissions } from './global_permissions.ts'
import { ensureApiKeyCanManageTargetOrgIds, ensureApiKeyManagementAllowed, filterApiKeysManageableByAuth, getApiKeyBindingOrgIds, getApiKeyManageableOrgIds, isValidApiKeyIdFormat, requireApiKeyManagementAuth, selectManageableApiKeyByIdentifier } from './scope.ts'

type ApiKeyRow = Database['public']['Tables']['apikeys']['Row']
type ApiKeyPublicSelectRow = Pick<ApiKeyRow, 'created_at' | 'expires_at' | 'id' | 'key_hash' | 'name' | 'owner_org_id' | 'rbac_id' | 'shared_secret_expires_at' | 'shared_secret_user_id' | 'updated_at' | 'user_id'>
type ApiKeyPublicRow = Omit<ApiKeyPublicSelectRow, 'key_hash'> & { is_hashed_key: boolean }

const app = honoFactory.createApp()
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const APIKEY_PUBLIC_COLUMNS = 'created_at, expires_at, id, key_hash, name, owner_org_id, rbac_id, shared_secret_expires_at, shared_secret_user_id, updated_at, user_id'

function toApiKeyPublicRow(apikey: ApiKeyPublicSelectRow): ApiKeyPublicRow {
  const { key_hash, ...publicApiKey } = apikey
  return {
    ...publicApiKey,
    is_hashed_key: key_hash !== null,
  }
}

interface ApiKeyBindingSummary {
  id: string
  scope_type: string
  org_id: string | null
  app_id: string | null
  role_name: string
}

// Callers only reach this with keys they may manage. Return their bindings so
// managers without org.update_user_roles (which role_bindings RLS requires) can
// still see and edit the keys, especially shared ones.
async function withGlobalPermissionsAndBindings<T extends { rbac_id: string | null }>(
  c: Context<MiddlewareKeyVariables>,
  apikeys: T[],
) {
  const rbacIds = apikeys.map(key => key.rbac_id).filter((rbacId): rbacId is string => !!rbacId)
  if (rbacIds.length === 0) {
    return attachApiKeyGlobalPermissions(apikeys, []).map(apikey => ({ ...apikey, bindings: [] as ApiKeyBindingSummary[] }))
  }

  let pgClient
  try {
    pgClient = getPgClient(c)
    const [{ rows: permissionRows }, { rows: bindingRows }] = await Promise.all([
      pgClient.query<{ apikey_rbac_id: string, permission_key: string }>(
        `SELECT apikey_rbac_id::text, permission_key
         FROM public.apikey_global_permissions
         WHERE apikey_rbac_id = ANY($1::uuid[])`,
        [rbacIds],
      ),
      pgClient.query<ApiKeyBindingSummary & { principal_id: string }>(
        `SELECT rb.id::text, rb.principal_id::text, rb.scope_type, rb.org_id::text, rb.app_id::text, r.name AS role_name
         FROM public.role_bindings rb
         JOIN public.roles r ON r.id = rb.role_id
         WHERE rb.principal_type = public.rbac_principal_apikey()
           AND rb.principal_id = ANY($1::uuid[])
           AND (rb.expires_at IS NULL OR rb.expires_at > now())`,
        [rbacIds],
      ),
    ])

    const bindingsByRbacId = new Map<string, ApiKeyBindingSummary[]>()
    for (const { principal_id, ...binding } of bindingRows) {
      const existing = bindingsByRbacId.get(principal_id) ?? []
      existing.push(binding)
      bindingsByRbacId.set(principal_id, existing)
    }

    return attachApiKeyGlobalPermissions(apikeys, permissionRows).map(apikey => ({
      ...apikey,
      bindings: apikey.rbac_id ? bindingsByRbacId.get(apikey.rbac_id) ?? [] : [],
    }))
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
}

app.get('/', middlewareAuth(), async (c) => {
  const auth = requireApiKeyManagementAuth(c, 'not_authorized', 'API key management requires authentication')
  const apikey = c.get('apikey') as ApiKeyRow | undefined

  await ensureApiKeyManagementAllowed(c, auth, apikey, 'cannot_list_apikeys')

  // Personal keys of the caller plus shared keys of orgs they can manage.
  // JWT callers are scoped by RLS; API-key callers by the orgs the key manages.
  let listQuery
  if (auth.authType === 'apikey') {
    const manageableOrgIds = [...await getApiKeyManageableOrgIds(c, apikey)]
    const ownershipFilters = apikey?.owner_org_id ? [] : [`and(user_id.eq.${auth.userId},owner_org_id.is.null)`]
    if (manageableOrgIds.length > 0) {
      ownershipFilters.push(`owner_org_id.in.(${manageableOrgIds.join(',')})`)
    }
    const adminQuery = supabaseAdmin(c).from('apikeys').select(APIKEY_PUBLIC_COLUMNS)
    listQuery = apikey?.owner_org_id
      ? adminQuery.in('owner_org_id', manageableOrgIds)
      : adminQuery.or(ownershipFilters.join(','))
  }
  else {
    const userClient = supabaseWithAuth(c, auth)
    const { data: manageableOrgIds, error: scopeError } = await userClient.rpc('org_owned_apikey_manageable_org_ids')
    if (scopeError) {
      throw quickError(500, 'failed_to_list_apikeys', 'Failed to load API key management scope', { supabaseError: scopeError })
    }
    // Keep the query indexed before RLS evaluates request-level policies.
    // RLS still rechecks ownership if grants change after this lookup.
    const ownershipFilters = [`and(user_id.eq.${auth.userId},owner_org_id.is.null)`]
    if (manageableOrgIds?.length) {
      ownershipFilters.push(`owner_org_id.in.(${manageableOrgIds.join(',')})`)
    }
    listQuery = userClient.from('apikeys').select(APIKEY_PUBLIC_COLUMNS).or(ownershipFilters.join(','))
  }

  const ownerOrgFilter = c.req.query('owner_org_id')
  if (ownerOrgFilter !== undefined) {
    if (!UUID_REGEX.test(ownerOrgFilter)) {
      throw simpleError('invalid_owner_org_id', 'owner_org_id must be an organization id')
    }
    listQuery = listQuery.eq('owner_org_id', ownerOrgFilter)
  }
  const sharedFilter = c.req.query('shared')
  if (sharedFilter === 'true') {
    listQuery = listQuery.not('owner_org_id', 'is', null)
  }
  else if (sharedFilter === 'false') {
    listQuery = listQuery.is('owner_org_id', null)
  }

  const { data: apikeys, error } = await listQuery

  if (error) {
    throw quickError(500, 'failed_to_list_apikeys', 'Failed to list API keys', { supabaseError: error })
  }

  const publicApiKeys = ((apikeys ?? []) as ApiKeyPublicSelectRow[]).map(toApiKeyPublicRow)
  const manageableApiKeys = await filterApiKeysManageableByAuth(c, auth, apikey, publicApiKeys)
  return c.json(await withGlobalPermissionsAndBindings(c, manageableApiKeys))
})

app.get('/:id', middlewareAuth(), async (c) => {
  const auth = requireApiKeyManagementAuth(c, 'not_authorized', 'API key management requires authentication')
  const authApikey = c.get('apikey') as ApiKeyRow | undefined

  await ensureApiKeyManagementAllowed(c, auth, authApikey, 'cannot_get_apikey')

  const id = c.req.param('id')
  if (!id) {
    throw simpleError('api_key_id_required', 'API key ID is required')
  }

  // Validate id format to prevent PostgREST filter injection while keeping legacy plain-key lookup working.
  if (!isValidApiKeyIdFormat(id)) {
    throw simpleError('invalid_id_format', 'API key ID must be a numeric ID, UUID key, or legacy key token')
  }

  const { data: fetchedApikey, error } = await selectManageableApiKeyByIdentifier<ApiKeyPublicSelectRow>(c, auth, id, APIKEY_PUBLIC_COLUMNS)
  if (error || !fetchedApikey) {
    throw quickError(404, 'failed_to_get_apikey', 'Failed to get API key', { supabaseError: error })
  }
  await ensureApiKeyCanManageTargetOrgIds(c, auth, authApikey, fetchedApikey.rbac_id ? await getApiKeyBindingOrgIds(c, fetchedApikey.rbac_id) : [], 'cannot_get_apikey')
  const [apikeyWithPermissions] = await withGlobalPermissionsAndBindings(c, [toApiKeyPublicRow(fetchedApikey)])
  return c.json(apikeyWithPermissions)
})

export default app
