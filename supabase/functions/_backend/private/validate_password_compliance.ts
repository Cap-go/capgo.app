import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { z } from 'zod'
import { Hono } from 'hono/tiny'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { parseBody, quickError, simpleError, simpleRateLimit, useCors } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { getEffectivePasswordMinLength, getPasswordPolicyValidationErrors } from '../utils/password_policy.ts'
import { clearFailedAccountAuth, isAccountRateLimited, isIPRateLimited, recordFailedAccountAuth, recordFailedAuth } from '../utils/rate_limit.ts'
import { buildRateLimitInfo } from '../utils/rateLimitInfo.ts'
import type { RlsPrincipal } from '../utils/pg_rls.ts'
import { getClaimsFromJWT } from '../utils/hono_jwt.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { withRlsTransaction } from '../utils/pg_rls.ts'
import { emptySupabase } from '../utils/supabase.ts'
import { getEnv } from '../utils/utils.ts'

interface ValidatePasswordCompliance {
  email: string
  password: string
  org_id: string
  captcha_token?: string
}

interface QueryClient {
  query: <R extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: R[] }>
}

interface OrgReadAccessResult {
  allowed: boolean
  error?: string
}

type BackendContext = Context<MiddlewareKeyVariables>

/**
 * Normalize and validate a request origin string to a stable origin value.
 */
function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin
  }
  catch {
    return ''
  }
}

/**
 * Build the explicit origin allowlist for this endpoint.
 * Includes configured webapp origin plus optional custom allowed origins.
 */
function getAllowedOrigins(c: BackendContext): Set<string> {
  const webappUrl = normalizeOrigin(getEnv(c, 'WEBAPP_URL'))
  const configuredOrigins = getEnv(c, 'PASSWORD_COMPLIANCE_ALLOWED_ORIGINS')
    .split(',')
    .map(origin => normalizeOrigin(origin.trim()))
    .filter(Boolean)

  const allowed = new Set<string>()
  if (webappUrl)
    allowed.add(webappUrl)

  for (const origin of configuredOrigins) {
    allowed.add(origin)
  }

  return allowed
}

/**
 * Return true for native/webview origins that are expected for first-party clients.
 */
function isNativeOrLocalOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin)
    if (parsed.protocol === 'capacitor:')
      return parsed.hostname === 'localhost'
    if (parsed.protocol === 'ionic:')
      return parsed.hostname === 'localhost'
    if (!(['http:', 'https:'].includes(parsed.protocol)))
      return false
    return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  }
  catch {
    return false
  }
}

/**
 * Validate incoming Origin header before processing the password compliance payload.
 */
async function validateOrigin(c: BackendContext, next: () => Promise<void>) {
  const origin = c.req.header('origin')
  if (!origin)
    return next()

  const requestOrigin = normalizeOrigin(origin)
  const allowedOrigins = getAllowedOrigins(c)
  const isNativeOrLocal = isNativeOrLocalOrigin(origin)
  if (!isNativeOrLocal && (!requestOrigin || !allowedOrigins.has(requestOrigin))) {
    cloudlog({ requestId: c.get('requestId'), context: 'validate_password_compliance - forbidden origin', origin })
    return quickError(403, 'forbidden_origin', 'Origin is not allowed for this endpoint')
  }

  return next()
}

const bodySchema = z.object({
  email: z.email(),
  password: z.string().min(1),
  org_id: z.uuid(),
  captcha_token: z.string().min(1).optional(),
})

/**
 * Resolve whether the authenticated user has `org.read` access for the org.
 * `client` must already run as that user (see withRlsTransaction).
 */
