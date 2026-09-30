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
type ApiKeyPublicSelectRow = Pick<ApiKeyRow, 'created_at' | 'expires_at' | 'id' | 'key_hash' | 'name' | 'owner_org_id' | 'rbac_id' | 'updated_at' | 'user_id'>
type ApiKeyPublicRow = Omit<ApiKeyPublicSelectRow, 'key_hash'> & { is_hashed_key: boolean }

const app = honoFactory.createApp()
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const APIKEY_PUBLIC_COLUMNS = 'created_at, expires_at, id, key_hash, name, owner_org_id, rbac_id, updated_at, user_id'

function toApiKeyPublicRow(apikey: ApiKeyPublicSelectRow): ApiKeyPublicRow {
  const { key_hash, ...publicApiKey } = apikey
  return {
    ...publicApiKey,
    is_hashed_key: key_hash !== null,
  }
}

async function withGlobalPermissions<T extends { rbac_id: string | null }>(
  c: Context<MiddlewareKeyVariables>,
  apikeys: T[],
) {
  const rbacIds = apikeys.map(key => key.rbac_id).filter((rbacId): rbacId is string => !!rbacId)
  if (rbacIds.length === 0) {
    return attachApiKeyGlobalPermissions(apikeys, [])
  }

  let pgClient
  try {
    pgClient = getPgClient(c)
    const { rows } = await pgClient.query<{ apikey_rbac_id: string, permission_key: string }>(
      `SELECT apikey_rbac_id::text, permission_key
       FROM public.apikey_global_permissions
       WHERE apikey_rbac_id = ANY($1::uuid[])`,
      [rbacIds],
    )
    return attachApiKeyGlobalPermissions(apikeys, rows)
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
    const ownershipFilters = [`and(user_id.eq.${auth.userId},owner_org_id.is.null)`]
    if (manageableOrgIds.length > 0) {
      ownershipFilters.push(`owner_org_id.in.(${manageableOrgIds.join(',')})`)
    }
    listQuery = supabaseAdmin(c).from('apikeys').select(APIKEY_PUBLIC_COLUMNS).or(ownershipFilters.join(','))
  }
  else {
    listQuery = supabaseWithAuth(c, auth).from('apikeys').select(APIKEY_PUBLIC_COLUMNS)
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
  return c.json(await withGlobalPermissions(c, manageableApiKeys))
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
  const [apikeyWithPermissions] = await withGlobalPermissions(c, [toApiKeyPublicRow(fetchedApikey)])
  return c.json(apikeyWithPermissions)
})

export default app
