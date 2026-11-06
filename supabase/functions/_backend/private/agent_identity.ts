import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { z } from 'zod'
import { AGENT_USER_CODE_MAX_ATTEMPTS, maskEmail, sealToClaimKey } from '../mcp/agent_identity_utils.ts'
import { sha256Hex, timingSafeEqual } from '../mcp/oauth_utils.ts'
import { honoFactory, parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getPgClient, withPgTransaction } from '../utils/pg.ts'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { requireDelegatableApiKey, requireUserSession } from './mcp_oauth.ts'

/**
 * Console-side half of auth.md agent registration (see mcp/agent_identity.ts).
 * The claim page shows the pending registration, checks the user_code the agent gave the user,
 * mints a normal API key through POST /apikey (so MFA, org key policies and RBAC bindings apply),
 * then approves here. The key is sealed so only the agent holding the claim_token can open it.
 */
export const app = honoFactory.createApp()

app.use('*', useCors)

const attemptTokenSchema = z.string().min(20).max(200)
const verifySchema = z.object({ claim_attempt_token: attemptTokenSchema, user_code: z.string().regex(/^\d{6}$/) })
const approveSchema = z.object({ claim_attempt_token: attemptTokenSchema, apikey: z.string().min(1).max(512) })
const denySchema = z.object({ claim_attempt_token: attemptTokenSchema })

const EXPIRED_MESSAGE = 'This agent request expired or was already used. Ask the agent to start again.'

interface RegistrationRow {
  id: string
  login_hint: string
  status: string
  public_key: string
  user_code_hash: string | null
  user_code_attempts: number
  code_verified_by: string | null
  usable: boolean
  expires_at: Date
}

type Pg = Awaited<ReturnType<typeof getPgClient>>

async function withPg<T>(c: Context<MiddlewareKeyVariables>, fn: (pg: Pg) => Promise<T>): Promise<T> {
  const pg = await getPgClient(c)
  try {
    return await fn(pg)
  }
  finally {
    await closeClient(c, pg)
  }
}

async function findRegistration(pg: Pick<Pg, 'query'>, claimAttemptToken: string, lock = false): Promise<RegistrationRow | null> {
  const { rows } = await pg.query<RegistrationRow>(
    `SELECT id, login_hint, status, public_key, user_code_hash, user_code_attempts, code_verified_by, expires_at,
       (status = 'pending' AND expires_at > now() AND user_code_expires_at > now()) AS usable
     FROM public.agent_identity_registrations WHERE claim_attempt_token_hash = $1${lock ? ' FOR UPDATE' : ''}`,
    [await sha256Hex(claimAttemptToken)],
  )
  return rows[0] ?? null
}

async function getUserEmail(pg: Pick<Pg, 'query'>, userId: string): Promise<string> {
  const { rows } = await pg.query<{ email: string | null }>('SELECT email FROM auth.users WHERE id = $1', [userId])
  return (rows[0]?.email ?? '').trim().toLowerCase()
}

app.get('/', middlewareAuth(), async (c) => {
  const auth = requireUserSession(c)
  const parsed = safeParseSchema(attemptTokenSchema, c.req.query('claim_attempt_token'))
  if (!parsed.success)
    throw simpleError('invalid_request', 'Invalid claim_attempt_token')

  const { registration, email } = await withPg(c, async pg => ({
    registration: await findRegistration(pg, parsed.data),
    email: await getUserEmail(pg, auth.userId),
  }))
  if (!registration?.usable)
    throw quickError(410, 'request_expired', EXPIRED_MESSAGE)

  return c.json({
    registration_id: `reg_${registration.id}`,
    // Only the account the agent named can claim it: tell the user which one without leaking it in full.
    login_hint: maskEmail(registration.login_hint),
    email_matches: registration.login_hint === email,
    expires_at: registration.expires_at,
  })
})