export async function checkOrgReadAccess(
  client: QueryClient,
  orgId: string,
  requestId: string,
): Promise<OrgReadAccessResult> {
  let data: boolean | null | undefined
  try {
    const { rows } = await client.query<{ allowed: boolean | null }>(
      'SELECT public.rbac_check_permission_no_password_policy(p_permission_key => $1, p_org_id => $2) AS allowed',
      ['org.read', orgId],
    )
    data = rows[0]?.allowed
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    cloudlog({ requestId, context: 'validate_password_compliance - org membership lookup failed', error: message })
    return { allowed: false, error: message }
  }

  return { allowed: data === true }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', validateOrigin)
app.use('/', useCors)

app.post('/', async (c) => {
  const rawBody = await parseBody<ValidatePasswordCompliance>(c)

  const ipRateLimitStatus = await isIPRateLimited(c)
  if (ipRateLimitStatus.limited) {
    return simpleRateLimit({ reason: 'too_many_failed_auth_attempts', ...buildRateLimitInfo(ipRateLimitStatus.resetAt) })
  }

  // Validate request body
  const validationResult = safeParseSchema(bodySchema, rawBody)
  if (!validationResult.success) {
    throw simpleError('invalid_body', 'Invalid request body', { errors: validationResult.error.message })
  }

  const body = validationResult.data
  const accountRateLimitStatus = await isAccountRateLimited(c, body.email)
  if (accountRateLimitStatus.limited) {
    return simpleRateLimit({ reason: 'too_many_failed_account_auth_attempts', ...buildRateLimitInfo(accountRateLimitStatus.resetAt) })
  }

  const { password: _password, captcha_token: _captchaToken, ...bodyWithoutPassword } = body
  cloudlog({ requestId: c.get('requestId'), context: 'validate_password_compliance raw body', rawBody: bodyWithoutPassword })

  // Authenticate first to avoid leaking org existence to unauthenticated callers.
  const loginClient = emptySupabase(c)
  const { data: signInData, error: signInError } = await loginClient.auth.signInWithPassword({
    email: body.email,
    password: body.password,
    options: body.captcha_token
      ? { captchaToken: body.captcha_token }
      : undefined,
  })

  if (signInError || !signInData.user || !signInData.session) {
    const errorCode = signInError?.code
    const authErrorStatus = (signInError as { status?: unknown } | null)?.status
    const errorStatus = typeof authErrorStatus === 'number' ? authErrorStatus : undefined
    const errorMessage = signInError?.message ?? 'Authentication failed'
    const missingAuthenticatedSession = !signInError && (!signInData.user || !signInData.session)
    cloudlog({ requestId: c.get('requestId'), context: 'validate_password_compliance - login failed', error: errorMessage, errorCode: errorCode ?? 'auth_failed', errorStatus })
    await recordFailedAuth(c)

    if (errorCode === 'captcha_failed') {
      return quickError(401, 'captcha_failed', 'Captcha verification failed')
    }

    if (errorCode === 'invalid_credentials' || (!errorCode && errorStatus === 400) || missingAuthenticatedSession) {
      await recordFailedAccountAuth(c, body.email)
      return quickError(401, 'invalid_credentials', 'Invalid email or password')
    }

    return quickError(401, 'invalid_credentials', 'Invalid email or password')
  }

  await clearFailedAccountAuth(c, body.email)

  const userId = signInData.user.id
  // Same claims PostgREST would read from the session's access token.
  const sessionClaims = await getClaimsFromJWT(c, `Bearer ${signInData.session.access_token}`)
  const userPrincipal: RlsPrincipal | null = sessionClaims?.sub ? { kind: 'jwt', userId: sessionClaims.sub, claims: sessionClaims } : null

  const pg = await getPgClient(c)
  try {
    // Check org membership/rights first. For non-members (and for non-existent orgs),
    // this returns the same not_member response to avoid an existence oracle.
    const orgAccess = userPrincipal
      ? await withRlsTransaction(pg, userPrincipal, client => checkOrgReadAccess(client, body.org_id, c.get('requestId')))
      : { allowed: false, error: 'Invalid JWT' }
    if (orgAccess.error) {
      return quickError(500, 'org_membership_lookup_failed', 'Failed to verify organization membership', { error: orgAccess.error })
    }

    if (!orgAccess.allowed) {
      return quickError(403, 'not_member', 'You are not a member of this organization')
    }

    // Fetch the org's password policy after membership verification.
    //
    // IMPORTANT: do not read as the user here. org reads enforce password-policy
    // compliance, creating a circular dependency for users who are non-compliant
    // (this endpoint is their remediation path).
    let org: { id: string, password_policy_config: unknown } | undefined
    let orgError: string | undefined
    try {
      const orgResult = await pg.query<{ id: string, password_policy_config: unknown }>('SELECT id, password_policy_config FROM public.orgs WHERE id = $1', [body.org_id])
      org = orgResult.rows[0]
    }
    catch (error) {
      orgError = error instanceof Error ? error.message : String(error)
    }

    if (orgError || !org) {
      cloudlog({ requestId: c.get('requestId'), context: 'validate_password_compliance - org lookup failed', error: orgError })
      return quickError(500, 'org_lookup_failed', 'Failed to load organization password policy', { error: orgError })
    }

    // Check if org has password policy enabled
    const policy = org.password_policy_config as {
      enabled?: boolean
      min_length?: number
      require_uppercase?: boolean
      require_number?: boolean
      require_special?: boolean
    } | null

    if (!policy?.enabled) {
      return quickError(400, 'no_policy', 'Organization does not have a password policy enabled')
    }

    // Check if the password meets the policy requirements
    const policyErrors = getPasswordPolicyValidationErrors(body.password, policy)
    const effectiveMinLength = getEffectivePasswordMinLength(policy.min_length)

    if (policyErrors.length > 0) {
      throw simpleError('password_does_not_meet_policy', 'Your current password does not meet the organization requirements', {
        errors: policyErrors,
        policy: {
          min_length: effectiveMinLength,
          require_uppercase: policy.require_uppercase,
          require_number: policy.require_number,
          require_special: policy.require_special,
        },
      })
    }

    // Password is valid! Create or update the compliance record
    // Get the policy hash from the SQL function (matches the validation logic)
    let policyHash: string | null = null
    let hashError: string | undefined
    try {
      policyHash = await withRlsTransaction(pg, userPrincipal!, async (client) => {
        const { rows } = await client.query<{ policy_hash: string | null }>(
          'SELECT public.get_password_policy_hash(policy_config => $1::jsonb) AS policy_hash',
          [JSON.stringify(org.password_policy_config)],
        )
        return rows[0]?.policy_hash ?? null
      })
    }
    catch (error) {
      hashError = error instanceof Error ? error.message : String(error)
    }

    if (hashError || !policyHash) {
      cloudlog({ requestId: c.get('requestId'), context: 'validate_password_compliance - hash error', error: hashError })
      return quickError(500, 'hash_failed', 'Failed to compute policy hash', { error: hashError })
    }

    // Upsert the compliance record (connection role bypasses RLS)
    try {
      const now = new Date().toISOString()
      await pg.query(
        `INSERT INTO public.user_password_compliance (user_id, org_id, policy_hash, validated_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, org_id) DO UPDATE SET
          policy_hash = EXCLUDED.policy_hash,
          validated_at = EXCLUDED.validated_at,
          updated_at = EXCLUDED.updated_at`,
        [userId, body.org_id, policyHash, now, now],
      )
    }
    catch (error) {
      const upsertError = error instanceof Error ? error.message : String(error)
      cloudlog({ requestId: c.get('requestId'), context: 'validate_password_compliance - upsert error', error: upsertError })
      return quickError(500, 'compliance_update_failed', 'Failed to update compliance record', { error: upsertError })
    }
  }
  finally {
    closeClient(c, pg)
  }

  cloudlog({ requestId: c.get('requestId'), context: 'validate_password_compliance - success', userId, orgId: body.org_id })

  return c.json({
    status: 'ok',
    message: 'Password verified and meets organization requirements',
  })
})
