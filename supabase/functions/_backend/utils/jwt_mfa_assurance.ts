import type { Context } from 'hono'
import type { AuthInfo, JWTClaims, MiddlewareKeyVariables } from './hono.ts'
import { quickError } from './hono.ts'
import { closeClient, getPgClient } from './pg.ts'

const SESSION_ID_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function getJwtAal(claims?: JWTClaims | null): string {
  const aal = claims?.aal
  return typeof aal === 'string' && aal.length > 0 ? aal : 'aal1'
}

function parseSessionId(claims?: JWTClaims | null): string | null {
  const sessionId = claims?.session_id
  if (typeof sessionId !== 'string' || !SESSION_ID_UUID_REGEX.test(sessionId)) {
    return null
  }
  return sessionId
}

async function userHasVerifiedMfaFactors(
  c: Context<MiddlewareKeyVariables>,
  userId: string,
): Promise<boolean> {
  let pgClient: ReturnType<typeof getPgClient> | null = null
  try {
    pgClient = getPgClient(c, true)
    const result = await pgClient.query<{ has_verified_mfa: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM auth.mfa_factors
        WHERE user_id = $1::uuid
          AND status = 'verified'
      ) AS has_verified_mfa
      `,
      [userId],
    )
    return result.rows[0]?.has_verified_mfa === true
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
}

async function isActivePlatformImpersonation(
  c: Context<MiddlewareKeyVariables>,
  userId: string,
  sessionId: string | null,
): Promise<boolean> {
  if (!sessionId) {
    return false
  }

  let pgClient: ReturnType<typeof getPgClient> | null = null
  try {
    pgClient = getPgClient(c, true)
    const result = await pgClient.query<{ is_active: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM public.platform_impersonation_sessions AS s
        WHERE s.target_user_id = $1::uuid
          AND s.expires_at > now()
          AND s.session_id = $2::uuid
      ) AS is_active
      `,
      [userId, sessionId],
    )
    return result.rows[0]?.is_active === true
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
}

/**
 * Mirrors public.verify_mfa() for Edge JWT-authenticated privileged actions.
 * API-key auth is a no-op because keys do not carry AAL claims.
 */
function isAllowedAal(aal: string, hasVerifiedMfa: boolean): boolean {
  if (hasVerifiedMfa) {
    return aal === 'aal2'
  }
  return aal === 'aal1' || aal === 'aal2'
}

export async function assertJwtMfaAssurance(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
): Promise<void> {
  if (auth.authType !== 'jwt' || !auth.userId) {
    return
  }

  const aal = getJwtAal(auth.claims)
  const hasVerifiedMfa = await userHasVerifiedMfaFactors(c, auth.userId)

  if (isAllowedAal(aal, hasVerifiedMfa)) {
    return
  }

  if (await isActivePlatformImpersonation(c, auth.userId, parseSessionId(auth.claims))) {
    return
  }

  throw quickError(
    403,
    'mfa_required',
    'Multi-factor authentication is required for this action',
  )
}
