import type { Context } from 'hono'
import type { APIKeyRateLimitScope } from './rate_limit.ts'
import type { Database } from './supabase.types.ts'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { honoFactory, quickError, simpleRateLimit } from './hono.ts'
import { getClaimsFromJWT } from './hono_jwt.ts'
import { cloudlog } from './logging.ts'
import { closeClient, getDrizzleClient, getPgClient, logPgError } from './pg.ts'
import * as schema from './postgres_schema.ts'
import { isAPIKeyRateLimited, isIPRateLimited, recordAPIKeyUsage, recordFailedAuth } from './rate_limit.ts'
import { buildRateLimitInfo } from './rateLimitInfo.ts'
import { checkKey, checkKeyById, supabaseAdmin } from './supabase.ts'

// TODO: make universal middleware who
//  Accept authorization header (JWT)
//  Accept capgkey header (legacy apikey header name for CLI)
//  Accept x-api-key header (new apikey header name for CLI + public api)
//  Accept x-limited-key-id header (subkey id, for whitelabel api, only work in combination with x-api-key)
// It sets apikey, capgkey, subkey to the context
// It throws an error if the apikey is invalid
// It throws an error if the subkey is invalid
// It throws an error if the apikey is invalid and the subkey is invalid
// It throws an error if the apikey is invalid and the subkey is invalid
// It throws an error if no apikey or subkey is provided

function isUUID(str: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)
}

function maskSecret(value?: string | null) {
  if (!value) {
    return undefined
  }
  return `${value.slice(0, 8)}...`
}

/**
 * SQL condition for non-expired API keys: expires_at IS NULL OR expires_at > now()
 */
const notExpiredCondition = or(
  isNull(schema.apikeys.expires_at),
  sql`${schema.apikeys.expires_at} > now()`,
)

// Type for the find_apikey_by_value result
type FindApikeyByValueResult = {
  id: number
  created_at: string | null
  user_id: string
  key: string | null
  key_hash: string | null
  rbac_id: string
  updated_at: string | null
  name: string
  expires_at: string | null
} & Record<string, unknown>

/**
 * Check API key using Postgres/Drizzle instead of Supabase SDK
 * Uses find_apikey_by_value SQL function to look up both plain-text and hashed keys
 */
async function checkKeyPg(
  _c: Context,
  keyString: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<Database['public']['Tables']['apikeys']['Row'] | null> {
  try {
    // Use find_apikey_by_value SQL function to look up both plain-text and hashed keys
    const result = await drizzleClient.execute<FindApikeyByValueResult>(
      sql`SELECT * FROM find_apikey_by_value(${keyString})`,
    )

    const apiKey = result.rows[0]
    if (!apiKey) {
      cloudlog({ requestId: _c.get('requestId'), message: 'Invalid apikey (pg)', keyStringPrefix: keyString?.substring(0, 8) })
      return null
    }

    // Check if key is expired
    if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
      cloudlog({ requestId: _c.get('requestId'), message: 'Apikey expired (pg)', keyStringPrefix: keyString?.substring(0, 8) })
      return null
    }

    // Convert to the expected format
    return {
      id: apiKey.id,
      created_at: apiKey.created_at,
      user_id: apiKey.user_id,
      key: apiKey.key,
      key_hash: apiKey.key_hash,
      rbac_id: apiKey.rbac_id,
      updated_at: apiKey.updated_at,
      name: apiKey.name,
      expires_at: apiKey.expires_at,
    } as Database['public']['Tables']['apikeys']['Row']
  }
  catch (e: unknown) {
    logPgError(_c, 'checkKeyPg', e)
    return null
  }
}

/**
 * Check API key by ID using Postgres/Drizzle instead of Supabase SDK
 * Expiration is checked directly in SQL query - no JS check needed
 */
