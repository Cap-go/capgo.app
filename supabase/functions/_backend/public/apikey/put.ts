import type { Context } from 'hono'
import type { CreateBindingParams } from '../../private/role_bindings.ts'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import type { ClientBindingInput } from './scope.ts'
import { sql } from 'drizzle-orm'
import { createRoleBindingForPrincipal, lockRbacOrgs } from '../../private/role_bindings.ts'
import { getErrorCode, getErrorStatus } from '../../utils/errors.ts'
import { honoFactory, parseBody, quickError, simpleError } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_middleware.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../../utils/pg.ts'
import { schema } from '../../utils/postgres_schema.ts'
import { checkPermission, checkPermissionPg } from '../../utils/rbac.ts'
import { supabaseAdmin, supabaseWithAuth, validateExpirationAgainstOrgPolicies, validateExpirationDate } from '../../utils/supabase.ts'
import { apiKeyBindingsAllowOrgCreate, assertApiKeyCanKeepOrgCreateGrant, parseApiKeyGlobalPermissions, replaceApiKeyGlobalPermissions, validateApiKeyGlobalPermissionsForBindings } from './global_permissions.ts'
import { assertApiKeyManagerCanAssignBindings, assertApiKeyManagerCanRotateTarget, assertCallerHoldsSharedApiKeyPermissions, ensureApiKeyCanManageTargetOrgIds, ensureApiKeyManagementAllowed, getApiKeyBindingOrgIds, isValidApiKeyIdFormat, requireApiKeyManagementAuth, requireJwtMfaForPrivilegedAction, sanitizeClientBindings, selectManageableApiKeyByIdentifier, setApiKeyAuditActor, stampSharedApiKeySecretRecipient, withApiKeyAuditActor } from './scope.ts'

const app = honoFactory.createApp()
type ApiKeyRow = Database['public']['Tables']['apikeys']['Row']
type ApiKeyUpdateData = Partial<Pick<Database['public']['Tables']['apikeys']['Update'], 'name' | 'expires_at'>>
type ApiKeyLookupRow = Pick<ApiKeyRow, 'id' | 'rbac_id' | 'expires_at' | 'key' | 'key_hash' | 'user_id' | 'owner_org_id'>
type ApiKeyPublicSelectRow = Pick<ApiKeyRow, 'created_at' | 'expires_at' | 'id' | 'key_hash' | 'name' | 'owner_org_id' | 'rbac_id' | 'updated_at' | 'user_id'>
type ApiKeyPublicRow = Omit<ApiKeyPublicSelectRow, 'key_hash'> & { is_hashed_key: boolean }
const APIKEY_PUBLIC_COLUMNS = 'created_at, expires_at, id, key_hash, name, owner_org_id, rbac_id, updated_at, user_id'

interface ApiKeyPut {
  id?: string | number
  name?: string
  expires_at?: string | null
  regenerate?: boolean
  bindings?: BindingInput[]
  global_permissions?: unknown
}

function toApiKeyPublicRow(apikey: ApiKeyPublicSelectRow): ApiKeyPublicRow {
  const { key_hash, ...publicApiKey } = apikey
  return {
    ...publicApiKey,
    is_hashed_key: key_hash !== null,
  }
}

type BindingInput = ClientBindingInput

function parseBindingsForUpdate(body: ApiKeyPut, requestId: string): BindingInput[] | undefined {
  if (body.bindings === undefined) {
    return undefined
  }

  if (!Array.isArray(body.bindings)) {
    throw simpleError('invalid_bindings', 'bindings must be an array', { requestId })
  }

  if (body.bindings.length === 0) {
    throw simpleError('bindings_required', 'API key bindings are required', { requestId })
  }

  return sanitizeClientBindings(body.bindings)
}

// Shared keys stay inside their owner org and never hold global permissions.
function assertSharedApiKeyUpdate(
  ownerOrgId: string,
  bindings: BindingInput[] | undefined,
  globalPermissions: string[] | undefined,
  requestId: string,
) {
  if (bindings?.some(binding => binding.org_id !== ownerOrgId)) {
    throw simpleError('shared_apikey_single_org', 'Shared API keys can only have bindings in their owner organization', { requestId })
  }
  if (globalPermissions !== undefined && globalPermissions.length > 0) {
    throw simpleError('shared_apikey_global_permissions', 'Shared API keys cannot have global permissions', { requestId })
  }
}

