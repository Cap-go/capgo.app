import type { Context } from 'hono'
import type { AuthInfo, JWTClaims } from './hono.ts'
import type { PgClient, PgQueryClient } from './pg.ts'
import { simpleError } from './hono.ts'
import { closeClient, getDrizzleClient, getPgClient, withPgTransaction } from './pg.ts'

/**
 * Who a direct Postgres statement runs as, mirroring the supabase-js clients it replaces:
 * - `service`: the connection role, like `supabaseAdmin` (RLS bypassed).
 * - `jwt`: `authenticated` with the user's claims, like `supabaseClient(c, jwt)`.
 * - `apikey`: `anon` with `request.headers.capgkey` set, like `supabaseApikey`. RLS policies
 *   and RBAC functions read the key back through `get_apikey_header()`.
 * - `anon`: plain `anon`, like `emptySupabase`.
 */
export type RlsPrincipal
  = | { kind: 'service' }
    | { kind: 'jwt', userId: string, claims?: JWTClaims }
    | { kind: 'apikey', apikey: string }
    | { kind: 'anon' }

export const servicePrincipal: RlsPrincipal = { kind: 'service' }

/** API-key principal; hashed keys have no `key`, so fall back to the request's capgkey like `supabaseApikey`. */
export function apikeyPrincipal(c: Context, apikey: string | null | undefined): RlsPrincipal {
  const effectiveApikey = apikey ?? c.get('capgkey')
  if (!effectiveApikey)
    throw new Error('No API key available for authentication')
  return { kind: 'apikey', apikey: effectiveApikey }
}

/** Principal for the authenticated caller, like `supabaseWithAuth`. */
export function authPrincipal(c: Context, auth: AuthInfo | null | undefined = c.get('auth')): RlsPrincipal {
  if (auth?.authType === 'jwt' && auth.jwt)
    return { kind: 'jwt', userId: auth.userId, claims: auth.claims }
  if (auth?.authType === 'apikey' && auth.apikey)
    return apikeyPrincipal(c, auth.apikey.key)
  throw simpleError('not_authorized', 'Not authorized')
}

/** Settings PostgREST would set for this principal. `role: null` keeps the connection role. */
export function rlsContextSettings(principal: RlsPrincipal): { role: string | null, claims: string, sub: string, claimRole: string, headers: string } {
  switch (principal.kind) {
    case 'service':
      return { role: null, claims: JSON.stringify({ role: 'service_role' }), sub: '', claimRole: 'service_role', headers: '{}' }
    case 'jwt':
      return {
        role: 'authenticated',
        claims: JSON.stringify({ ...principal.claims, sub: principal.userId, role: 'authenticated' }),
        sub: principal.userId,
        claimRole: 'authenticated',
        headers: '{}',
      }
    case 'apikey':
      return { role: 'anon', claims: JSON.stringify({ role: 'anon' }), sub: '', claimRole: 'anon', headers: JSON.stringify({ capgkey: principal.apikey }) }
    case 'anon':
      return { role: 'anon', claims: JSON.stringify({ role: 'anon' }), sub: '', claimRole: 'anon', headers: '{}' }
  }
}

interface QueryClient {
  query: (queryText: string, values?: unknown[]) => Promise<unknown>
}

/**
 * Applies the principal's role, JWT claims and `request.headers` to the open transaction, in one
 * round trip. Settings are transaction-local (`is_local = true`), so the caller must be inside
 * BEGIN/COMMIT: outside a transaction they would be discarded at once.
 */
export async function applyRlsContext(client: QueryClient, principal: RlsPrincipal): Promise<void> {
  const settings = rlsContextSettings(principal)
  await client.query(
    `SELECT
      pg_catalog.set_config('request.jwt.claims', $1, true),
      pg_catalog.set_config('request.jwt.claim.sub', $2, true),
      pg_catalog.set_config('request.jwt.claim.role', $3, true),
      pg_catalog.set_config('request.headers', $4, true)${settings.role ? `,
      pg_catalog.set_config('role', $5, true)` : ''}`,
    settings.role
      ? [settings.claims, settings.sub, settings.claimRole, settings.headers, settings.role]
      : [settings.claims, settings.sub, settings.claimRole, settings.headers],
  )
}

/**
 * Sets only `request.headers.capgkey` for the open transaction, keeping the connection role, so
 * audit triggers attribute writes to the API key (`get_apikey_header()`) on a path that already
 * checked permissions and must still call functions revoked from anon. Must run inside BEGIN/COMMIT.
 */