async function checkKeyByIdPg(
  _c: Context,
  id: number,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  expectedUserId?: string,
): Promise<Database['public']['Tables']['apikeys']['Row'] | null> {
  try {
    const conditions = [
      eq(schema.apikeys.id, id),
      notExpiredCondition,
    ]
    if (expectedUserId) {
      conditions.push(eq(schema.apikeys.user_id, expectedUserId))
    }
    // Expiration check is done in SQL: expires_at IS NULL OR expires_at > now()
    const result = await drizzleClient
      .select()
      .from(schema.apikeys)
      .where(and(
        ...conditions,
      ))
      .limit(1)
      .then(data => data[0])

    if (!result) {
      return null
    }

    // Convert to the expected format, ensuring arrays are properly handled
    return {
      id: result.id,
      created_at: result.created_at?.toISOString() || null,
      user_id: result.user_id,
      key: result.key,
      key_hash: result.key_hash,
      rbac_id: result.rbac_id,
      updated_at: result.updated_at?.toISOString() || null,
      name: result.name,
      expires_at: result.expires_at?.toISOString() || null,
    } as Database['public']['Tables']['apikeys']['Row']
  }
  catch (e: unknown) {
    logPgError(_c, 'checkKeyByIdPg', e)
    return null
  }
}

/**
 * Parses and validates the x-limited-key-id header.
 *
 * Empty or malformed header values are treated as failed auth attempts so they
 * participate in the IP throttling flow like other invalid credentials.
 *
 * @param c - Hono context used to read headers and record failed auth attempts.
 * @returns The parsed subkey id when present and valid, otherwise null.
 */
async function getSubkeyId(c: Context) {
  if (!c.req.raw.headers.has('x-limited-key-id')) {
    return null
  }

  const headerValue = c.req.header('x-limited-key-id') ?? ''
  if (!/^[1-9]\d*$/.test(headerValue)) {
    await recordFailedAuth(c)
    return quickError(401, 'invalid_subkey', 'Invalid x-limited-key-id')
  }

  const subkeyId = Number(headerValue)
  if (!Number.isSafeInteger(subkeyId)) {
    await recordFailedAuth(c)
    return quickError(401, 'invalid_subkey', 'Invalid x-limited-key-id')
  }

  return subkeyId
}

/**
 * Persists the authenticated API key on the context for downstream middleware.
 *
 * @param c - Hono context used to store auth data.
 * @param apikey - The row representing the authenticated API key.
 * @param keyString - The raw API key string that was provided.
 */
function setApiKeyAuthContext(c: Context, apikey: Database['public']['Tables']['apikeys']['Row'], keyString: string) {
  c.set('auth', {
    userId: apikey.user_id,
    authType: 'apikey',
    apikey,
    jwt: null,
  })
  c.set('apikey', apikey)
  c.set('parentApikey', apikey)
  c.set('capgkey', keyString)
}

/**
 * Overrides the context auth payload with the subkey and its owning user id.
 *
 * @param c - Hono context used to store auth data.
 * @param userId - The owner of the parent API key.
 * @param subkey - The row representing the validated subkey.
 * @param subkeySecret - The plaintext subkey secret to propagate to downstream checks.
 */
function setSubkeyAuthContext(c: Context, userId: string, subkey: Database['public']['Tables']['apikeys']['Row'], subkeySecret: string) {
  c.set('auth', {
    userId,
    authType: 'apikey',
    apikey: subkey,
    jwt: null,
  })
  c.set('apikey', subkey)
  c.set('subkey', subkey)
  c.set('capgkey', subkeySecret)
}

/**
 * Ensures the subkey enforces at least one organization or application limit.
 *
 * @param c - Hono context used for logging.
 * @param subkey - The candidate subkey row.
 * @returns quickError response when invalid limits are detected, otherwise null.
 */
