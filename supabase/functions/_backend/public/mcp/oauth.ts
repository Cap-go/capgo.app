import type { Context } from 'hono'
import { closeClient, getPgClient, withPgTransaction } from '../../utils/pg.ts'
import { supabaseAdmin } from '../../utils/supabase.ts'
import { capgoApiRoot, isUuid, pkceS256, randomToken, resolvePublicRequestUrl, sha256Hex, validateCodeVerifier, validateRedirectUri, AUTH_CODE_TTL_SECONDS, ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from './protocol.ts'

interface QueryClient {
  query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[], rowCount?: number | null }>
}

export interface OAuthClientRow {
  client_id: string
  client_name: string
  redirect_uris: string[]
}

export interface IssuedTokens {
  access_token: string
  refresh_token: string
  expires_in: number
}

export interface ResolvedAccess {
  apiKey: string
  userId: string
  keyId: number
  keyName: string
  expiresAt: string | null
}

function redirectList(value: unknown): string[] {
  if (!Array.isArray(value))
    return []
  return value.filter((item): item is string => typeof item === 'string')
}

async function withPool<T>(c: Context, run: (query: QueryClient) => Promise<T>): Promise<T> {
  const pool = getPgClient(c, false)
  try {
    return await run(pool)
  }
  finally {
    await closeClient(c, pool)
  }
}

export function validateRegistration(body: unknown): { name: string, redirectUris: string[] } | { error: string } {
  if (!body || typeof body !== 'object')
    return { error: 'client metadata must be a JSON object' }
  const record = body as Record<string, unknown>
  const name = typeof record.client_name === 'string' ? record.client_name.trim() : ''
  if (!name || name.length > 80)
    return { error: 'client_name is required and must be at most 80 characters' }
  if (record.token_endpoint_auth_method != null && record.token_endpoint_auth_method !== 'none')
    return { error: 'only public clients (token_endpoint_auth_method=none) are supported' }
  if (!Array.isArray(record.redirect_uris) || record.redirect_uris.length === 0 || record.redirect_uris.length > 10)
    return { error: 'redirect_uris must contain 1 to 10 URLs' }
  const redirectUris: string[] = []
  for (const uri of record.redirect_uris) {
    if (typeof uri !== 'string')
      return { error: 'redirect_uris must be strings' }
    const problem = validateRedirectUri(uri)
    if (problem)
      return { error: problem }
    redirectUris.push(uri)
  }
  return { name, redirectUris }
}

export async function registerOAuthClient(c: Context, name: string, redirectUris: string[]): Promise<OAuthClientRow> {
  const clientId = randomToken('capgo_mcp_client_')
  return await withPool(c, async (pool) => {
    await pool.query(
      `DELETE FROM public.mcp_oauth_codes WHERE code_hash IN (
         SELECT code_hash FROM public.mcp_oauth_codes WHERE expires_at < now() LIMIT 100
       )`,
    )
    const result = await pool.query<OAuthClientRow>(
      `INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris)
       VALUES ($1, $2, $3::jsonb)
       RETURNING client_id, client_name, redirect_uris`,
      [clientId, name, JSON.stringify(redirectUris)],
    )
    const row = result.rows[0]
    return { ...row, redirect_uris: redirectList(row?.redirect_uris) }
  })
}

export async function getOAuthClient(c: Context, clientId: string): Promise<OAuthClientRow | null> {
  if (!clientId.startsWith('capgo_mcp_client_'))
    return null
  return await withPool(c, async (pool) => {
    const result = await pool.query<OAuthClientRow>(
      `SELECT client_id, client_name, redirect_uris FROM public.mcp_oauth_clients WHERE client_id = $1`,
      [clientId],
    )
    const row = result.rows[0]
    if (!row)
      return null
    return { ...row, redirect_uris: redirectList(row.redirect_uris) }
  })
}

export function clientAllowsRedirect(client: OAuthClientRow, redirectUri: string): boolean {
  return client.redirect_uris.includes(redirectUri) && validateRedirectUri(redirectUri) == null
}

