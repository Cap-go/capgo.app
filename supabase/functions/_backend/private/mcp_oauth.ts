import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../utils/hono.ts'
import { z } from 'zod'
import { buildRedirectUrl, encryptWithCode, MCP_OAUTH_CODE_TTL_SECONDS, randomToken, sha256Hex } from '../mcp/oauth_utils.ts'
import { honoFactory, parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { checkKey, supabaseAdmin } from '../utils/supabase.ts'

/**
 * Console-side half of the hosted MCP OAuth flow (see mcp/oauth.ts).
 * The consent page reads the pending request, mints a normal API key for the user through
 * POST /apikey (so MFA, org key policies and RBAC bindings all apply), then approves here.
 */
export const app = honoFactory.createApp()

app.use('*', useCors)

const MCP_OAUTH_KEY_MAX_DAYS = 90
// One extra day of slack for client clocks.
const MCP_OAUTH_KEY_MAX_LIFETIME_MS = (MCP_OAUTH_KEY_MAX_DAYS + 1) * 86_400_000
const requestIdSchema = z.string().uuid()
const approveSchema = z.object({ request: requestIdSchema, apikey: z.string().min(1).max(512) })
const denySchema = z.object({ request: requestIdSchema })

interface PendingRequestRow {
  id: string
  client_id: string
  client_name: string
  redirect_uri: string
  state: string | null
  scope: string | null
  status: string
  expires_at: string
}

function requireUserSession(c: Context<MiddlewareKeyVariables>): AuthInfo {
  const auth = c.get('auth') as AuthInfo | undefined
  if (!auth?.userId || auth.authType !== 'jwt')
    throw quickError(401, 'not_authorized', 'MCP authorization requires a signed-in console session')
  return auth
}

async function withPg<T>(c: Context<MiddlewareKeyVariables>, fn: (pg: ReturnType<typeof getPgClient>) => Promise<T>): Promise<T> {
  const pg = getPgClient(c)
  try {
    return await fn(pg)
  }
  finally {
    await closeClient(c, pg)
  }
}

app.get('/', middlewareAuth(), async (c) => {
  requireUserSession(c)
  const parsed = safeParseSchema(requestIdSchema, c.req.query('request'))
  if (!parsed.success)
    throw simpleError('invalid_request', 'Invalid authorization request id')

  const row = await withPg(c, async (pg) => {
    const { rows } = await pg.query<PendingRequestRow>(
      `SELECT id, client_id, client_name, redirect_uri, state, scope, status, expires_at
       FROM public.mcp_oauth_requests WHERE id = $1`,
      [parsed.data],
    )
    return rows[0]
  })
  if (!row)
    throw quickError(404, 'request_not_found', 'Authorization request not found')
  if (row.status !== 'pending' || new Date(row.expires_at).getTime() <= Date.now())
    throw quickError(410, 'request_expired', 'This authorization request has expired. Start the connection again from your MCP client.')

  const redirect = new URL(row.redirect_uri)
  return c.json({
    request: row.id,
    client_id: row.client_id,
    client_name: row.client_name,
    redirect_uri: row.redirect_uri,
    // Custom-scheme redirects (cursor://, vscode://) show the scheme too so the user sees which app receives the code.
    redirect_host: redirect.protocol === 'http:' || redirect.protocol === 'https:' ? redirect.host : `${redirect.protocol}//${redirect.host}`,
    scope: row.scope,
    expires_at: row.expires_at,
  })
})

app.post('/approve', middlewareAuth(), async (c) => {
  const auth = requireUserSession(c)
  const parsed = safeParseSchema(approveSchema, await parseBody<unknown>(c))
  if (!parsed.success)
    throw simpleError('invalid_request', 'Invalid approve body')

  // The key must be one the signed-in user just created: never hand out someone else's key.
  const apikey = await checkKey(c, parsed.data.apikey, supabaseAdmin(c))
  if (!apikey || apikey.user_id !== auth.userId)
    throw quickError(403, 'invalid_apikey', 'The API key does not belong to the signed-in user')
  // Tokens handed to third-party clients must expire: the consent page sets at most 90 days.
  const expiresAt = apikey.expires_at ? new Date(apikey.expires_at).getTime() : Number.NaN
  if (!Number.isFinite(expiresAt) || expiresAt > Date.now() + MCP_OAUTH_KEY_MAX_LIFETIME_MS)
    throw quickError(400, 'apikey_expiration_required', `MCP API keys must expire within ${MCP_OAUTH_KEY_MAX_DAYS} days`)

  const code = randomToken(32)
  const codeHash = await sha256Hex(code)
  const encryptedToken = await encryptWithCode(parsed.data.apikey, code)

  const row = await withPg(c, async (pg) => {
    const { rows } = await pg.query<{ redirect_uri: string, state: string | null, client_id: string, issuer: string }>(
      `UPDATE public.mcp_oauth_requests
       SET status = 'approved', user_id = $2, apikey_id = $3, code_hash = $4, encrypted_token = $5,
           code_expires_at = now() + make_interval(secs => $6)
       WHERE id = $1 AND status = 'pending' AND expires_at > now()
       RETURNING redirect_uri, state, client_id, issuer`,
      [parsed.data.request, auth.userId, apikey.id, codeHash, encryptedToken, MCP_OAUTH_CODE_TTL_SECONDS],
    )
    return rows[0]
  })
  if (!row)
    throw quickError(410, 'request_expired', 'This authorization request has expired. Start the connection again from your MCP client.')

  cloudlog({ requestId: c.get('requestId'), message: 'mcp_oauth_request_approved', clientId: row.client_id, apikeyId: apikey.id })
  return c.json({
    // RFC 9207: iss must be the authorization server issuer seen by the client, not this console API origin.
    redirect_to: buildRedirectUrl(row.redirect_uri, { code, state: row.state, iss: row.issuer }),
  })
})

app.post('/deny', middlewareAuth(), async (c) => {
  requireUserSession(c)
  const parsed = safeParseSchema(denySchema, await parseBody<unknown>(c))
  if (!parsed.success)
    throw simpleError('invalid_request', 'Invalid deny body')

  const row = await withPg(c, async (pg) => {
    const { rows } = await pg.query<{ redirect_uri: string, state: string | null, issuer: string }>(
      `UPDATE public.mcp_oauth_requests SET status = 'denied'
       WHERE id = $1 AND status = 'pending'
       RETURNING redirect_uri, state, issuer`,
      [parsed.data.request],
    )
    return rows[0]
  })
  if (!row)
    throw quickError(410, 'request_expired', 'This authorization request has expired')

  return c.json({
    redirect_to: buildRedirectUrl(row.redirect_uri, {
      error: 'access_denied',
      error_description: 'The user denied access',
      state: row.state,
      iss: row.issuer,
    }),
  })
})