async function hasLimitedRbacSubkeyScope(
  c: Context,
  subkey: Database['public']['Tables']['apikeys']['Row'],
) {
  if (!subkey.rbac_id)
    return false

  let pgClient: ReturnType<typeof getPgClient> | null = null
  try {
    pgClient = getPgClient(c)
    const result = await pgClient.query<{ is_limited: boolean }>(
      `
      WITH user_orgs AS (
        SELECT rb.org_id
        FROM public.role_bindings rb
        WHERE rb.principal_type = public.rbac_principal_user()
          AND rb.principal_id = $1::uuid
          AND rb.org_id IS NOT NULL
          AND (rb.expires_at IS NULL OR rb.expires_at > now())

        UNION

        SELECT g.org_id
        FROM public.group_members gm
        INNER JOIN public.groups g ON g.id = gm.group_id
        INNER JOIN public.role_bindings rb
          ON rb.principal_type = public.rbac_principal_group()
          AND rb.principal_id = gm.group_id
          AND rb.org_id = g.org_id
        WHERE gm.user_id = $1::uuid
          AND rb.org_id IS NOT NULL
          AND (rb.expires_at IS NULL OR rb.expires_at > now())
      ),
      active_bindings AS (
        SELECT rb.scope_type, rb.org_id, r.name AS role_name
        FROM public.role_bindings rb
        INNER JOIN public.roles r ON r.id = rb.role_id
        WHERE rb.principal_type = public.rbac_principal_apikey()
          AND rb.principal_id = $2::uuid
          AND (rb.expires_at IS NULL OR rb.expires_at > now())
      )
      SELECT (
        EXISTS (SELECT 1 FROM active_bindings)
        AND (
          EXISTS (
            SELECT 1
            FROM active_bindings
            WHERE scope_type <> public.rbac_scope_org()
          )
          OR EXISTS (
            SELECT 1
            FROM user_orgs u
            WHERE NOT EXISTS (
              SELECT 1
              FROM active_bindings b
              WHERE b.scope_type = public.rbac_scope_org()
                AND b.org_id = u.org_id
                AND b.role_name IN (public.rbac_role_org_super_admin(), public.rbac_role_org_admin())
            )
          )
          OR NOT EXISTS (
            SELECT 1
            FROM active_bindings b
            WHERE b.scope_type = public.rbac_scope_org()
              AND b.role_name IN (public.rbac_role_org_super_admin(), public.rbac_role_org_admin())
          )
        )
      ) AS is_limited
      `,
      [subkey.user_id, subkey.rbac_id],
    )

    return result.rows[0]?.is_limited === true
  }
  catch (error) {
    logPgError(c, 'hasLimitedRbacSubkeyScope', error)
    return false
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
}

async function validateSubkeyLimits(c: Context, subkey: Database['public']['Tables']['apikeys']['Row']) {
  if (!(await hasLimitedRbacSubkeyScope(c, subkey))) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Invalid subkey, no limited apps or orgs',
      subkeyId: subkey.id,
      subkeyUserId: subkey.user_id,
    })
    return quickError(401, 'invalid_subkey', 'Invalid subkey, no limited apps or orgs')
  }
  return null
}

/**
 * Rejects hashed-only subkeys because downstream SQL/RLS paths still require a
 * plaintext key string and would otherwise fall back to the parent API key.
 *
 * @param c - Hono context used for logging.
 * @param subkey - The candidate subkey row.
 * @throws quickError when the subkey cannot be safely represented.
 */
function assertSubkeyHasPlaintextSecret(
  c: Context,
  subkey: Database['public']['Tables']['apikeys']['Row'],
): asserts subkey is Database['public']['Tables']['apikeys']['Row'] & { key: string } {
  if (!subkey.key) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Invalid hashed subkey, cannot propagate subkey auth context',
      subkeyId: subkey.id,
      subkeyUserId: subkey.user_id,
    })
    quickError(401, 'invalid_subkey', 'Invalid subkey')
  }
}

/**
 * Verifies that a subkey belongs to the same user as its parent API key.
 *
 * @param c - Hono context used for logging.
 * @param subkey - The subkey row.
 * @param apikey - The parent API key row.
 * @returns quickError response when the user IDs differ, otherwise null.
 */