function toDrizzleApiKeyUpdate(updateData: ApiKeyUpdateData): Partial<typeof schema.apikeys.$inferInsert> {
  const drizzleUpdate: Partial<typeof schema.apikeys.$inferInsert> = {}

  if (updateData.name !== undefined) {
    drizzleUpdate.name = updateData.name
  }
  if (updateData.expires_at !== undefined) {
    drizzleUpdate.expires_at = updateData.expires_at === null ? null : new Date(updateData.expires_at)
  }

  return drizzleUpdate
}

async function replaceApiKeyBindings(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
  apikey: { id: number, rbac_id: string, owner_org_id: string | null },
  currentBindingOrgIds: string[],
  bindings: BindingInput[],
  globalPermissions?: string[],
  updateData?: ApiKeyUpdateData,
) {
  if (auth.authType !== 'jwt' || !auth.userId) {
    throw quickError(403, 'not_authorized', 'Only user sessions can update API key bindings', { requestId: c.get('requestId') })
  }

  const affectedOrgIds = [...new Set([
    ...currentBindingOrgIds,
    ...bindings.map(binding => binding.org_id),
  ])]

  await assertApiKeyManagerCanAssignBindings(c, auth, bindings)

  // Intentionally stricter than POST /apikey: app admins (app.manage_apikeys)
  // may create app-scoped keys but not re-scope existing ones. Relaxing this
  // must re-run the escalation checks of assertCanManageApiKeyBindingsPg.
  for (const orgId of affectedOrgIds) {
    if (!(await checkPermission(c, 'org.update_user_roles', { orgId }))) {
      throw quickError(403, 'forbidden_binding', `Forbidden - Admin rights required for org ${orgId}`, { requestId: c.get('requestId'), orgId })
    }
  }

  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)
    if (globalPermissions !== undefined) {
      validateApiKeyGlobalPermissionsForBindings(globalPermissions, bindings, c.get('requestId'))
    }

    await drizzle.transaction(async (tx) => {
      const txDrizzle = tx as unknown as ReturnType<typeof getDrizzleClient>
      await setApiKeyAuditActor(txDrizzle, auth)
      await lockRbacOrgs(txDrizzle, affectedOrgIds)

      for (const orgId of affectedOrgIds) {
        if (!(await checkPermissionPg(c, 'org.update_user_roles', { orgId }, txDrizzle, auth.userId))) {
          throw quickError(403, 'forbidden_binding', `Forbidden - Admin rights required for org ${orgId}`, { requestId: c.get('requestId'), orgId })
        }
      }
      if (updateData && Object.keys(updateData).length > 0) {
        const result = await tx
          .update(schema.apikeys)
          .set(toDrizzleApiKeyUpdate(updateData))
          .where(sql`${schema.apikeys.id} = ${apikey.id}`)
          .returning({ id: schema.apikeys.id })

        if (result.length === 0) {
          throw quickError(500, 'failed_to_update_apikey', 'Failed to update API key', { requestId: c.get('requestId'), apikeyId: apikey.id })
        }
      }

      await tx
        .delete(schema.role_bindings)
        .where(sql`${schema.role_bindings.principal_type} = public.rbac_principal_apikey() AND ${schema.role_bindings.principal_id} = ${apikey.rbac_id}::uuid`)

      for (const binding of bindings) {
        const bindingParams: CreateBindingParams = {
          principal_type: 'apikey',
          principal_id: apikey.rbac_id,
          role_name: binding.role_name,
          scope_type: binding.scope_type,
          org_id: binding.org_id,
          app_id: binding.app_id,
          channel_id: binding.channel_id,
          reason: binding.reason,
        }

        const result = await createRoleBindingForPrincipal(
          txDrizzle,
          bindingParams,
          auth.userId,
          'jwt',
          auth.userId,
        )

        if (!result.ok) {
          cloudlogErr({
            requestId: c.get('requestId'),
            message: 'apikey_binding_update_failed',
            apikeyId: apikey.id,
            binding,
            error: result.error,
          })
          throw quickError(result.status, 'binding_failed', result.error, { requestId: c.get('requestId'), apikeyId: apikey.id })
        }
      }

      if (globalPermissions !== undefined) {
        await replaceApiKeyGlobalPermissions(tx, apikey.rbac_id, globalPermissions, auth.userId)
      }
      else if (!apiKeyBindingsAllowOrgCreate(bindings)) {
        // Legacy clients can omit global_permissions; keep stored grants aligned with the new bindings.
        await replaceApiKeyGlobalPermissions(tx, apikey.rbac_id, [], auth.userId)
      }

      if (apikey.owner_org_id) {
        await assertCallerHoldsSharedApiKeyPermissions(txDrizzle, auth, apikey.rbac_id)
      }
    })

    cloudlog({
      requestId: c.get('requestId'),
      message: 'apikey_bindings_replaced',
      apikeyId: apikey.id,
      bindingsCount: bindings.length,
    })
  }
  catch (error: unknown) {
    if (getErrorStatus(error)) {
      throw error
    }
    if (getErrorCode(error) === '23505') {
      throw quickError(409, 'duplicate_binding', 'API key already has a role in this family at this scope', { requestId: c.get('requestId'), apikeyId: apikey.id }, error)
    }
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'apikey_bindings_replace_unexpected_error',
      apikeyId: apikey.id,
      error,
    })
    throw quickError(500, 'binding_update_failed', 'Failed to update role bindings for the API key', { requestId: c.get('requestId'), apikeyId: apikey.id }, error)
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
}

