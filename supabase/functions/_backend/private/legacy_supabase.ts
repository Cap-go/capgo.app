import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PgQuerySession } from '../utils/pg_query.ts'
import type { ParsedPostgrestRequest, PostgrestHttpResponse } from '../utils/postgrest_http.ts'
import type { ConsoleQueryResult } from './console_query_sql.ts'
import { getRuntimeKey } from 'hono/adapter'
import { Hono } from 'hono/tiny'
import { decodeJwt } from 'jose'
import { jwtSession, runDbQuery } from '../utils/db.ts'
import { useCors } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { parsePostgrestRequest, PostgrestHttpError, postgrestResponse } from '../utils/postgrest_http.ts'
import { existInEnv, getEnv } from '../utils/utils.ts'

/**
 * Supabase-compatible host for released CLIs (8.42.3 – 8.90.0).
 *
 * Those versions build a supabase-js client from `supaHost` in /private/config.
 * Pointing `supaHost` here lets them keep working with PostgREST turned off:
 * - /rest/v1/*       the PostgREST HTTP API they call, run as SQL through Drizzle
 *                    with the same anon + capgkey session PostgREST used, so RLS
 *                    decides exactly as before. Only what those CLIs call is served.
 * - /storage/v1/*    relayed to Supabase Storage (app icons).
 * - /functions/v1/*  relayed to this API. A non-Supabase supaHost makes them send
 *                    public API calls to `${supaHost}/functions/v1/<route>`.
 * Current CLIs never use supaHost: they only call the versioned Capgo API.
 */
export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

// Every table and RPC that a CLI from MIN_CLI_VERSION (8.42.3) to 8.90.0 calls
// (8.90.1 dropped the Supabase SDK). Derived from the cli-* tags; nothing else
// was ever reachable from those clients, so nothing else is served.
export const LEGACY_CLI_TABLES = new Set(['app_versions', 'apps', 'channels', 'manifest', 'orgs'])
export const LEGACY_CLI_RPCS = new Set([
  'check_org_members_2fa_enabled',
  'check_org_members_password_policy',
  'cli_check_permission',
  'exist_app_versions',
  'get_app_versions',
  'get_channel_current_bundle_rbac',
  'get_org_members',
  'get_organization_cli_warnings',
  'get_orgs_v7',
  'get_user_id',
  'has_2fa_enabled',
  'has_usage_credits_org',
  'is_allowed_action_org',
  'is_allowed_action_org_action',
  'is_paying_org',
  'is_trial_org',
  'reject_access_due_to_2fa_for_app',
  'reject_access_due_to_2fa_for_org',
  'request_actor_email_adress',
  'request_actor_user_id',
])

/** The supaHost released CLIs should use for this deployment. */
export function legacySupabaseHost(c: Context): string {
  if (getRuntimeKey() === 'deno')
    return `${getEnv(c, 'SUPABASE_URL').replace(/\/$/, '')}/functions/v1/private/legacy_supabase`
  return `${new URL(c.req.url).origin}/private/legacy_supabase`
}

function bearerRole(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer '))
    return null
  try {
    const role = decodeJwt(authorization.slice(7)).role
    return typeof role === 'string' ? role : null
  }
  catch {
    return null
  }
}

/** The session PostgREST would have used for this request. */
async function legacySession(c: Context): Promise<PgQuerySession | ConsoleQueryResult> {
  const authorization = c.req.header('authorization')
  const capgkey = c.req.header('capgkey')
  // Released CLIs send the anon key as bearer and the API key in capgkey.
  // A user or service token is verified before its role is trusted.
  const role = bearerRole(authorization)
  if (role === 'authenticated' || role === 'service_role') {
    const session = await jwtSession(c, authorization!)()
    return 'failure' in session ? session.failure : session
  }
  return capgkey ? { role: 'anon', headers: { capgkey } } : { role: 'anon' }
}

function send(c: Context, response: PostgrestHttpResponse) {
  if (response.body === undefined)
    return c.body(null, response.status as 200, response.headers)
  return c.json(response.body, response.status as 200, response.headers)
}