function validateSubkeyUser(c: Context, subkey: Database['public']['Tables']['apikeys']['Row'], apikey: Database['public']['Tables']['apikeys']['Row']) {
  if (subkey.user_id !== apikey.user_id) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Subkey user_id does not match apikey user_id',
      subkeyId: subkey.id,
      subkeyUserId: subkey.user_id,
      apikeyId: apikey.id,
      apikeyUserId: apikey.user_id,
    })
    return quickError(401, 'invalid_subkey', 'Invalid subkey')
  }
  return null
}

function resolveAuthHeaders(c: Context) {
  let jwt = c.req.header('authorization')
  let capgkey = c.req.header('capgkey') ?? c.req.header('x-api-key')

  if (jwt && isUUID(jwt)) {
    cloudlog({ requestId: c.get('requestId'), message: 'Setting apikey in capgkey_string', jwtPrefix: maskSecret(jwt) })
    capgkey = jwt
    jwt = undefined
  }

  return { jwt, capgkey }
}

function resolveKeyHeaders(c: Context) {
  const capgkeyString = c.req.header('capgkey')
  const apikeyString = c.req.header('authorization')
  const key = capgkeyString ?? apikeyString
  return { capgkeyString, apikeyString, key }
}

async function resolveApiKey(
  c: Context,
  key: string,
  usePostgres: boolean,
  readOnly = true,
) {
  if (!usePostgres) {
    return checkKey(c, key, supabaseAdmin(c))
  }

  let pgClient: ReturnType<typeof getPgClient> | null = null
  try {
    pgClient = getPgClient(c, readOnly)
    const drizzleClient = getDrizzleClient(pgClient)
    return await checkKeyPg(c, key, drizzleClient)
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
}

async function resolveSubkey(
  c: Context,
  subkeyId: number,
  usePostgres: boolean,
  expectedUserId?: string,
  readOnly = true,
) {
  if (!usePostgres) {
    return checkKeyById(c, subkeyId, supabaseAdmin(c), expectedUserId)
  }

  let subkeyPgClient: ReturnType<typeof getPgClient> | null = null
  try {
    subkeyPgClient = getPgClient(c, readOnly)
    const drizzleClient = getDrizzleClient(subkeyPgClient)
    return await checkKeyByIdPg(c, subkeyId, drizzleClient, expectedUserId)
  }
  finally {
    if (subkeyPgClient) {
      await closeClient(c, subkeyPgClient)
    }
  }
}

/**
 * Authenticates an API key string, performs rate limiting, and optionally resolves a matching subkey.
 *
 * @param c - Hono context used for logging and auth storage.
 * @param capgkeyString - The key string provided in capgkey or authorization headers.
 * @returns quickError when authentication fails or undefined when authentication succeeds.
 */
async function foundAPIKey(c: Context, capgkeyString: string) {
  const subkey_id = await getSubkeyId(c)

  cloudlog({ requestId: c.get('requestId'), message: 'Capgkey provided', capgkeyPrefix: maskSecret(capgkeyString) })
  const apikey = await resolveApiKey(c, capgkeyString, false)
  if (!apikey) {
    cloudlog({ requestId: c.get('requestId'), message: 'Invalid apikey', capgkeyPrefix: maskSecret(capgkeyString) })
    // Record failed auth attempt - await to ensure accurate counting
    await recordFailedAuth(c)
    return quickError(401, 'invalid_apikey', 'Invalid apikey')
  }

  // Record API usage first, then check if rate limited
  await recordAPIKeyUsage(c, apikey.id)

  // Check if API key is rate limited after recording usage
  const apiKeyRateLimited = await isAPIKeyRateLimited(c, apikey.id)
  if (apiKeyRateLimited.limited) {
    return simpleRateLimit({ reason: 'api_key_rate_limit_exceeded', apikey_id: apikey.id, ...buildRateLimitInfo(apiKeyRateLimited.resetAt) })
  }

  // Store the original key string for hashed key authentication
  // This is needed because hashed keys have key=null in the database
  setApiKeyAuthContext(c, apikey, capgkeyString)
  if (subkey_id !== null) {
    cloudlog({ requestId: c.get('requestId'), message: 'Subkey id provided', subkey_id })
    const subkey = await resolveSubkey(c, subkey_id, false, apikey.user_id)
    if (!subkey) {
      cloudlog({ requestId: c.get('requestId'), message: 'Invalid subkey', subkey_id })
      return quickError(401, 'invalid_subkey', 'Invalid subkey')
    }
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Subkey resolved',
      subkeyId: subkey.id,
      subkeyUserId: subkey.user_id,
    })
    const userError = validateSubkeyUser(c, subkey, apikey)
    if (userError) {
      return userError
    }
    const limitError = await validateSubkeyLimits(c, subkey)
    if (limitError) {
      return limitError
    }
    assertSubkeyHasPlaintextSecret(c, subkey)
    setSubkeyAuthContext(c, apikey.user_id, subkey, subkey.key)
  }
}

