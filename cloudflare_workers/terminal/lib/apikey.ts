import { Client } from 'pg'
import { sha256Hex } from './crypto.ts'

export { sha256Hex }

export interface PostgresHyperdrive {
  connectionString: string
}

export interface TerminalApiKeyContext {
  apikeyId: number
  userId: string
  rbacId: string
}

export const TERMINAL_APIKEY_MODES = ['write', 'all'] as const

export function assertTerminalApiKeyPolicy(allowedModes: boolean, appScoped: boolean): void {
  if (!allowedModes)
    throw new Error('apikey_app_forbidden')
  if (!appScoped)
    throw new Error('apikey_not_app_scoped')
}

export function assertApiKeyScopeExclusive(appScoped: boolean, orgScoped: boolean): void {
  if (appScoped && orgScoped)
    throw new Error('apikey_ambiguous_scope')
}

export async function validateApiKeyForApp(
  hyperdrive: PostgresHyperdrive,
  apiKey: string,
  orgId: string,
  appId: string,
): Promise<TerminalApiKeyContext> {
  const client = new Client({ connectionString: hyperdrive.connectionString })
  await client.connect()
  try {
    const keyRows = await client.query<{
      id: string
      user_id: string
      rbac_id: string
      expires_at: string | null
    }>(
      'SELECT id, user_id, rbac_id, expires_at FROM public.find_apikey_by_value($1::text)',
      [apiKey],
    )
    if (keyRows.rowCount !== 1)
      throw new Error('invalid_apikey')
    const row = keyRows.rows[0]!
    if (row.expires_at && new Date(row.expires_at) < new Date())
      throw new Error('apikey_expired')

    const allowed = await client.query<{ ok: boolean }>(
      `SELECT public.is_allowed_capgkey($1::text, $2::text[], $3::varchar) AS ok`,
      [apiKey, [...TERMINAL_APIKEY_MODES], appId],
    )

    const scoped = await client.query<{ app_ok: boolean, org_ok: boolean }>(
      `SELECT
        EXISTS (
          SELECT 1
          FROM public.role_bindings AS rb
          INNER JOIN public.apps AS a ON a.id = rb.app_id
          WHERE rb.principal_type = public.rbac_principal_apikey()
            AND rb.principal_id = $1::uuid
            AND rb.scope_type = public.rbac_scope_app()
            AND a.app_id = $2::varchar
            AND (rb.expires_at IS NULL OR rb.expires_at > pg_catalog.now())
        ) AS app_ok,
        EXISTS (
          SELECT 1
          FROM public.role_bindings AS rb
          WHERE rb.principal_type = public.rbac_principal_apikey()
            AND rb.principal_id = $1::uuid
            AND rb.scope_type = public.rbac_scope_org()
            AND rb.org_id::text = $3::text
            AND (rb.expires_at IS NULL OR rb.expires_at > pg_catalog.now())
        ) AS org_ok`,
      [row.rbac_id, appId, orgId],
    )
    const appScoped = Boolean(scoped.rows[0]?.app_ok)
    const orgScoped = Boolean(scoped.rows[0]?.org_ok)
    assertTerminalApiKeyPolicy(Boolean(allowed.rows[0]?.ok), appScoped)
    assertApiKeyScopeExclusive(appScoped, orgScoped)

    const orgRow = await client.query<{ owner_org: string }>(
      'SELECT owner_org FROM public.apps WHERE app_id = $1',
      [appId],
    )
    if (orgRow.rowCount !== 1 || orgRow.rows[0]!.owner_org !== orgId)
      throw new Error('app_org_mismatch')

    return {
      apikeyId: Number(row.id),
      userId: row.user_id,
      rbacId: row.rbac_id,
    }
  }
  finally {
    await client.end().catch(() => {})
  }
}