app.post('/verify', middlewareAuth(), async (c) => {
  const auth = requireUserSession(c)
  const parsed = safeParseSchema(verifySchema, await parseBody<unknown>(c))
  if (!parsed.success)
    throw simpleError('invalid_request', 'Invalid verify body')

  const codeHash = await sha256Hex(parsed.data.user_code)
  const result = await withPg(c, pg => withPgTransaction(pg, async (tx) => {
    const registration = await findRegistration(tx, parsed.data.claim_attempt_token, true)
    if (!registration?.usable || registration.user_code_attempts >= AGENT_USER_CODE_MAX_ATTEMPTS)
      return 'expired' as const
    if (registration.login_hint !== await getUserEmail(tx, auth.userId))
      return 'wrong_account' as const
    if (!registration.user_code_hash || !timingSafeEqual(registration.user_code_hash, codeHash)) {
      await tx.query('UPDATE public.agent_identity_registrations SET user_code_attempts = user_code_attempts + 1 WHERE id = $1', [registration.id])
      return 'wrong_code' as const
    }
    await tx.query('UPDATE public.agent_identity_registrations SET code_verified_by = $2 WHERE id = $1', [registration.id, auth.userId])
    return 'verified' as const
  }))

  if (result === 'expired')
    throw quickError(410, 'request_expired', EXPIRED_MESSAGE)
  if (result === 'wrong_account')
    throw quickError(403, 'wrong_account', 'This agent request is for another Capgo account')
  if (result === 'wrong_code')
    throw quickError(400, 'invalid_user_code', 'The code does not match the one the agent showed you')
  return c.json({ status: 'verified' })
})

app.post('/approve', middlewareAuth(), async (c) => {
  const auth = requireUserSession(c)
  const parsed = safeParseSchema(approveSchema, await parseBody<unknown>(c))
  if (!parsed.success)
    throw simpleError('invalid_request', 'Invalid approve body')

  const apikey = await requireDelegatableApiKey(c, auth.userId, parsed.data.apikey)
  const approved = await withPg(c, pg => withPgTransaction(pg, async (tx) => {
    const registration = await findRegistration(tx, parsed.data.claim_attempt_token, true)
    // The user_code must have been verified by this same user first.
    if (!registration?.usable || registration.code_verified_by !== auth.userId)
      return null
    const sealed = await sealToClaimKey(registration.public_key, parsed.data.apikey)
    await tx.query(
      `UPDATE public.agent_identity_registrations
       SET status = 'approved', approved_at = now(), user_id = $2, apikey_id = $3, encrypted_token = $4,
           claim_attempt_token_hash = NULL, user_code_hash = NULL
       WHERE id = $1`,
      [registration.id, auth.userId, apikey.id, sealed],
    )
    return registration.id
  }))
  if (!approved)
    throw quickError(410, 'request_expired', EXPIRED_MESSAGE)

  cloudlog({ requestId: c.get('requestId'), message: 'agent_identity_approved', registrationId: approved, apikeyId: apikey.id })
  return c.json({ status: 'approved' })
})

app.post('/deny', middlewareAuth(), async (c) => {
  const auth = requireUserSession(c)
  const parsed = safeParseSchema(denySchema, await parseBody<unknown>(c))
  if (!parsed.success)
    throw simpleError('invalid_request', 'Invalid deny body')

  const result = await withPg(c, pg => withPgTransaction(pg, async (tx) => {
    const registration = await findRegistration(tx, parsed.data.claim_attempt_token, true)
    if (!registration || registration.status !== 'pending')
      return 'expired' as const
    // Only the named account can deny, so a stranger holding the link cannot cancel someone else's request.
    if (registration.login_hint !== await getUserEmail(tx, auth.userId))
      return 'wrong_account' as const
    await tx.query(
      `UPDATE public.agent_identity_registrations
       SET status = 'denied', claim_attempt_token_hash = NULL, user_code_hash = NULL
       WHERE id = $1`,
      [registration.id],
    )
    return 'denied' as const
  }))
  if (result === 'expired')
    throw quickError(410, 'request_expired', EXPIRED_MESSAGE)
  if (result === 'wrong_account')
    throw quickError(403, 'wrong_account', 'This agent request is for another Capgo account')
  return c.json({ status: 'denied' })
})