export async function setRequestApikeyHeader(client: QueryClient, apikey: string): Promise<void> {
  await client.query(
    'SELECT pg_catalog.set_config(\'request.headers\', $1, true)',
    [JSON.stringify({ capgkey: apikey })],
  )
}

/**
 * Runs `text` (a SELECT, or INSERT/UPDATE/DELETE ... RETURNING) and returns each row as Postgres
 * serializes it to JSON (`to_json`, column order kept), which is what PostgREST returns: bigint as number, timestamptz as
 * `2024-01-01T00:00:00+00:00`, json columns as objects. Raw node-postgres rows instead carry
 * Date objects and bigint strings, so use this whenever rows reach a response, webhook payload,
 * or other JSON a supabase-js caller used to receive.
 */
export async function queryJson<T>(client: QueryClient, text: string, values: unknown[] = []): Promise<T[]> {
  const result = await client.query(
    `WITH q AS (${text}) SELECT pg_catalog.to_json(q.*) AS row FROM q`,
    values,
  ) as { rows: { row: T }[] }
  return result.rows.map(r => r.row)
}

/** First row of `queryJson`, or null when there is none. */
export async function queryJsonOne<T>(client: QueryClient, text: string, values: unknown[] = []): Promise<T | null> {
  return (await queryJson<T>(client, text, values))[0] ?? null
}

/**
 * Quotes `value` as a Postgres string literal, like node-postgres `escapeLiteral`: quotes and
 * backslashes are doubled, and an `E` prefix is added when a backslash is present so the literal
 * means the same with any `standard_conforming_strings`. NUL is rejected because the simple query
 * protocol would cut the statement there and Postgres text cannot hold it anyway.
 */
export function quotePgLiteral(value: string): string {
  if (value.includes('\0'))
    throw new Error('Postgres literal cannot contain NUL')
  const quoted = `'${value.replaceAll('\'', '\'\'').replaceAll('\\', '\\\\')}'`
  return value.includes('\\') ? ` E${quoted}` : quoted
}

/**
 * `applyRlsContext` as literal SQL, so it can ride on the BEGIN round trip of `withPgTransaction`
 * (simple query protocol, no bind parameters). Every value is quoted with `quotePgLiteral`.
 */
export function rlsContextSql(principal: RlsPrincipal): string {
  const settings = rlsContextSettings(principal)
  const parts = [
    `pg_catalog.set_config('request.jwt.claims', ${quotePgLiteral(settings.claims)}, true)`,
    `pg_catalog.set_config('request.jwt.claim.sub', ${quotePgLiteral(settings.sub)}, true)`,
    `pg_catalog.set_config('request.jwt.claim.role', ${quotePgLiteral(settings.claimRole)}, true)`,
    `pg_catalog.set_config('request.headers', ${quotePgLiteral(settings.headers)}, true)`,
  ]
  if (settings.role)
    parts.push(`pg_catalog.set_config('role', ${quotePgLiteral(settings.role)}, true)`)
  return `SELECT ${parts.join(', ')}`
}

/**
 * Runs `run` in a transaction on `pg` with the principal's RLS context applied. The context is
 * sent with BEGIN in one round trip, so a ported call costs BEGIN, its queries and COMMIT.
 */
export function withRlsTransaction<T>(pg: PgClient, principal: RlsPrincipal, run: (client: PgQueryClient) => Promise<T>): Promise<T> {
  return withPgTransaction(pg, run, { appendSql: rlsContextSql(principal) })
}

/**
 * Opens a connection, runs `run` in one transaction as `principal`, then closes the connection.
 * This is the direct-Postgres replacement for a supabase-js `.from()` / `.rpc()` call made with
 * `supabaseApikey`, `supabaseWithAuth` or `supabaseClient`.
 */
export async function withRlsContext<T>(
  c: Context,
  principal: RlsPrincipal,
  run: (client: PgQueryClient, drizzle: ReturnType<typeof getDrizzleClient>) => Promise<T>,
  options?: { readOnly?: boolean },
): Promise<T> {
  const pg = await getPgClient(c, options?.readOnly ?? false)
  try {
    return await withRlsTransaction(pg, principal, client => run(client, getDrizzleClient(client)))
  }
  finally {
    closeClient(c, pg)
  }
}