export async function reserveTerminalSession(
  hyperdrive: PostgresHyperdrive,
  input: {
    sessionKey: string
    orgId: string
    appId: string
    apikeyId: number
    maxDurationMinutes: number
    maxConcurrency: number
  },
): Promise<{ ok: boolean, error?: string, reused?: boolean, created?: boolean }> {
  const client = new Client({ connectionString: hyperdrive.connectionString })
  await client.connect()
  try {
    const result = await client.query<{ result: { ok: boolean, error?: string, reused?: boolean, created?: boolean } }>(
      `SELECT public.terminal_session_reserve(
      $1::text, $2::uuid, $3::text, $4::bigint, $5::integer, $6::integer
    ) AS result`,
      [
        input.sessionKey,
        input.orgId,
        input.appId,
        input.apikeyId,
        input.maxDurationMinutes,
        input.maxConcurrency,
      ],
    )
    const payload = result.rows[0]?.result
    if (!payload?.ok)
      return { ok: false, error: payload?.error ?? 'reserve_failed' }
    return {
      ok: true,
      reused: payload.reused === true,
      created: payload.created === true,
    }
  }
  finally {
    await client.end().catch(() => {})
  }
}

export async function setTerminalWsToken(
  hyperdrive: PostgresHyperdrive,
  sessionKey: string,
  tokenHash: string,
  ttlSeconds: number,
): Promise<boolean> {
  const client = new Client({ connectionString: hyperdrive.connectionString })
  await client.connect()
  try {
    const result = await client.query<{ ok: boolean }>(
      'SELECT public.terminal_session_set_ws_token($1::text, $2::text, $3::integer) AS ok',
      [sessionKey, tokenHash, ttlSeconds],
    )
    return Boolean(result.rows[0]?.ok)
  }
  finally {
    await client.end().catch(() => {})
  }
}

export async function consumeTerminalWsToken(
  hyperdrive: PostgresHyperdrive,
  sessionKey: string,
  tokenHash: string,
): Promise<boolean> {
  const client = new Client({ connectionString: hyperdrive.connectionString })
  await client.connect()
  try {
    const result = await client.query<{ ok: boolean }>(
      'SELECT public.terminal_session_consume_ws_token($1::text, $2::text) AS ok',
      [sessionKey, tokenHash],
    )
    return Boolean(result.rows[0]?.ok)
  }
  finally {
    await client.end().catch(() => {})
  }
}

export async function isTerminalSessionActive(
  hyperdrive: PostgresHyperdrive,
  sessionKey: string,
): Promise<boolean> {
  const client = new Client({ connectionString: hyperdrive.connectionString })
  await client.connect()
  try {
    const result = await client.query<{ active: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM public.terminal_sessions t
        WHERE t.session_key = $1::text
          AND t.status = 'active'
          AND t.started_at + make_interval(mins => t.max_duration_minutes) > pg_catalog.now()
      ) AS active`,
      [sessionKey],
    )
    return Boolean(result.rows[0]?.active)
  }
  finally {
    await client.end().catch(() => {})
  }
}

export async function finalizeTerminalSession(
  hyperdrive: PostgresHyperdrive,
  sessionKey: string,
  reason: string,
): Promise<{ billedMinutes: number, finalized: boolean }> {
  const client = new Client({ connectionString: hyperdrive.connectionString })
  await client.connect()
  try {
    const result = await client.query<{ minutes: number }>(
      'SELECT public.terminal_session_finish($1::text, $2::text) AS minutes',
      [sessionKey, reason],
    )
    const billedMinutes = result.rows[0]?.minutes ?? 0
    const stillActive = await isTerminalSessionActive(hyperdrive, sessionKey)
    return { billedMinutes, finalized: !stillActive }
  }
  finally {
    await client.end().catch(() => {})
  }
}

export async function finishTerminalSession(
  hyperdrive: PostgresHyperdrive,
  sessionKey: string,
  reason: string,
): Promise<number> {
  const { billedMinutes } = await finalizeTerminalSession(hyperdrive, sessionKey, reason)
  return billedMinutes
}