async function replaceApiKeyGlobalPermissionsForExistingBindings(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
  apikey: { id: number, rbac_id: string },
  currentBindingOrgIds: string[],
  globalPermissions: string[],
  updateData?: ApiKeyUpdateData,
) {
  if (auth.authType !== 'jwt' || !auth.userId) {
    throw quickError(403, 'not_authorized', 'Only user sessions can update API key permissions', { requestId: c.get('requestId') })
  }

  for (const orgId of currentBindingOrgIds) {
    if (!(await checkPermission(c, 'org.update_user_roles', { orgId }))) {
      throw quickError(403, 'forbidden_binding', `Forbidden - Admin rights required for org ${orgId}`, { requestId: c.get('requestId'), orgId })
    }
  }

  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)

    await drizzle.transaction(async (tx) => {
      const txDrizzle = tx as unknown as ReturnType<typeof getDrizzleClient>
      await setApiKeyAuditActor(txDrizzle, auth)
      await lockRbacOrgs(txDrizzle, currentBindingOrgIds)

      for (const orgId of currentBindingOrgIds) {
        if (!(await checkPermissionPg(c, 'org.update_user_roles', { orgId }, txDrizzle, auth.userId))) {
          throw quickError(403, 'forbidden_binding', `Forbidden - Admin rights required for org ${orgId}`, { requestId: c.get('requestId'), orgId })
        }
      }
      if (updateData && Object.keys(updateData).length > 0) {
        const result = await tx
          .update(schema.apikeys)
          .set(toDrizzleApiKeyUpdate(updateData))
          .where(sql`${schema.apikeys.id} = ${apikey.id}`)
          .returning({ id: schema.apikeys.id })

        if (result.length === 0) {
          throw quickError(500, 'failed_to_update_apikey', 'Failed to update API key', { requestId: c.get('requestId'), apikeyId: apikey.id })
        }
      }

      await assertApiKeyCanKeepOrgCreateGrant(tx, apikey.rbac_id, globalPermissions, c.get('requestId'))
      await replaceApiKeyGlobalPermissions(tx, apikey.rbac_id, globalPermissions, auth.userId)
    })

    cloudlog({
      requestId: c.get('requestId'),
      message: 'apikey_global_permissions_replaced',
      apikeyId: apikey.id,
      permissionsCount: globalPermissions.length,
    })
  }
  catch (error: unknown) {
    if (getErrorStatus(error)) {
      throw error
    }
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'apikey_global_permissions_replace_unexpected_error',
      apikeyId: apikey.id,
      error,
    })
    throw quickError(500, 'global_permission_update_failed', 'Failed to update API key permissions', { requestId: c.get('requestId'), apikeyId: apikey.id }, error)
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
}