app.all('/rest/v1/*', async (c) => {
  let parsed: ParsedPostgrestRequest
  try {
    parsed = parsePostgrestRequest({
      method: c.req.method,
      url: new URL(c.req.url),
      header: name => c.req.header(name),
      body: c.req.method === 'GET' || c.req.method === 'HEAD' ? null : await c.req.text(),
    })
  }
  catch (error) {
    if (error instanceof PostgrestHttpError)
      return send(c, error.response())
    throw error
  }
  if (!(parsed.kind === 'rpc' ? LEGACY_CLI_RPCS : LEGACY_CLI_TABLES).has(parsed.name)) {
    cloudlog({ requestId: c.get('requestId'), message: 'legacy supabase request refused', kind: parsed.kind, name: parsed.name })
    const missing = new PostgrestHttpError(404, parsed.kind === 'rpc' ? 'PGRST202' : 'PGRST205', `Could not find ${parsed.kind === 'rpc' ? 'the function' : 'the table'} public.${parsed.name}`)
    return send(c, missing.response())
  }
  const session = await legacySession(c)
  const result = 'role' in session ? await runDbQuery(c, parsed.request, session) : session
  return send(c, postgrestResponse(parsed, result))
})

// Hop-by-hop and host headers are the relay's own, not the caller's.
const DROPPED_HEADERS = ['host', 'connection', 'content-length', 'transfer-encoding', 'cf-connecting-ip', 'cf-ray', 'x-forwarded-host']

function relayHeaders(c: Context): Headers {
  const headers = new Headers(c.req.raw.headers)
  for (const name of DROPPED_HEADERS)
    headers.delete(name)
  return headers
}

function relayBody(c: Context): BodyInit | undefined {
  return c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : c.req.raw.body ?? undefined
}

// The part after this mount's own prefix. On the Supabase edge runtime the
// mount itself sits under /functions/v1/, so the first match is not this one.
function tailAfter(c: Context, marker: string): string {
  const url = new URL(c.req.url)
  const mounted = `/legacy_supabase${marker}`
  const at = url.pathname.indexOf(mounted)
  const start = at === -1 ? url.pathname.indexOf(marker) + marker.length : at + mounted.length
  return `${url.pathname.slice(start)}${url.search}`
}

// Storage is the Supabase Storage API, not PostgREST. Same request, same headers.
app.all('/storage/v1/*', (c) => {
  const target = `${getEnv(c, 'SUPABASE_URL').replace(/\/$/, '')}/storage/v1/${tailAfter(c, '/storage/v1/')}`
  return fetch(target, { method: c.req.method, headers: relayHeaders(c), body: relayBody(c), duplex: 'half' } as RequestInit)
})

function functionsBase(c: Context): string {
  if (existInEnv(c, 'PUBLIC_URL'))
    return getEnv(c, 'PUBLIC_URL').replace(/\/$/, '')
  if (getRuntimeKey() === 'deno')
    return `${getEnv(c, 'SUPABASE_URL').replace(/\/$/, '')}/functions/v1`
  return new URL(c.req.url).origin
}

/**
 * Runs a request through this API in-process (Workers). A Worker fetching its own
 * custom domain is not a supported path, and a network hop would replace the
 * caller's IP with the Worker's, merging every legacy CLI into one rate-limit bucket.
 */
export type LegacyApiDispatcher = (request: Request, c: Context) => Response | Promise<Response>

let dispatchApi: LegacyApiDispatcher | null = null

/** Set by the Workers API entry point to its own app.fetch. */
export function setLegacyApiDispatcher(dispatcher: LegacyApiDispatcher | null) {
  dispatchApi = dispatcher
}

// These CLIs send `Authorization: Bearer <anon key>` to /functions/v1 and the API
// key in capgkey. The Capgo API reads the key from Authorization, as the cloud CLI sends it.
app.all('/functions/v1/*', (c) => {
  const capgkey = c.req.header('capgkey')
  const tail = tailAfter(c, '/functions/v1/')
  const route = decodeURIComponent(tail.split('?')[0]).replace(/^\/+/, '')
  // The relay targets this same API. A tail that points back at this host would
  // relay to itself once per nested prefix; no released CLI calls it.
  if (route.startsWith('private/legacy_supabase'))
    return c.json({ error: 'not_found', message: 'Not found' }, 404)
  // In-process on Workers, except /files: that is the files Worker, a real hop.
  if (dispatchApi && !route.startsWith('files')) {
    // The caller's own headers, client IP included, so auth and rate limits see the same request.
    const headers = new Headers(c.req.raw.headers)
    if (capgkey)
      headers.set('Authorization', capgkey)
    const target = new URL(`/${tail.replace(/^\/+/, '')}`, new URL(c.req.url).origin)
    return dispatchApi(new Request(target, { method: c.req.method, headers, body: relayBody(c), duplex: 'half', redirect: 'manual' } as RequestInit), c)
  }
  const headers = relayHeaders(c)
  if (capgkey)
    headers.set('Authorization', capgkey)
  const target = `${functionsBase(c)}/${tail}`
  return fetch(target, { method: c.req.method, headers, body: relayBody(c), duplex: 'half', redirect: 'manual' } as RequestInit)
})