async function foundJWT(c: Context, jwt: string) {
  cloudlog({ requestId: c.get('requestId'), message: 'JWT provided', jwtPrefix: maskSecret(jwt) })

  // Decode JWT claims via Supabase Auth `getClaims()`.
  const claims = await getClaimsFromJWT(c, jwt)
  if (!claims || !claims.sub) {
    cloudlog({ requestId: c.get('requestId'), message: 'Invalid JWT claims' })
    // Record failed auth attempt - await to ensure accurate counting
    await recordFailedAuth(c)
    return quickError(401, 'invalid_jwt', 'Invalid JWT')
  }

  c.set('auth', {
    userId: claims.sub,
    authType: 'jwt',
    jwt,
    apikey: null,
    claims,
  })
}

export function middlewareAuth() {
  return honoFactory.createMiddleware(async (c, next) => {
    // Check if IP is rate limited due to failed auth attempts
    const ipRateLimited = await isIPRateLimited(c)
    if (ipRateLimited.limited) {
      return simpleRateLimit({ reason: 'too_many_failed_auth_attempts', ...buildRateLimitInfo(ipRateLimited.resetAt) })
    }

    const { jwt, capgkey } = resolveAuthHeaders(c)
    if (jwt) {
      const res = await foundJWT(c, jwt)
      if (res) {
        return res
      }
    }
    else if (capgkey) {
      const res = await foundAPIKey(c, capgkey)
      if (res) {
        return res
      }
    }
    else {
      cloudlog({ requestId: c.get('requestId'), message: 'No apikey or subkey provided' })
      // Record failed auth attempt - await to ensure accurate counting
      await recordFailedAuth(c)
      return quickError(401, 'no_jwt_apikey_or_subkey', 'No JWT, apikey or subkey provided')
    }
    await next()
  })
}

/**
 * Compatibility alias for routes that have not yet switched to middlewareAuth.
 *
 * RBAC authorizes requests after authentication, so the former key-mode
 * argument is intentionally no longer enforced here.
 */
export function middlewareV2(_rights: string[]) {
  return middlewareAuth()
}

interface MiddlewareKeyOptions {
  usePostgres?: boolean
  readOnly?: boolean
  rateLimitScope?: APIKeyRateLimitScope
}

function resolveMiddlewareKeyOptions(
  optionsOrRights: MiddlewareKeyOptions | string[] | undefined,
  legacyUsePostgres: boolean,
  legacyReadOnly: boolean,
  legacyRateLimitScope: APIKeyRateLimitScope,
) {
  if (Array.isArray(optionsOrRights)) {
    return {
      usePostgres: legacyUsePostgres,
      readOnly: legacyReadOnly,
      rateLimitScope: legacyRateLimitScope,
    }
  }

  const options = optionsOrRights ?? {}
  return {
    usePostgres: options.usePostgres ?? false,
    readOnly: options.readOnly ?? true,
    rateLimitScope: options.rateLimitScope ?? 'default',
  }
}

