import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { McpContext } from './oauth_shared.ts'
import { Hono } from 'hono/tiny'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { isIPRateLimited, recordFailedAuth } from '../utils/rate_limit.ts'
import { getEnv } from '../utils/utils.ts'
import {
  AGENT_POLL_INTERVAL_SECONDS,
  AGENT_REGISTRATION_TTL_SECONDS,
  AGENT_USER_CODE_TTL_SECONDS,
  createClaimKeyPair,
  generateUserCode,
  newClaimAttemptToken,
  newClaimToken,
  normalizeLoginHint,
  openWithClaimToken,
} from './agent_identity_utils.ts'
import { getClientIpHash, getIssuer, insertWithIpLimit, oauthError, readParams, withPg } from './oauth_shared.ts'
import { MCP_OAUTH_SCOPE, sha256Hex } from './oauth_utils.ts'

/**
 * auth.md agent registration (https://capgo.app/auth.md, protocol https://workos.com/auth-md v0.6).
 *
 * Capgo implements the service_auth method: the agent registers with the user's email, the user signs
 * in to the console, picks organizations and types the six-digit user_code, and the agent polls the
 * token endpoint with the claim grant. The access token is a regular Capgo API key minted by the user
 * on the console page, so RBAC, org API key policies and revocation all reuse the API key system.
 * Anonymous and ID-JAG registration are not offered: every Capgo action needs a user account.
 */
export const AGENT_IDENTITY_PATH = '/agent/identity'
export const AGENT_CLAIM_PAGE_PATH = '/agent/claim'
export const AGENT_AUTH_SKILL_URL = 'https://capgo.app/auth.md'
const LEGACY_VERIFIED_EMAIL_ASSERTION = 'verified_email'

const REGISTRATION_RATE_LIMIT = { limit: 10, windowSeconds: 60 * 60 }

/**
 * Registration endpoints live on the issuer origin (https://capgo.app in production, which forwards them
 * to this worker), so they share the origin of the auth.md document and of the metadata that lists them.
 */
function agentIdentityOrigin(c: Context): string {
  return getIssuer(c)
}

export function agentAuthMetadata(c: Context) {
  const identityEndpoint = `${agentIdentityOrigin(c)}${AGENT_IDENTITY_PATH}`
  const claimEndpoint = `${identityEndpoint}/claim`
  return {
    skill: AGENT_AUTH_SKILL_URL,
    identity_endpoint: identityEndpoint,
    claim_endpoint: claimEndpoint,
    // auth.md v0.1 names (register_uri / claim_uri, verified_email under identity_assertion), still read by
    // older agents and scanners. They describe the same endpoints and the same email-based flow.
    register_uri: identityEndpoint,
    claim_uri: claimEndpoint,
    identity_types_supported: ['service_auth', 'identity_assertion'],
    identity_assertion: {
      assertion_types_supported: [LEGACY_VERIFIED_EMAIL_ASSERTION],
      credential_types_supported: ['urn:ietf:params:oauth:token-type:access_token'],
    },
  }
}

/** Profile-specific error body at /agent/identity (auth.md "Errors"). */
function agentError(c: McpContext, status: 400 | 404 | 410 | 429 | 500 | 503, error: string, description: string) {
  c.header('Cache-Control', 'no-store')
  return c.json({ error, error_description: description }, status)
}

function getWebAppUrl(c: McpContext): string {
  return getEnv(c, 'WEBAPP_URL').replace(/\/+$/, '')
}

interface ClaimAttempt {
  claimAttemptToken: string
  userCode: string
  claimAttemptTokenHash: string
  userCodeHash: string
}

async function newClaimAttempt(): Promise<ClaimAttempt> {
  const claimAttemptToken = newClaimAttemptToken()
  const userCode = generateUserCode()
  return {
    claimAttemptToken,
    userCode,
    claimAttemptTokenHash: await sha256Hex(claimAttemptToken),
    userCodeHash: await sha256Hex(userCode),
  }
}

