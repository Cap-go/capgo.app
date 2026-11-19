import type { CreateBindingParams } from '../../private/role_bindings.ts'
import type { Database } from '../../utils/supabase.types.ts'
import type { ClientBindingInput } from './scope.ts'
import { sql } from 'drizzle-orm'
import { createRoleBindingBatchCache, createRoleBindingForPrincipal, lockRbacOrgs, prefetchRolesForBindings } from '../../private/role_bindings.ts'
import { getErrorStatus } from '../../utils/errors.ts'
import { honoFactory, parseBody, quickError, simpleError } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_middleware.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../../utils/pg.ts'
import { checkPermissionsBatchPg } from '../../utils/rbac.ts'
import { assertExpirationMatchesOrgPolicies, validateExpirationDate } from '../../utils/supabase.ts'
import { parseApiKeyGlobalPermissions, replaceApiKeyGlobalPermissions, validateApiKeyGlobalPermissionsForBindings } from './global_permissions.ts'
import { assertApiKeyManagerCanAssignBindings, ensureApiKeyManagementAllowed, requireApiKeyManagementAuth, requireJwtMfaForPrivilegedAction, sanitizeClientBindings } from './scope.ts'

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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// org.manage_apikeys allows any binding in the org. Without it, app owners
// (app.manage_apikeys, granted to app_admin) may still issue keys whose
// bindings are limited to their own apps or channels.
async function assertCanManageApiKeyBindingsPg(
  c: Parameters<typeof checkPermissionsBatchPg>[0],
  drizzle: ReturnType<typeof getDrizzleClient>,
  userId: string,
  apikeyString: string | null,
  bindings: BindingInput[],
): Promise<void> {
  // 1) org.manage_apikeys for every distinct org, in one statement.
  const orgIds = [...new Set(bindings.map(binding => binding.org_id))]
  const orgAllowed = await checkPermissionsBatchPg(
    c,
    orgIds.map(orgId => ({ permission: 'org.manage_apikeys' as const, scope: { orgId } })),
    drizzle,
    userId,
    apikeyString,
  )
  const canManageOrg = new Map(orgIds.map((orgId, idx) => [orgId, orgAllowed[idx] === true]))

  // 2) Resolve every app the remaining app/channel bindings point at, in one query.
  const appFallbackBindings = bindings.filter(binding => !canManageOrg.get(binding.org_id)
    && binding.scope_type !== 'org'
    && !!binding.app_id
    && UUID_REGEX.test(binding.app_id))
  const appUuids = [...new Set(appFallbackBindings.map(binding => binding.app_id as string))]
  const appIdByUuidAndOrg = new Map<string, string>()
  if (appUuids.length > 0) {
    const apps = await drizzle.execute<{ id: string, app_id: string, owner_org: string }>(sql`
      SELECT id::text AS id, app_id, owner_org::text AS owner_org
      FROM public.apps
      WHERE id = ANY(${`{${appUuids.join(',')}}`}::uuid[])
    `)
    for (const app of apps.rows)
      appIdByUuidAndOrg.set(`${app.id.toLowerCase()}|${app.owner_org.toLowerCase()}`, app.app_id)
  }
  const appKey = (binding: BindingInput) => `${(binding.app_id as string).toLowerCase()}|${binding.org_id.toLowerCase()}`

  // 3) app.manage_apikeys for every distinct (org, app) pair, in one statement.
  const appChecks = [...new Map(appFallbackBindings
    .map(binding => ({ orgId: binding.org_id, appId: appIdByUuidAndOrg.get(appKey(binding)) }))
    .filter((check): check is { orgId: string, appId: string } => !!check.appId)
    .map(check => [`${check.orgId}|${check.appId}`, check] as const)).values()]
  const appAllowed = await checkPermissionsBatchPg(
    c,
    appChecks.map(scope => ({ permission: 'app.manage_apikeys' as const, scope })),
    drizzle,
    userId,
    apikeyString,
  )
  const canManageApp = new Map(appChecks.map((check, idx) => [`${check.orgId}|${check.appId}`, appAllowed[idx] === true]))

  // 4) Same decision and error, in binding order, as the per-binding checks.
  for (const binding of bindings) {
    const orgId = binding.org_id
    if (canManageOrg.get(orgId))
      continue

    if (binding.scope_type !== 'org' && binding.app_id && UUID_REGEX.test(binding.app_id)) {
      const appId = appIdByUuidAndOrg.get(appKey(binding))
      if (appId && canManageApp.get(`${orgId}|${appId}`))
        continue
    }

    throw quickError(403, 'forbidden_binding', `Forbidden - API key management rights required for org ${orgId}`)
  }
}