/**
 * Middleware factory that validates API keys and optional subkeys.
 *
 * Route handlers and RLS authorize with RBAC after authentication succeeds.
 */
export function middlewareKey(
  optionsOrRights?: MiddlewareKeyOptions | string[],
  legacyUsePostgres = false,
  legacyReadOnly = true,
  legacyRateLimitScope: APIKeyRateLimitScope = 'default',
) {
  const { usePostgres, readOnly, rateLimitScope } = resolveMiddlewareKeyOptions(
    optionsOrRights,
    legacyUsePostgres,
    legacyReadOnly,
    legacyRateLimitScope,
  )
  const subMiddlewareKey = honoFactory.createMiddleware(async (c, next) => {
    // Check if IP is rate limited due to failed auth attempts
    const ipRateLimited = await isIPRateLimited(c)
    if (ipRateLimited.limited) {
      return simpleRateLimit({ reason: 'too_many_failed_auth_attempts', ...buildRateLimitInfo(ipRateLimited.resetAt) })
    }

    const { capgkeyString, apikeyString, key } = resolveKeyHeaders(c)
    const subkey_id = await getSubkeyId(c)

    cloudlog({
      requestId: c.get('requestId'),
      message: 'middlewareKey - checking authorization',
      method: c.req.method,
      url: c.req.url,
      hasCapgkey: !!capgkeyString,
      hasAuthorization: !!apikeyString,
      hasKey: !!key,
      usePostgres,
    })
    if (!key) {
      cloudlog({ requestId: c.get('requestId'), message: 'No key provided', method: c.req.method, url: c.req.url })
      // Record failed auth attempt - await to ensure accurate counting
      await recordFailedAuth(c)
      return quickError(401, 'no_key_provided', 'No key provided')
    }

    const apikey = await resolveApiKey(c, key, usePostgres, readOnly)

    if (!apikey) {
      cloudlog({ requestId: c.get('requestId'), message: 'Invalid apikey', keyPrefix: maskSecret(key), method: c.req.method, url: c.req.url })
      // Record failed auth attempt - await to ensure accurate counting
      await recordFailedAuth(c)
      return quickError(401, 'invalid_apikey', 'Invalid apikey')
    }

    // Record API usage first, then check if rate limited
    await recordAPIKeyUsage(c, apikey.id, rateLimitScope)

    // Check if API key is rate limited after recording usage
    const apiKeyRateLimited = await isAPIKeyRateLimited(c, apikey.id, rateLimitScope)
    if (apiKeyRateLimited.limited) {
      const reason = rateLimitScope === 'upload' ? 'api_key_upload_rate_limit_exceeded' : 'api_key_rate_limit_exceeded'
      return simpleRateLimit({ reason, apikey_id: apikey.id, ...buildRateLimitInfo(apiKeyRateLimited.resetAt) })
    }

    // Set auth context for RBAC (can be overridden by subkey below)
    setApiKeyAuthContext(c, apikey, key)

    if (subkey_id !== null) {
      const subkey = await resolveSubkey(c, subkey_id, usePostgres, apikey.user_id, readOnly)

      if (!subkey) {
        cloudlog({ requestId: c.get('requestId'), message: 'Invalid subkey', subkey_id })
        return quickError(401, 'invalid_subkey', 'Invalid subkey')
      }
      const userError = validateSubkeyUser(c, subkey, apikey)
      if (userError) {
        return userError
      }
      const limitError = await validateSubkeyLimits(c, subkey)
      if (limitError) {
        return limitError
      }
      assertSubkeyHasPlaintextSecret(c, subkey)
      // Override auth context with subkey for RBAC
      setSubkeyAuthContext(c, apikey.user_id, subkey, subkey.key)
    }
    await next()
  })
  return subMiddlewareKey
}