function claimBlock(webAppUrl: string, attempt: ClaimAttempt) {
  return {
    user_code: attempt.userCode,
    expires_in: AGENT_USER_CODE_TTL_SECONDS,
    verification_uri: `${webAppUrl}${AGENT_CLAIM_PAGE_PATH}?claim_attempt_token=${encodeURIComponent(attempt.claimAttemptToken)}`,
    interval: AGENT_POLL_INTERVAL_SECONDS,
  }
}

export const app = new Hono<MiddlewareKeyVariables>()

// ---------------------------------------------------------------------------
// Step 3: register. Only service_auth is enabled.
// ---------------------------------------------------------------------------
app.post(AGENT_IDENTITY_PATH, async (c) => {
  const params = await readParams(c)
  if (params.type === 'anonymous')
    return agentError(c, 400, 'anonymous_not_enabled', 'Capgo does not offer anonymous registration: every action needs a Capgo account. Use service_auth with the user\'s email.')
  // Before v0.6 the same email flow was sent as an identity_assertion of type verified_email.
  const legacyVerifiedEmail = params.type === 'identity_assertion' && params.assertion_type === LEGACY_VERIFIED_EMAIL_ASSERTION
  if (params.type === 'identity_assertion' && !legacyVerifiedEmail)
    return agentError(c, 400, 'issuer_not_enabled', 'Capgo does not trust any ID-JAG provider yet. Use service_auth with the user\'s email.')
  if (params.type !== 'service_auth' && !legacyVerifiedEmail)
    return agentError(c, 400, 'invalid_request', 'type must be service_auth')
  const loginHint = normalizeLoginHint(legacyVerifiedEmail ? params.assertion : params.login_hint)
  if (!loginHint)
    return agentError(c, 400, 'invalid_login_hint', `${legacyVerifiedEmail ? 'assertion' : 'login_hint'} must be the user's email address`)

  const webAppUrl = getWebAppUrl(c)
  if (!webAppUrl) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'agent_identity_missing_webapp_url' })
    return agentError(c, 503, 'temporarily_unavailable', 'Agent registration is not configured')
  }

  const claimToken = newClaimToken()
  const ipHash = await getClientIpHash(c)
  const created = await insertWithIpLimit(c, 'agent_identity_registrations', ipHash, REGISTRATION_RATE_LIMIT, async (tx) => {
    // Key generation runs only after the per-IP limit passed, so rejected floods cost no crypto work.
    const [keys, attempt, claimTokenHash] = await Promise.all([createClaimKeyPair(claimToken), newClaimAttempt(), sha256Hex(claimToken)])
    // An approved registration the agent never collected left a live key behind: revoke it with the row.
    await tx.query(
      `DELETE FROM public.apikeys WHERE id IN (
         SELECT apikey_id FROM public.agent_identity_registrations
         WHERE status = 'approved' AND apikey_id IS NOT NULL AND expires_at < now() - interval '1 day')`,
    )
    await tx.query(`DELETE FROM public.agent_identity_registrations WHERE status <> 'exchanged' AND expires_at < now() - interval '1 day'`)
    // IP hashes only feed the hourly registration limit: drop them once they are a day old.
    await tx.query(`UPDATE public.agent_identity_registrations SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < now() - interval '1 day'`)
    const { rows } = await tx.query<{ id: string, expires_at: Date }>(
      `INSERT INTO public.agent_identity_registrations
         (login_hint, claim_token_hash, public_key, encrypted_private_key, claim_attempt_token_hash, user_code_hash,
          user_code_expires_at, ip_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), $8, now() + make_interval(secs => $9))
       RETURNING id, expires_at`,
      [loginHint, claimTokenHash, keys.publicKey, keys.encryptedPrivateKey, attempt.claimAttemptTokenHash, attempt.userCodeHash, AGENT_USER_CODE_TTL_SECONDS, ipHash, AGENT_REGISTRATION_TTL_SECONDS],
    )
    return rows[0] ? { row: rows[0], attempt } : null
  })
  if (!created)
    return agentError(c, 429, 'rate_limited', 'Too many registrations, try again later')
  const { row, attempt } = created

  cloudlog({ requestId: c.get('requestId'), message: 'agent_identity_registered', registrationId: row.id })
  c.header('Cache-Control', 'no-store')
  return c.json({
    registration_id: `reg_${row.id}`,
    registration_type: 'service_auth',
    claim_url: `${agentIdentityOrigin(c)}${AGENT_IDENTITY_PATH}/claim`,
    claim_token: claimToken,
    claim_token_expires: new Date(row.expires_at).toISOString(),
    post_claim_scopes: [MCP_OAUTH_SCOPE],
    claim: claimBlock(webAppUrl, attempt),
  })
})