async function assertExpirationMatchesOrgPoliciesPg(
  db: DrizzleExecutor,
  orgIds: string[],
  expiresAt: string | null,
): Promise<void> {
  if (orgIds.length === 0) {
    return
  }

  const result = await db.execute<{
    require_apikey_expiration: boolean | null
    max_apikey_expiration_days: number | null
  }>(sql`
    SELECT require_apikey_expiration, max_apikey_expiration_days
    FROM public.orgs
    WHERE id IN (${sql.join(orgIds.map(orgId => sql`${orgId}::uuid`), sql`, `)})
  `)

  assertExpirationMatchesOrgPolicies(result.rows, expiresAt)
}

app.post('/', middlewareAuth(), async (c) => {
  const startedAt = Date.now()
  const auth = requireApiKeyManagementAuth(c, 'not_authorized', 'API key management requires authentication')
  if (auth.authType !== 'jwt' || !auth.userId) {
    if (auth.authType === 'apikey') {
      throw simpleError('cannot_create_apikey', 'API keys cannot create other API keys')
    }
    throw simpleError('not_authorized', 'Only user sessions can create API keys')
  }

  await requireJwtMfaForPrivilegedAction(c, auth)

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

  const resolvedBindings = bindings
  const globalPermissions = parseApiKeyGlobalPermissions(body.global_permissions, c.get('requestId')) ?? []
  validateApiKeyGlobalPermissionsForBindings(globalPermissions, resolvedBindings, c.get('requestId'))

  const allOrgIds = [...new Set(resolvedBindings.map(binding => binding.org_id))]

  let apikeyData: ApiKeyRow | null = null

  let pgClient: Awaited<ReturnType<typeof getPgClient>> | undefined
  try {
    pgClient = await getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)
    const createdBindings: unknown[] = []
    const callerPrincipalId = auth.userId

    await drizzle.transaction(async (tx) => {
      const txDrizzle = tx as unknown as ReturnType<typeof getDrizzleClient>
      await lockRbacOrgs(txDrizzle, allOrgIds)

      const apikeyString = auth.apikey?.key ?? c.get('capgkey') ?? null
      await assertCanManageApiKeyBindingsPg(c, txDrizzle, auth.userId, apikeyString, resolvedBindings)
      await assertApiKeyManagerCanAssignBindings(c, auth, resolvedBindings, txDrizzle)
      await assertExpirationMatchesOrgPoliciesPg(tx, allOrgIds, expiresAt)

      apikeyData = await createApiKeyRecord(tx, {
        userId: auth.userId,
        name,
        expiresAt,
        isHashed,
      })

      if (!apikeyData.rbac_id) {
        throw new Error('Created API key is missing rbac_id')
      }

      // Resolve every role once for the whole binding set.
      const batchCache = createRoleBindingBatchCache()
      await prefetchRolesForBindings(txDrizzle, batchCache, resolvedBindings.map(binding => binding.role_name))

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
          {
            skipOrgLock: true,
            skipPrincipalValidation: true,
            batchCache,
          },
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

      if (globalPermissions.length > 0) {
        await replaceApiKeyGlobalPermissions(tx, apikeyData.rbac_id, globalPermissions, auth.userId)
      }
    })

    cloudlog({
      requestId: c.get('requestId'),
      message: 'apikey_bindings_created',
      apikeyId: (apikeyData as ApiKeyRow | null)?.id,
      bindingsCount: createdBindings.length,
      durationMs: Date.now() - startedAt,
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