export async function keyExpiresAt(c: Context, orgId: string): Promise<string | null> {
  const { data } = await supabaseAdmin(c)
    .from('orgs')
    .select('require_apikey_expiration, max_apikey_expiration_days')
    .eq('id', orgId)
    .maybeSingle()
  const required = data?.require_apikey_expiration === true
  const maxDays = typeof data?.max_apikey_expiration_days === 'number' && data.max_apikey_expiration_days > 0
    ? data.max_apikey_expiration_days
    : null
  if (!required && maxDays == null)
    return null
  const days = maxDays == null ? 30 : Math.min(maxDays, 30)
  const expires = new Date()
  expires.setUTCDate(expires.getUTCDate() + days)
  return expires.toISOString()
}

export async function mintMcpApiKey(c: Context, userJwt: string, orgId: string, clientName: string, expiresAt: string | null): Promise<{ id: number, key: string }> {
  const response = await fetch(`${capgoApiRoot(resolvePublicRequestUrl(c.req.url, c.req.header('x-capgo-mcp-public-url')))}/apikey`, {
    method: 'POST',
    headers: {
      Authorization: userJwt.startsWith('Bearer ') ? userJwt : `Bearer ${userJwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: `MCP ${clientName}`.slice(0, 80),
      hashed: false,
      expires_at: expiresAt,
      bindings: [{ role_name: 'org_admin', scope_type: 'org', org_id: orgId }],
    }),
  })
  const body = await response.json().catch(() => null) as { id?: number | string, key?: string, message?: string, error?: string } | null
  if (!response.ok || !body?.key || body.id == null) {
    const message = body?.message || body?.error || `Could not create an API key (${response.status})`
    throw new Error(message)
  }
  return { id: Number(body.id), key: body.key }
}

export async function storeAuthCode(c: Context, input: {
  clientId: string
  userId: string
  apikeyId: number
  redirectUri: string
  codeChallenge: string
  resource: string
}): Promise<string> {
  const code = randomToken('capgo_mcp_code_')
  const codeHash = await sha256Hex(code)
  await withPool(c, async (pool) => {
    await pool.query(
      `INSERT INTO public.mcp_oauth_codes
        (code_hash, client_id, user_id, apikey_id, redirect_uri, code_challenge, resource, expires_at)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, now() + ($8::int * interval '1 second'))`,
      [codeHash, input.clientId, input.userId, input.apikeyId, input.redirectUri, input.codeChallenge, input.resource, AUTH_CODE_TTL_SECONDS],
    )
  })
  return code
}

interface CodeRow {
  client_id: string
  user_id: string
  apikey_id: number | string
  redirect_uri: string
  code_challenge: string
  resource: string
}

export async function consumeAuthCode(c: Context, code: string, clientId: string, redirectUri: string, verifier: string, resource: string | null): Promise<CodeRow> {
  const verifierError = validateCodeVerifier(verifier)
  if (verifierError)
    throw new Error(verifierError)
  const codeHash = await sha256Hex(code)
  const challenge = await pkceS256(verifier)
  const row = await withPool(c, async (pool) => {
    const result = await pool.query<CodeRow>(
      `UPDATE public.mcp_oauth_codes
       SET used_at = now()
       WHERE code_hash = $1
         AND used_at IS NULL
         AND expires_at > now()
         AND client_id = $2
         AND redirect_uri = $3
       RETURNING client_id, user_id, apikey_id, redirect_uri, code_challenge, resource`,
      [codeHash, clientId, redirectUri],
    )
    return result.rows[0] ?? null
  })
  if (!row || row.code_challenge !== challenge)
    throw new Error('invalid_grant')
  if (resource && resource !== row.resource)
    throw new Error('invalid_target')
  return row
}

export async function issueTokenPair(c: Context, clientId: string, userId: string, apikeyId: number): Promise<IssuedTokens> {
  const accessToken = randomToken('capgo_mcp_at_')
  const refreshToken = randomToken('capgo_mcp_rt_')
  const accessHash = await sha256Hex(accessToken)
  const refreshHash = await sha256Hex(refreshToken)
  await withPool(c, async (pool) => {
    await pool.query(
      `INSERT INTO public.mcp_oauth_tokens
        (access_token_hash, refresh_token_hash, client_id, user_id, apikey_id, access_expires_at, refresh_expires_at)
       VALUES ($1, $2, $3, $4::uuid, $5, now() + ($6::int * interval '1 second'), now() + ($7::int * interval '1 second'))`,
      [accessHash, refreshHash, clientId, userId, apikeyId, ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS],
    )
  })
  return { access_token: accessToken, refresh_token: refreshToken, expires_in: ACCESS_TOKEN_TTL_SECONDS }
}

export async function rotateRefreshToken(c: Context, refreshToken: string, clientId: string): Promise<IssuedTokens> {
  const refreshHash = await sha256Hex(refreshToken)
  const pool = getPgClient(c, false)
  try {
    const existing = await withPgTransaction(pool, async (client) => {
      const result = await client.query<{ client_id: string, user_id: string, apikey_id: number | string }>(
        `UPDATE public.mcp_oauth_tokens
         SET revoked_at = now()
         WHERE refresh_token_hash = $1
           AND client_id = $2
           AND revoked_at IS NULL
           AND refresh_expires_at > now()
         RETURNING client_id, user_id::text AS user_id, apikey_id`,
        [refreshHash, clientId],
      )
      const row = result.rows[0]
      if (!row)
        return null
      const accessToken = randomToken('capgo_mcp_at_')
      const nextRefresh = randomToken('capgo_mcp_rt_')
      await client.query(
        `INSERT INTO public.mcp_oauth_tokens
          (access_token_hash, refresh_token_hash, client_id, user_id, apikey_id, access_expires_at, refresh_expires_at)
         VALUES ($1, $2, $3, $4::uuid, $5, now() + ($6::int * interval '1 second'), now() + ($7::int * interval '1 second'))`,
        [await sha256Hex(accessToken), await sha256Hex(nextRefresh), row.client_id, row.user_id, Number(row.apikey_id), ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS],
      )
      return { access_token: accessToken, refresh_token: nextRefresh, expires_in: ACCESS_TOKEN_TTL_SECONDS }
    })
    if (!existing)
      throw new Error('invalid_grant')
    return existing
  }
  finally {
    await closeClient(c, pool)
  }
}

export async function revokeOAuthToken(c: Context, token: string): Promise<void> {
  const hash = await sha256Hex(token)
  await withPool(c, async (pool) => {
    await pool.query(
      `UPDATE public.mcp_oauth_tokens
       SET revoked_at = now()
       WHERE revoked_at IS NULL
         AND (access_token_hash = $1 OR refresh_token_hash = $1)`,
      [hash],
    )
  })
}

export async function resolveOAuthAccessToken(c: Context, accessToken: string): Promise<ResolvedAccess | null> {
  if (!accessToken.startsWith('capgo_mcp_at_'))
    return null
  const hash = await sha256Hex(accessToken)
  return await withPool(c, async (pool) => {
    const result = await pool.query<{ user_id: string, apikey_id: number | string, key: string, name: string, expires_at: string | null }>(
      `SELECT t.user_id::text, t.apikey_id, a.key, a.name, a.expires_at
       FROM public.mcp_oauth_tokens t
       JOIN public.apikeys a ON a.id = t.apikey_id
       WHERE t.access_token_hash = $1
         AND t.revoked_at IS NULL
         AND t.access_expires_at > now()
         AND a.key IS NOT NULL
         AND (a.expires_at IS NULL OR a.expires_at > now())`,
      [hash],
    )
    const row = result.rows[0]
    if (!row?.key)
      return null
    return {
      apiKey: row.key,
      userId: row.user_id,
      keyId: Number(row.apikey_id),
      keyName: row.name,
      expiresAt: row.expires_at,
    }
  })
}

export function assertOrgId(orgId: string): boolean {
  return isUuid(orgId)
}