// ---------------------------------------------------------------------------
// Step 4a: mint a fresh user_code when the previous one expired. The email must match the registration.
// ---------------------------------------------------------------------------
app.post(`${AGENT_IDENTITY_PATH}/claim`, async (c) => {
  // Invalid claim tokens count as failed auth: stop flagged IPs before parsing or querying.
  if ((await isIPRateLimited(c)).limited)
    return agentError(c, 429, 'rate_limited', 'Too many failed attempts, try again later')
  const params = await readParams(c)
  const claimToken = params.claim_token ?? ''
  const email = normalizeLoginHint(params.email)
  if (!claimToken || !email)
    return agentError(c, 400, 'invalid_request', 'claim_token and email are required')
  const webAppUrl = getWebAppUrl(c)
  if (!webAppUrl)
    return agentError(c, 503, 'temporarily_unavailable', 'Agent registration is not configured')

  const claimTokenHash = await sha256Hex(claimToken)
  const attempt = await newClaimAttempt()
  const result = await withPg(c, async (pg) => {
    const { rows } = await pg.query<{ id: string, status: string, login_hint: string, expired: boolean }>(
      `SELECT id, status, login_hint, expires_at <= now() AS expired
       FROM public.agent_identity_registrations WHERE claim_token_hash = $1`,
      [claimTokenHash],
    )
    const registration = rows[0]
    if (!registration || registration.login_hint !== email)
      return { error: 'invalid_claim_token' as const }
    if (registration.expired)
      return { error: 'claim_expired' as const }
    if (registration.status !== 'pending')
      return { error: 'claimed_or_in_flight' as const }
    const updated = await pg.query<{ expires_at: Date }>(
      `UPDATE public.agent_identity_registrations
       SET claim_attempt_token_hash = $2, user_code_hash = $3, user_code_attempts = 0, code_verified_by = NULL,
           user_code_expires_at = now() + make_interval(secs => $4)
       WHERE id = $1 AND status = 'pending' AND expires_at > now()
       RETURNING expires_at`,
      [registration.id, attempt.claimAttemptTokenHash, attempt.userCodeHash, AGENT_USER_CODE_TTL_SECONDS],
    )
    return updated.rows[0] ? { id: registration.id, expiresAt: updated.rows[0].expires_at } : { error: 'claimed_or_in_flight' as const }
  })

  if ('error' in result) {
    if (result.error === 'invalid_claim_token') {
      await recordFailedAuth(c)
      return agentError(c, 400, 'invalid_claim_token', 'claim_token is unknown or does not match this email. Register again.')
    }
    if (result.error === 'claim_expired')
      return agentError(c, 410, 'claim_expired', 'The registration expired before it was claimed. Register again.')
    return agentError(c, 400, 'claimed_or_in_flight', 'This registration was already approved, denied or exchanged.')
  }

  c.header('Cache-Control', 'no-store')
  return c.json({
    registration_id: `reg_${result.id}`,
    claim_attempt_id: `cla_${attempt.claimAttemptTokenHash.slice(0, 24)}`,
    status: 'initiated',
    expires_at: new Date(result.expiresAt).toISOString(),
    claim_attempt: claimBlock(webAppUrl, attempt),
  })
})

// ---------------------------------------------------------------------------
// Step 4c: claim grant at the token endpoint (RFC 8628 §3.5 error vocabulary).
// ---------------------------------------------------------------------------
interface ClaimGrantRow {
  id: string
  status: string
  expired: boolean
  code_expired: boolean
  polled_too_fast: boolean
}

