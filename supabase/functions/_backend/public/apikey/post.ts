import type { CreateBindingParams } from '../../private/role_bindings.ts'
import type { Database } from '../../utils/supabase.types.ts'
import type { ClientBindingInput } from './scope.ts'
import { sql } from 'drizzle-orm'
import { createRoleBindingForPrincipal, lockRbacOrgs } from '../../private/role_bindings.ts'
import { getErrorStatus } from '../../utils/errors.ts'
import { honoFactory, parseBody, quickError, simpleError } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_middleware.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../../utils/pg.ts'
import { checkPermissionPg } from '../../utils/rbac.ts'
import { assertExpirationMatchesOrgPolicies, validateExpirationDate } from '../../utils/supabase.ts'
import { parseApiKeyGlobalPermissions, replaceApiKeyGlobalPermissions, validateApiKeyGlobalPermissionsForBindings } from './global_permissions.ts'
import { assertApiKeyManagerCanAssignBindings, assertCallerHoldsSharedApiKeyPermissions, ensureApiKeyManagementAllowed, requireApiKeyManagementAuth, requireJwtMfaForPrivilegedAction, sanitizeClientBindings, setApiKeyAuditActor } from './scope.ts'

type BindingInput = ClientBindingInput
type ApiKeyRow = Database['public']['Tables']['apikeys']['Row']

type DrizzleExecutor = Pick<ReturnType<typeof getDrizzleClient>, 'execute'>

interface CreateApiKeyRecordParams {
  userId: string
  name: string
  expiresAt: string | null
  isHashed: boolean
  ownerOrgId: string | null
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
      expires_at,
      owner_org_id
    )
    VALUES (
      ${params.userId}::uuid,
      CASE WHEN ${params.isHashed}::boolean THEN NULL ELSE ${plainKey}::text END,
      CASE WHEN ${params.isHashed}::boolean THEN encode(extensions.digest(${plainKey}::text, 'sha256'), 'hex') ELSE NULL END,
      ${params.name}::text,
      ${params.expiresAt}::timestamptz,
      ${params.ownerOrgId}::uuid
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
  c: Parameters<typeof checkPermissionPg>[0],
  drizzle: ReturnType<typeof getDrizzleClient>,
  userId: string,
  apikeyString: string | null,
  bindings: BindingInput[],
): Promise<void> {
  const canManageOrg = new Map<string, boolean>()
  for (const binding of bindings) {
    const orgId = binding.org_id
    if (!canManageOrg.has(orgId))
      canManageOrg.set(orgId, await checkPermissionPg(c, 'org.manage_apikeys', { orgId }, drizzle, userId, apikeyString))
    if (canManageOrg.get(orgId))
      continue

    if (binding.scope_type !== 'org' && binding.app_id && UUID_REGEX.test(binding.app_id)) {
      const app = await drizzle.execute<{ app_id: string }>(sql`
        SELECT app_id FROM public.apps WHERE id = ${binding.app_id}::uuid AND owner_org = ${orgId}::uuid LIMIT 1
      `)
      const appId = app.rows[0]?.app_id
      if (appId && await checkPermissionPg(c, 'app.manage_apikeys', { orgId, appId }, drizzle, userId, apikeyString))
        continue
    }

    throw quickError(403, 'forbidden_binding', `Forbidden - API key management rights required for org ${orgId}`)
  }
}

function parseOwnerOrgId(value: unknown): string | null {
  if (value === undefined || value === null)
    return null
  if (typeof value !== 'string' || !UUID_REGEX.test(value))
    throw simpleError('invalid_owner_org_id', 'owner_org_id must be an organization id')
  return value
}

// A shared key belongs to one org: every binding must stay inside it, and it
// cannot carry global permissions such as org.create.
function assertSharedApiKeyBindings(ownerOrgId: string, bindings: BindingInput[], globalPermissions: string[]) {
  if (bindings.some(binding => binding.org_id !== ownerOrgId)) {
    throw simpleError('shared_apikey_single_org', 'Shared API keys can only have bindings in their owner organization')
  }
  if (globalPermissions.length > 0) {
    throw simpleError('shared_apikey_global_permissions', 'Shared API keys cannot have global permissions')
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
  const ownerOrgId = parseOwnerOrgId(body.owner_org_id)
  // Shared keys are only ever revealed once, so they are always hashed.
  const isHashed = ownerOrgId !== null || body.hashed === true

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
  if (ownerOrgId !== null) {
    assertSharedApiKeyBindings(ownerOrgId, resolvedBindings, globalPermissions)
  }

  const allOrgIds = [...new Set(resolvedBindings.map(binding => binding.org_id))]

  let apikeyData: ApiKeyRow | null = null

  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)
    const createdBindings: unknown[] = []
    const callerPrincipalId = auth.userId

    await drizzle.transaction(async (tx) => {
      const txDrizzle = tx as unknown as ReturnType<typeof getDrizzleClient>
      await setApiKeyAuditActor(txDrizzle, auth)
      await lockRbacOrgs(txDrizzle, allOrgIds)

      const apikeyString = auth.apikey?.key ?? c.get('capgkey') ?? null
      if (ownerOrgId !== null && !(await checkPermissionPg(c, 'org.manage_apikeys', { orgId: ownerOrgId }, txDrizzle, auth.userId, apikeyString))) {
        throw quickError(403, 'forbidden_binding', `Forbidden - shared API keys require API key management rights for org ${ownerOrgId}`)
      }
      await assertCanManageApiKeyBindingsPg(c, txDrizzle, auth.userId, apikeyString, resolvedBindings)
      await assertApiKeyManagerCanAssignBindings(c, auth, resolvedBindings, txDrizzle)
      await assertExpirationMatchesOrgPoliciesPg(tx, allOrgIds, expiresAt)

      apikeyData = await createApiKeyRecord(tx, {
        userId: auth.userId,
        name,
        expiresAt,
        isHashed,
        ownerOrgId,
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
          {
            skipOrgLock: true,
            skipPrincipalValidation: true,
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

      // Role rank and app/channel checks above do not cover org.* permissions.
      // The secret of a shared key outlives the caller's membership, so the
      // caller must already hold everything the new key can do.
      if (ownerOrgId !== null) {
        await assertCallerHoldsSharedApiKeyPermissions(txDrizzle, auth, apikeyData.rbac_id)
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