async function handlePut(c: Context<MiddlewareKeyVariables>, idParam?: string) {
  const requestId = c.get('requestId')
  const auth = requireApiKeyManagementAuth(c, 'not_authorized', 'API key management requires authentication', { requestId })
  const authApikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row'] | undefined

  if (auth.authType === 'jwt') {
    await requireJwtMfaForPrivilegedAction(c, auth)
  }

  await ensureApiKeyManagementAllowed(c, auth, authApikey, 'cannot_update_apikey', { requestId })

  const body = await parseBody<ApiKeyPut>(c)
  const { id, name, expires_at, regenerate } = body
  const bindings = parseBindingsForUpdate(body, requestId)
  const hasBindingUpdates = bindings !== undefined
  const globalPermissions = parseApiKeyGlobalPermissions(body.global_permissions, requestId)
  const hasGlobalPermissionUpdates = globalPermissions !== undefined

  const resolvedId = typeof idParam === 'string' && idParam.length > 0 ? idParam : (id !== undefined ? String(id) : '')
  if (!resolvedId) {
    throw simpleError('api_key_id_required', 'API key ID is required', { requestId })
  }

  // Validate id format to prevent PostgREST filter injection
  if (!isValidApiKeyIdFormat(resolvedId)) {
    throw simpleError('invalid_id_format', 'API key ID must be a valid UUID or number', { requestId })
  }

  // Validate expiration date format (throws if invalid)
  validateExpirationDate(expires_at)

  // Build update data from only explicitly-provided fields.
  // Note: empty arrays are meaningful and should clear the list.
  const updateData: ApiKeyUpdateData = {}
  if (name !== undefined) {
    updateData.name = name
  }
  // Handle expires_at: null means remove expiration, undefined means don't update.
  if (expires_at !== undefined) {
    updateData.expires_at = expires_at
  }

  const hasUpdates = Object.keys(updateData).length > 0

  if (name !== undefined && typeof name !== 'string') {
    throw simpleError('name_must_be_a_string', 'Name must be a string', { requestId })
  }

  if (regenerate !== undefined && typeof regenerate !== 'boolean') {
    throw simpleError('regenerate_must_be_boolean', 'regenerate must be a boolean', { requestId })
  }

  if (!hasUpdates && !regenerate && !hasBindingUpdates && !hasGlobalPermissionUpdates) {
    throw simpleError('no_valid_fields_provided_for_update', 'No valid fields provided for update. Provide name, expires_at, bindings, global_permissions, or regenerate.', { requestId })
  }

  const supabase = supabaseWithAuth(c, auth)
  const dataSupabase = auth.authType === 'apikey' ? supabaseAdmin(c) : supabase

  // Check if the API key to update exists. JWT callers rely on RLS.
  const { data: existingApikey, error: fetchError } = await selectManageableApiKeyByIdentifier<ApiKeyLookupRow>(c, auth, resolvedId, 'id, rbac_id, expires_at, key, key_hash, user_id, owner_org_id')

  if (fetchError) {
    // RLS might return an error or just no data if not found/accessible
    throw quickError(fetchError.code === 'PGRST116' ? 404 : 500, 'api_key_not_found_or_access_denied', 'API key not found or access denied', { requestId, supabaseError: fetchError })
  }
  if (!existingApikey) {
    throw quickError(404, 'api_key_not_found_or_access_denied', 'API key not found or access denied', { requestId })
  }
  if (!existingApikey.rbac_id) {
    throw quickError(409, 'apikey_missing_rbac_bindings', 'API key is missing RBAC bindings and cannot be updated', { requestId, apikeyId: existingApikey.id })
  }
  if (auth.authType === 'apikey' && authApikey?.id === existingApikey.id) {
    throw quickError(401, 'cannot_update_apikey', 'API keys cannot update themselves', { requestId, apikeyId: authApikey.id })
  }
  if (auth.authType === 'apikey' && (hasBindingUpdates || hasGlobalPermissionUpdates)) {
    throw quickError(401, 'cannot_update_apikey', 'API keys cannot update API key permissions', { requestId, apikeyId: authApikey?.id })
  }

  // Validate expiration against org policies (only if expiration or scopes are changing)
  const currentBindingOrgIds = await getApiKeyBindingOrgIds(c, existingApikey.rbac_id)
  await ensureApiKeyCanManageTargetOrgIds(c, auth, authApikey, currentBindingOrgIds, 'cannot_update_apikey', { requestId })
  if (existingApikey.owner_org_id) {
    assertSharedApiKeyUpdate(existingApikey.owner_org_id, bindings, globalPermissions, requestId)
  }
  if (regenerate) {
    if (existingApikey.owner_org_id && auth.authType !== 'jwt') {
      throw quickError(403, 'cannot_update_apikey', 'Only user sessions can regenerate shared API keys', { requestId })
    }
    await assertApiKeyManagerCanRotateTarget(c, auth, existingApikey.rbac_id)
  }

  if (expires_at !== undefined || hasBindingUpdates) {
    const orgsToValidate = hasBindingUpdates
      ? [...new Set(bindings.map(binding => binding.org_id))]
      : currentBindingOrgIds
    const expiresAtForValidation = expires_at === undefined ? existingApikey.expires_at : expires_at
    await validateExpirationAgainstOrgPolicies(orgsToValidate, expiresAtForValidation, dataSupabase)
  }

  const isHashedKey = existingApikey.key_hash !== null

  const writeSupabase = supabaseAdmin(c)

  let updatedApikey: ApiKeyPublicRow | null = null
  if (hasBindingUpdates) {
    await replaceApiKeyBindings(c, auth, {
      id: existingApikey.id,
      rbac_id: existingApikey.rbac_id,
      owner_org_id: existingApikey.owner_org_id,
    }, currentBindingOrgIds, bindings, globalPermissions, hasUpdates ? updateData : undefined)

    const { data: updatedData, error: fetchUpdatedError } = await supabase
      .from('apikeys')
      .select(APIKEY_PUBLIC_COLUMNS)
      .eq('id', existingApikey.id)
      .single()

    if (fetchUpdatedError || !updatedData) {
      throw quickError(500, 'failed_to_update_apikey', 'Failed to load updated API key', { requestId, supabaseError: fetchUpdatedError })
    }
    updatedApikey = toApiKeyPublicRow(updatedData as ApiKeyPublicSelectRow)
  }
  else if (hasGlobalPermissionUpdates) {
    await replaceApiKeyGlobalPermissionsForExistingBindings(c, auth, {
      id: existingApikey.id,
      rbac_id: existingApikey.rbac_id,
    }, currentBindingOrgIds, globalPermissions, hasUpdates ? updateData : undefined)

    const { data: updatedData, error: fetchUpdatedError } = await dataSupabase
      .from('apikeys')
      .select(APIKEY_PUBLIC_COLUMNS)
      .eq('id', existingApikey.id)
      .single()

    if (fetchUpdatedError || !updatedData) {
      throw quickError(500, 'failed_to_update_apikey', 'Failed to load updated API key', { requestId, supabaseError: fetchUpdatedError })
    }
    updatedApikey = toApiKeyPublicRow(updatedData as ApiKeyPublicSelectRow)
  }
  else if (hasUpdates) {
    const updatedRows = await withApiKeyAuditActor(c, auth, async (tx) => {
      if (existingApikey.owner_org_id) {
        await lockRbacOrgs(tx, [existingApikey.owner_org_id])
        if (!(await checkPermissionPg(c, 'org.manage_apikeys', { orgId: existingApikey.owner_org_id }, tx, auth.userId, auth.apikey?.key ?? c.get('capgkey') ?? null))) {
          throw quickError(403, 'cannot_update_apikey', 'API key management permission is required', { requestId })
        }
      }
      return tx
        .update(schema.apikeys)
        .set(toDrizzleApiKeyUpdate(updateData))
        .where(sql`${schema.apikeys.id} = ${existingApikey.id}`)
        .returning({ id: schema.apikeys.id })
    })
    if (updatedRows.length === 0) {
      throw quickError(500, 'failed_to_update_apikey', 'Failed to update API key', { requestId, apikeyId: existingApikey.id })
    }

    const { data: updatedData, error: fetchUpdatedError } = await writeSupabase
      .from('apikeys')
      .select(APIKEY_PUBLIC_COLUMNS)
      .eq('id', existingApikey.id)
      .single()

    if (fetchUpdatedError || !updatedData) {
      throw quickError(500, 'failed_to_update_apikey', 'Failed to load updated API key', { requestId, supabaseError: fetchUpdatedError })
    }
    updatedApikey = toApiKeyPublicRow(updatedData as ApiKeyPublicSelectRow)
  }

  if (regenerate) {
    if (isHashedKey) {
      const regeneratedApikey = await withApiKeyAuditActor(c, auth, async (tx) => {
        let attributedUserId = existingApikey.user_id
        if (existingApikey.owner_org_id) {
          // Use the same org -> principal lock order as binding mutations.
          // Recheck after locking: bindings and caller membership may have
          // changed since the initial RLS lookup.
          await lockRbacOrgs(tx, [existingApikey.owner_org_id])
          await tx.execute(sql`SELECT public.lock_rbac_apikey_principal(${existingApikey.rbac_id}::uuid)`)
          const target = await tx.execute<ApiKeyLookupRow>(sql`
            SELECT id, rbac_id, expires_at, key, key_hash, user_id, owner_org_id
            FROM public.apikeys
            WHERE id = ${existingApikey.id}::bigint
              AND owner_org_id = ${existingApikey.owner_org_id}::uuid
            FOR UPDATE`)
          const lockedApikey = target.rows[0]
          if (!lockedApikey?.rbac_id) {
            throw quickError(404, 'api_key_not_found_or_access_denied', 'API key not found or access denied', { requestId })
          }
          if (!(await checkPermissionPg(c, 'org.manage_apikeys', { orgId: existingApikey.owner_org_id }, tx, auth.userId, auth.apikey?.key ?? c.get('capgkey') ?? null))) {
            throw quickError(403, 'cannot_update_apikey', 'API key management permission is required', { requestId })
          }
          await assertCallerHoldsSharedApiKeyPermissions(tx, auth, lockedApikey.rbac_id)
          attributedUserId = lockedApikey.user_id
        }
        const result = await tx.execute<ApiKeyRow>(sql`SELECT * FROM public.regenerate_hashed_apikey_for_user(${existingApikey.id}::bigint, ${attributedUserId}::uuid)`)
        if (existingApikey.owner_org_id && result.rows[0]) {
          await stampSharedApiKeySecretRecipient(tx, auth, existingApikey.rbac_id!)
        }
        return result.rows[0]
      })
      if (!regeneratedApikey) {
        throw quickError(500, 'failed_to_update_apikey', 'Failed to regenerate API key', { requestId, apikeyId: existingApikey.id })
      }
      return c.json({ ...regeneratedApikey, id: Number(regeneratedApikey.id), is_hashed_key: true })
    }

    const { data: updatedData, error: updateError } = await writeSupabase
      .from('apikeys')
      // Any non-null value different from the current key will trigger the
      // `apikeys_force_server_key()` database trigger to regenerate the key.
      // We use the literal string 'regenerate' here purely as a placeholder;
      // the final key returned below is the value generated by the trigger.
      .update({ key: 'regenerate' })
      .eq('id', existingApikey.id)
      .select()
      .single()

    if (updateError || !updatedData) {
      throw quickError(500, 'failed_to_update_apikey', 'Failed to regenerate API key', { requestId, supabaseError: updateError })
    }
    return c.json({ ...updatedData, is_hashed_key: updatedData.key_hash !== null })
  }

  if (!updatedApikey) {
    throw quickError(500, 'failed_to_update_apikey', 'Failed to load updated API key', { requestId, apikeyId: existingApikey.id })
  }

  if (globalPermissions !== undefined) {
    return c.json({
      ...updatedApikey,
      global_permissions: globalPermissions,
    })
  }

  return c.json(updatedApikey)
}

app.put('/', middlewareAuth(), async c => handlePut(c))
app.put('/:id', middlewareAuth(), async c => handlePut(c, c.req.param('id')))

export default app