export async function handleAgentClaimGrant(c: McpContext, params: Record<string, string>) {
  const claimToken = params.claim_token ?? ''
  if (!claimToken)
    return oauthError(c, 400, 'invalid_request', 'claim_token is required')
  const claimTokenHash = await sha256Hex(claimToken)

  const outcome = await withPg(c, async (pg) => {
    // Atomically take the approved key out: FOR UPDATE makes a concurrent poll re-check the status and miss.
    const exchanged = await pg.query<{ id: string, encrypted_token: string, encrypted_private_key: string, apikey_expires_at: Date | null }>(
      `WITH target AS (
         SELECT id, encrypted_token, encrypted_private_key, apikey_id
         FROM public.agent_identity_registrations
         WHERE claim_token_hash = $1 AND status = 'approved' AND expires_at > now()
         FOR UPDATE
       )
       UPDATE public.agent_identity_registrations r
       -- The email is only needed until the claim completes; the apikey_id link stays for revocation.
       SET status = 'exchanged', exchanged_at = now(), encrypted_token = NULL, encrypted_private_key = '', login_hint = ''
       FROM target
       WHERE r.id = target.id
       RETURNING r.id, target.encrypted_token, target.encrypted_private_key,
         (SELECT a.expires_at FROM public.apikeys a WHERE a.id = target.apikey_id) AS apikey_expires_at`,
      [claimTokenHash],
    )
    if (exchanged.rows[0])
      return { kind: 'approved' as const, row: exchanged.rows[0] }

    // Record the poll, comparing against the previous poll time for slow_down.
    const { rows } = await pg.query<ClaimGrantRow>(
      `WITH previous AS (
         SELECT id, last_polled_at FROM public.agent_identity_registrations WHERE claim_token_hash = $1 FOR UPDATE
       )
       UPDATE public.agent_identity_registrations r
       SET last_polled_at = now()
       FROM previous
       WHERE r.id = previous.id
       RETURNING r.id, r.status, r.expires_at <= now() AS expired,
         (r.user_code_expires_at IS NULL OR r.user_code_expires_at <= now()) AS code_expired,
         (previous.last_polled_at IS NOT NULL AND previous.last_polled_at > now() - make_interval(secs => $2)) AS polled_too_fast`,
      [claimTokenHash, AGENT_POLL_INTERVAL_SECONDS - 1],
    )
    return { kind: 'state' as const, row: rows[0] ?? null }
  })

  if (outcome.kind === 'approved') {
    const accessToken = await openWithClaimToken(outcome.row.encrypted_token, outcome.row.encrypted_private_key, claimToken)
    if (!accessToken) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'agent_identity_token_open_failed', registrationId: outcome.row.id })
      return oauthError(c, 400, 'invalid_grant', 'The claimed credential could not be opened. Register again.')
    }
    const expiresIn = outcome.row.apikey_expires_at
      ? Math.max(0, Math.floor((new Date(outcome.row.apikey_expires_at).getTime() - Date.now()) / 1000))
      : undefined
    cloudlog({ requestId: c.get('requestId'), message: 'agent_identity_token_issued', registrationId: outcome.row.id })
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      scope: MCP_OAUTH_SCOPE,
      ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
    })
  }

  const row = outcome.row
  if (!row || row.status === 'exchanged') {
    await recordFailedAuth(c)
    return oauthError(c, 400, 'invalid_grant', 'claim_token is invalid or was already exchanged. Register again.')
  }
  if (row.status === 'denied')
    return oauthError(c, 400, 'access_denied', 'The user denied the registration')
  if (row.expired || row.code_expired)
    return oauthError(c, 400, 'expired_token', 'The user_code or the registration expired. Call the claim endpoint for a fresh user_code, or register again.')
  if (row.polled_too_fast)
    return oauthError(c, 400, 'slow_down', `Poll at most every ${AGENT_POLL_INTERVAL_SECONDS} seconds`)
  return oauthError(c, 400, 'authorization_pending', 'The user has not completed the claim yet')
}
