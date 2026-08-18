import type { CreateBindingParams } from '../../private/role_bindings.ts'
import type { Database } from '../../utils/supabase.types.ts'
import type { ClientBindingInput } from './scope.ts'
import { sql } from 'drizzle-orm'
import { createRoleBindingForPrincipal, lockRbacOrgs } from '../../private/role_bindings.ts'
import { honoFactory, parseBody, quickError, simpleError } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_middleware.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../../utils/pg.ts'
import { checkPermission, checkPermissionPg } from '../../utils/rbac.ts'
import { supabaseWithAuth, validateExpirationAgainstOrgPolicies, validateExpirationDate } from '../../utils/supabase.ts'
import { parseApiKeyGlobalPermissions, replaceApiKeyGlobalPermissions, validateApiKeyGlobalPermissionsForBindings } from './global_permissions.ts'
import { assertApiKeyManagerCanAssignBindings, ensureApiKeyManagementAllowed, requireApiKeyManagementAuth, sanitizeClientBindings } from './scope.ts'
import { getErrorStatus } from '../../utils/errors.ts'

type BindingInput = ClientBindingInput
type ApiKeyRow = Database['public']['Tables']['apikeys']['Row']

type DrizzleExecutor = Pick<ReturnType<typeof getDrizzleClient>, 'execute'>

interface CreateApiKeyRecordParams {
  userId: string
  name: string
  expiresAt: string | null
  isHashed: boolean
}

const app = honoFactory.createApp()

async function createApiKeyRecord(
  db: DrizzleExecutor,
  params: CreateApiKeyRecordParams,
): Promise<ApiKeyRow> {
  const plainKey = crypto.randomUUID()
  const result = await db.execute<ApiKeyRow>(sql`INSERT INTO public.apikeys (
      user_id,
      key,
      key_hash,
      name,
      expires_at
    )
    VALUES (
      ${params.userId}::uuid,
      CASE WHEN ${params.isHashed}::boolean THEN NULL ELSE ${plainKey}::text END,
      CASE WHEN ${params.isHashed}::boolean THEN encode(extensions.digest(${plainKey}::text, 'sha256'), 'hex') ELSE NULL END,
      ${params.name}::text,
      ${params.expiresAt}::timestamptz
    )
    RETURNING *`)

  const apiKey = result.rows[0] as ApiKeyRow | undefined
  if (!apiKey) {
    throw new Error('API key insert returned no rows')
  }

  apiKey.id = Number(apiKey.id)
  apiKey.key = plainKey
  return apiKey
}

async function assertCanManageApiKeysForOrgs(
  c: Parameters<typeof checkPermission>[0],
  orgIds: string[],
): Promise<void> {
  for (const orgId of orgIds) {
    if (!(await checkPermission(c, 'org.manage_apikeys', { orgId }))) {
      throw quickError(403, 'forbidden_binding', `Forbidden - API key management rights required for org ${orgId}`)
    }
  }
}

app.post('/', middlewareAuth(), async (c) => {
  const auth = requireApiKeyManagementAuth(c, 'not_authorized', 'API key management requires authentication')
  if (auth.authType !== 'jwt' || !auth.userId) {
    if (auth.authType === 'apikey') {
      throw simpleError('cannot_create_apikey', 'API keys cannot create other API keys')
    }
    throw simpleError('not_authorized', 'Only user sessions can create API keys')
  }

  const authApikey = c.get('apikey') as ApiKeyRow | undefined
  await ensureApiKeyManagementAllowed(c, auth, authApikey, 'cannot_create_apikey')

  const body = await parseBody<any>(c)

  const name = body.name ?? ''
  const expiresAt = body.expires_at ?? null
  const isHashed = body.hashed === true

  // Validate and parse bindings array
  if (body.bindings !== undefined && !Array.isArray(body.bindings)) {
    throw simpleError('invalid_bindings', 'bindings must be an array')
  }
  const bindings: BindingInput[] = Array.isArray(body.bindings) ? sanitizeClientBindings(body.bindings) : []

  const hasBindings = bindings.length > 0

  if (!name) {
    throw simpleError('name_is_required', 'Name is required')
  }
  if (!hasBindings) {
    throw simpleError('bindings_required', 'API key bindings are required')
  }

  // Validate expiration date format (throws if invalid)
  validateExpirationDate(expiresAt)

  // Preserve caller RLS context; the route guard above keeps management JWT-only.
  const supabase = supabaseWithAuth(c, auth)

  const resolvedBindings = bindings
  const globalPermissions = parseApiKeyGlobalPermissions(body.global_permissions, c.get('requestId')) ?? []
  validateApiKeyGlobalPermissionsForBindings(globalPermissions, resolvedBindings, c.get('requestId'))

  // Validate expiration against org policies (throws if invalid)
  const allOrgIds = [...new Set(resolvedBindings.map(binding => binding.org_id))]
  await validateExpirationAgainstOrgPolicies(allOrgIds, expiresAt, supabase)
  await assertApiKeyManagerCanAssignBindings(c, auth, resolvedBindings)

  let apikeyData: ApiKeyRow | null = null

  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    // Check RBAC permission for each unique org in the bindings before creating anything.
    await assertCanManageApiKeysForOrgs(c, allOrgIds)

    pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)
    const createdBindings: unknown[] = []
    const callerPrincipalId = auth.userId

    await drizzle.transaction(async (tx) => {
      const txDrizzle = tx as unknown as ReturnType<typeof getDrizzleClient>
      await lockRbacOrgs(txDrizzle, allOrgIds)

      const apikeyString = auth.apikey?.key ?? c.get('capgkey') ?? null
      for (const bindingOrgId of allOrgIds) {
        if (!(await checkPermissionPg(c, 'org.manage_apikeys', { orgId: bindingOrgId }, txDrizzle, auth.userId, apikeyString))) {
          throw quickError(403, 'forbidden_binding', `Forbidden - API key management rights required for org ${bindingOrgId}`)
        }
      }
      await assertApiKeyManagerCanAssignBindings(c, auth, resolvedBindings, txDrizzle)

      apikeyData = await createApiKeyRecord(tx, {
        userId: auth.userId,
        name,
        expiresAt,
        isHashed,
      })

      if (!apikeyData.rbac_id) {
        throw new Error('Created API key is missing rbac_id')
      }

      for (const binding of resolvedBindings) {
        const bindingParams: CreateBindingParams = {
          principal_type: 'apikey',
          principal_id: apikeyData.rbac_id,
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
          callerPrincipalId,
        )

        if (!result.ok) {
          cloudlogErr({
            requestId: c.get('requestId'),
            message: 'apikey_binding_failed',
            binding,
            error: result.error,
          })
          throw quickError(result.status, 'binding_failed', result.error)
        }

        createdBindings.push(result.data)
      }

      await replaceApiKeyGlobalPermissions(tx, apikeyData.rbac_id, globalPermissions, auth.userId)
    })

    cloudlog({
      requestId: c.get('requestId'),
      message: 'apikey_bindings_created',
      apikeyId: (apikeyData as ApiKeyRow | null)?.id,
      bindingsCount: createdBindings.length,
    })
  }
  catch (error: unknown) {
    if (getErrorStatus(error)) {
      throw error
    }
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'apikey_bindings_unexpected_error',
      error,
    })
    throw simpleError('binding_creation_failed', 'Failed to create role bindings for the API key')
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }

  if (!apikeyData) {
    throw simpleError('binding_creation_failed', 'Failed to create role bindings for the API key')
  }

  return c.json({
    ...(apikeyData as ApiKeyRow as Record<string, unknown>),
    global_permissions: globalPermissions,
  })
})

export default app
