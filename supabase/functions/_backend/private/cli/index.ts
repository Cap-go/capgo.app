import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { PgQueryClient } from '../../utils/pg.ts'
import type { Permission } from '../../utils/rbac.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { versionedRoute } from '../../utils/api_version.ts'
import { parseBody, quickError, simpleError, useCors } from '../../utils/hono.ts'
import { middlewareKey } from '../../utils/hono_middleware.ts'
import { apikeyPrincipal, queryJson, queryJsonOne, withRlsContext } from '../../utils/pg_rls.ts'
import { checkPermission, checkPermissionsBatch } from '../../utils/rbac.ts'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { MAX_MANIFEST_ENTRIES } from '../../utils/manifest_limits.ts'
import { isValidAppId } from '../../utils/utils.ts'
import { uploadCliAppIcon } from './storage_icon.ts'

/**
 * CLI API. Every route dispatches on the `capgo_api` header (see versionedRoute):
 * a breaking change ships as a new version key while released CLIs keep theirs.
 * Routes are command-level: the backend owns permission / 2FA / plan rules and the
 * CLI only renders the outcome, so storage can change without a CLI release.
 */
const CLI_API_2025_10_01 = '2025-10-01'

// RBAC keys look like `scope.action`; unknown keys are simply denied by the RBAC check.
const permissionKeySchema = z.string().regex(/^[a-z]+\.[a-z_]+$/)

const orgIdQuerySchema = z.object({
  org_id: z.uuid(),
})

const organizationsQuerySchema = z.object({
  permission: permissionKeySchema.optional(),
})

const permissionsBodySchema = z.object({
  permissions: z.array(permissionKeySchema).min(1).max(20),
  org_id: z.uuid().optional(),
  app_id: z.string().min(1).optional(),
  channel_id: z.number().int().positive().optional(),
}).refine(body => body.org_id || body.app_id || body.channel_id, { message: 'org_id, app_id or channel_id is required' })

const preflightBodySchema = z.object({
  app_id: z.string().min(1).optional(),
  org_id: z.uuid().optional(),
  channel_id: z.number().int().positive().optional(),
  /** RBAC permission the command needs (scoped to channel, app or org). */
  permission: permissionKeySchema.optional(),
  /** Enforce org 2FA policy (default true). */
  check_2fa: z.boolean().optional(),
  /** Metered plan gate: `all` for usage commands, `upload` for storage-only. */
  plan: z.enum(['all', 'upload']).optional(),
  /** Return org CLI warnings targeted at this CLI version. */
  cli_version: z.string().min(1).optional(),
})

const appIdQuerySchema = z.object({
  app_id: z.string().min(1),
})

const channelsQuerySchema = z.object({
  app_id: z.string().min(1),
  name: z.string().min(1).optional(),
  linked_version_id: z.coerce.number().int().positive().optional(),
})

const CHANNELS_PAGE_SIZE = 1000
const CHANNELS_MAX_PAGES = 50

const MANIFEST_PAGE_SIZE = 1000
// MAX_MANIFEST_ENTRIES (10k) rows plus one page of headroom.
const MANIFEST_MAX_PAGES = Math.ceil(MAX_MANIFEST_ENTRIES / MANIFEST_PAGE_SIZE) + 1

const manifestQuerySchema = z.object({
  app_version_id: z.coerce.number().int().positive(),
})

const setBundlesDeletedBodySchema = z.object({
  app_id: z.string().min(1),
  names: z.array(z.string().min(1)).min(1).max(100),
  deleted: z.boolean(),
})

// Same columns + embeds the CLI used to read directly through PostgREST
// (`*, version_info:app_versions!channels_version_fkey(id, name, deleted), rollout_version_info:...`).
// Reads run with the caller API key so RLS (preview keys, channel-scoped keys) stays identical,
// embedded versions included.
const CLI_CHANNEL_SELECT = `ch.*,
  (SELECT pg_catalog.to_json(v) FROM (SELECT av.id, av.name, av.deleted FROM public.app_versions av WHERE av.id = ch.version) v) AS version_info,
  (SELECT pg_catalog.to_json(v) FROM (SELECT av.id, av.name, av.deleted FROM public.app_versions av WHERE av.id = ch.rollout_version) v) AS rollout_version_info`

type CliContext = Context<MiddlewareKeyVariables>
type CallerClient = PgQueryClient

/** One transaction bound to the caller API key: RLS and RBAC RPC checks apply. */
function withCaller<T>(c: CliContext, run: (client: CallerClient) => Promise<T>): Promise<T> {
  return withRlsContext(c, apikeyPrincipal(c, c.get('capgkey') as string), client => run(client))
}

/** Statement result as supabase-js returned it: `{ data, error }` instead of a throw. */
async function settle<T>(query: Promise<T>): Promise<{ data: T, error: null } | { data: null, error: unknown }> {
  try {
    return { data: await query, error: null }
  }
  catch (error) {
    return { data: null, error }
  }
}

/** `.rpc()` of a scalar function: `call` is a schema-qualified call with named arguments. */
function rpc<T>(client: CallerClient, call: string, values: unknown[] = []) {
  return settle(queryJsonOne<{ value: T }>(client, `SELECT ${call} AS value`, values).then(row => row?.value ?? null))
}

/** Validate selected query params; empty strings count as missing. */
function parseQuery<S extends z.ZodType>(c: CliContext, schema: S, keys: string[]): z.infer<S> {
  const raw = Object.fromEntries(keys.map(key => [key, c.req.query(key) || undefined]))
  const parsed = safeParseSchema(schema, raw)
  if (!parsed.success) {
    throw simpleError('invalid_query', 'Invalid query', { error: parsed.error })
  }
  return parsed.data
}

async function parseJson<S extends z.ZodType>(c: CliContext, schema: S): Promise<z.infer<S>> {
  const parsed = safeParseSchema(schema, await parseBody<unknown>(c))
  if (!parsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error })
  }
  return parsed.data
}

/** Unwrap a PostgREST result or throw the given Capgo error. */
function unwrap<T>(result: { data: T, error: unknown }, code: string, message: string): T {
  if (result.error) {
    throw simpleError(code, message, { error: result.error })
  }
  return result.data
}

/** The API key's user id, or null when the key does not resolve to a user. */
async function actorUserId(supabase: CallerClient): Promise<string | null> {
  const userId = unwrap(await rpc<string>(supabase, 'public.request_actor_user_id()'), 'cannot_resolve_identity', 'Cannot resolve CLI identity')
  return userId || null
}

function invalidApikey() {
  return quickError(401, 'invalid_apikey', 'Invalid apikey or insufficient permissions')
}

type CliPlanAction = Database['public']['Enums']['action_type']
type CliPlanStatus = 'allowed' | 'billing_denied' | 'permission_denied'

const ALL_PLAN_ACTIONS: CliPlanAction[] = ['mau', 'storage', 'bandwidth', 'build_time']

interface CliScope {
  org_id?: string
  app_id?: string
  channel_id?: number
}

function permissionScope(scope: CliScope) {
  return {
    ...(scope.org_id ? { orgId: scope.org_id } : {}),
    ...(scope.app_id ? { appId: scope.app_id } : {}),
    ...(scope.channel_id ? { channelId: scope.channel_id } : {}),
  }
}

function assertValidAppId(appId: string | undefined) {
  if (appId && !isValidAppId(appId))
    throw quickError(400, 'invalid_app_id', 'App ID must be a reverse domain string', { app_id: appId })
}

interface PlanStatusRow {
  app_allowed: boolean | null
  org_allowed: boolean | null
  is_paying: boolean | null
  trial_days: number | null
  has_credits: boolean | null
}

/**
 * Metered plan gate and unpaid-trial lookup in one statement. The CASE guards keep the
 * evaluation of the former sequential RPCs: the org-wide check runs only when the
 * app-scoped one did not allow, and the trial/paying/credits RPCs only when allowed.
 * `OFFSET 0` keeps each level from being flattened, so every RPC runs at most once.
 */
function planStatusSql(plan: 'all' | 'upload', appId?: string): string {
  const appCheck = appId
    ? 'public.is_allowed_action_org_action(orgid => p.org_id, actions => p.actions, appid => p.app_id)'
    : 'NULL::boolean'
  const orgCheck = plan === 'all' && !appId
    ? 'public.is_allowed_action_org(orgid => a.org_id)'
    : 'public.is_allowed_action_org_action(orgid => a.org_id, actions => a.actions)'
  const credits = appId
    ? 'public.has_usage_credits_org(orgid => s.org_id, appid => s.app_id)'
    : 'public.has_usage_credits_org(orgid => s.org_id)'
  return `SELECT s.app_allowed, s.org_allowed,
  CASE WHEN s.allowed THEN public.is_paying_org(orgid => s.org_id) END AS is_paying,
  CASE WHEN s.allowed THEN public.is_trial_org(orgid => s.org_id) END AS trial_days,
  CASE WHEN s.allowed THEN ${credits} END AS has_credits
FROM (
  SELECT o.org_id, o.app_id, o.app_allowed, o.org_allowed,
    (o.app_allowed IS TRUE OR (o.app_id IS NULL AND o.org_allowed IS TRUE)) AS allowed
  FROM (
    SELECT a.org_id, a.app_id, a.app_allowed,
      CASE WHEN a.app_allowed IS TRUE THEN NULL ELSE ${orgCheck} END AS org_allowed
    FROM (
      SELECT p.org_id, p.actions, p.app_id, ${appCheck} AS app_allowed
      FROM (SELECT $1::uuid AS org_id, $2::public.action_type[] AS actions, $3::character varying AS app_id) p
      OFFSET 0
    ) a
    OFFSET 0
  ) o
  OFFSET 0
) s`
}

interface PlanCheck {
  status: CliPlanStatus
  /** Days left in an unpaid trial (no paid plan, no usage credits), else null. */
  trialDaysLeft: number | null
}

/**
 * App-scoped checks run with the caller key, so a denial there while the org-wide
 * check passes means the key cannot read app billing, not that the plan is exhausted.
 */
async function meteredPlanCheck(supabase: CallerClient, orgId: string, plan: 'all' | 'upload', appId?: string): Promise<PlanCheck> {
  const actions: CliPlanAction[] = plan === 'upload' ? ['storage'] : ALL_PLAN_ACTIONS
  const row = unwrap(
    await settle(queryJsonOne<PlanStatusRow>(supabase, planStatusSql(plan, appId), [orgId, actions, appId ?? null])),
    'cannot_check_billing',
    'Cannot check org plan status',
  )
  const appAllowed = row?.app_allowed === true
  const orgAllowed = row?.org_allowed === true
  let status: CliPlanStatus
  if (appId)
    status = appAllowed ? 'allowed' : orgAllowed ? 'permission_denied' : 'billing_denied'
  else
    status = orgAllowed ? 'allowed' : 'billing_denied'
  if (status !== 'allowed')
    return { status, trialDaysLeft: null }
  const trialDays = row?.trial_days
  if (row?.is_paying === true || row?.has_credits === true || typeof trialDays !== 'number' || trialDays <= 0)
    return { status, trialDaysLeft: null }
  return { status, trialDaysLeft: trialDays }
}

interface PreflightIdentityRow {
  user_id: string | null
  rejected_2fa: boolean | null
  app: { app_id: string, owner_org: string } | null
}

/**
 * Actor, org 2FA policy and app row in one round trip. The CASE guards keep the
 * previous order: no 2FA lookup without an actor, and no app read without an actor
 * or when 2FA rejects (a key blocked by org policy learns nothing else about the app).
 */
const PREFLIGHT_IDENTITY_SQL = `SELECT r.user_id, r.rejected_2fa,
  CASE WHEN r.user_id IS NOT NULL AND r.rejected_2fa IS NOT TRUE AND r.app_id IS NOT NULL THEN
    (SELECT pg_catalog.to_json(v) FROM (SELECT ap.app_id, ap.owner_org FROM public.apps ap WHERE ap.app_id = r.app_id) v)
  END AS app
FROM (
  SELECT a.user_id, a.app_id,
    CASE
      WHEN a.user_id IS NULL OR NOT a.check_2fa THEN false
      WHEN a.app_id IS NOT NULL THEN public.reject_access_due_to_2fa_for_app(app_id => a.app_id)
      WHEN a.org_id IS NOT NULL THEN public.reject_access_due_to_2fa_for_org(org_id => a.org_id)
      ELSE false
    END AS rejected_2fa
  FROM (
    SELECT public.request_actor_user_id() AS user_id, $1::character varying AS app_id, $2::uuid AS org_id, $3::boolean AS check_2fa
    OFFSET 0
  ) a
  OFFSET 0
) r`

async function preflightIdentity(supabase: CallerClient, body: CliPreflightBody): Promise<PreflightIdentityRow> {
  const row = unwrap(
    await settle(queryJsonOne<PreflightIdentityRow>(supabase, PREFLIGHT_IDENTITY_SQL, [body.app_id ?? null, body.org_id ?? null, body.check_2fa !== false])),
    'cannot_resolve_identity',
    'Cannot resolve CLI identity',
  )
  return {
    user_id: row?.user_id || null,
    rejected_2fa: row?.rejected_2fa === true,
    app: row?.app ?? null,
  }
}

async function visibleApp(supabase: CallerClient, appId: string) {
  return unwrap(await settle(queryJsonOne<{ app_id: string, owner_org: string }>(
    supabase,
    'SELECT app_id, owner_org FROM public.apps WHERE app_id = $1',
    [appId],
  )), 'cannot_get_app', 'Cannot get app')
}

async function cliWarnings(supabase: CallerClient, orgId: string, cliVersion: string): Promise<unknown[]> {
  const data = unwrap(await rpc<unknown[]>(supabase, 'public.get_organization_cli_warnings(orgid => $1, cli_version => $2)', [orgId, cliVersion]), 'cannot_get_cli_warnings', 'Cannot get CLI warnings')
  return Array.isArray(data) ? data : []
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

app.get('/identity', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
    const { userId, email, has2fa } = await withCaller(c, async (supabase) => {
      const userId = await actorUserId(supabase)
      if (!userId)
        return invalidApikey()

      const [emailResult, has2faResult] = await Promise.all([
        rpc<string>(supabase, 'public.request_actor_email_adress()'),
        rpc<boolean>(supabase, 'public.has_2fa_enabled()'),
      ])
      const email = unwrap(emailResult, 'cannot_resolve_identity_email', 'Cannot resolve CLI identity email')
      const has2fa = unwrap(has2faResult, 'cannot_resolve_identity_2fa', 'Cannot resolve CLI identity 2FA status')
      return { userId, email, has2fa }
    })

    return c.json({
      userId,
      email: email ?? null,
      has2fa: has2fa === true,
      apikey_id: apikey.id,
    })
  },
}))

app.get('/organizations', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const { permission } = parseQuery(c, organizationsQuerySchema, ['permission'])
    type Organization = Database['public']['Functions']['get_orgs_v7']['Returns'][number]
    const organizations = await withCaller(c, async (supabase) => {
      if (!(await actorUserId(supabase)))
        return invalidApikey()

      // PostgREST capped RPC results at max_rows (1000).
      return unwrap(await settle(queryJson<Organization>(supabase, 'SELECT * FROM public.get_orgs_v7() LIMIT 1000')), 'cannot_list_organizations', 'Cannot list organizations') ?? []
    })
    if (!permission)
      return c.json(organizations as unknown)

    // `allowed` tells the CLI which orgs the key may use for this command.
    // One pooled client and one batched statement for every org.
    const allowed = await checkPermissionsBatch(c, organizations.map(org => ({
      permission: permission as Permission,
      scope: { orgId: org.gid },
    })))
    const rows = organizations.map((org, idx) => ({ ...org, allowed: allowed[idx] }))
    return c.json(rows)
  },
}))

app.post('/permissions', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const body = await parseJson(c, permissionsBodySchema)
    assertValidAppId(body.app_id)
    const scope = permissionScope(body)
    const permissions = [...new Set(body.permissions)]
    const allowed = await checkPermissionsBatch(c, permissions.map(permission => ({
      permission: permission as Permission,
      scope,
    })))
    const entries = permissions.map((permission, idx) => [permission, allowed[idx]] as const)
    return c.json({ permissions: Object.fromEntries(entries) })
  },
}))

export type CliPreflightBody = z.infer<typeof preflightBodySchema>

export interface CliPreflightResult {
  user_id: string
  org_id: string | null
  app_id: string | null
  trial_days_left: number | null
  warnings: unknown[]
}

/** Shared by the CLI preflight route and server-side flows (bundle upload sessions); failures throw typed errors. */
export async function runCliPreflight(c: CliContext, body: CliPreflightBody): Promise<CliPreflightResult> {
  assertValidAppId(body.app_id)
  return withCaller(c, supabase => runCliPreflightAsCaller(c, supabase, body))
}

async function runCliPreflightAsCaller(c: CliContext, supabase: CallerClient, body: CliPreflightBody): Promise<CliPreflightResult> {
  const identity = await preflightIdentity(supabase, body)
  const userId = identity.user_id
  if (!userId)
    return invalidApikey()

  // 2FA first: a key blocked by org policy learns nothing else about the app.
  if (identity.rejected_2fa) {
    return quickError(403, '2fa_required', 'Two-factor authentication is required by this organization', {
      app_id: body.app_id ?? null,
      org_id: body.org_id ?? null,
    })
  }

  // Only app-scoped permission and plan checks need the app row. Channel-scoped keys
  // may not see it (their channel permission decides), and a 2FA-only check must
  // not turn into an app visibility check.
  const channelScoped = body.channel_id !== undefined && body.permission?.startsWith('channel.') === true
  const needsApp = !channelScoped && (body.permission !== undefined || body.plan !== undefined)
  const appRow = body.app_id ? identity.app : null
  if (body.app_id && !appRow && needsApp)
    return quickError(404, 'app_not_found', 'App not found', { app_id: body.app_id })
  const orgId = body.org_id ?? appRow?.owner_org ?? null

  // The RBAC check needs the service role, so it runs on its own pooled connection
  // while the caller transaction reads plan status and warnings. Results are still
  // applied in the original order, so the first failing step decides the response.
  const plan = body.plan
  const [permissionResult, callerResult] = await Promise.all([
    body.permission ? settle(checkPermission(c, body.permission as Permission, permissionScope(body))) : null,
    // Each step is settled, so this never rejects; errors are rethrown below in order.
    (async () => {
      const planCheck = plan && orgId ? await settle(meteredPlanCheck(supabase, orgId, plan, body.app_id)) : null
      const allowed = !plan || planCheck?.data?.status === 'allowed'
      const warnings = allowed && body.cli_version && orgId ? await settle(cliWarnings(supabase, orgId, body.cli_version)) : null
      return { planCheck, warnings }
    })(),
  ])

  if (permissionResult) {
    if (permissionResult.error)
      throw permissionResult.error
    if (!permissionResult.data) {
      return quickError(403, 'permission_denied', `Missing permission ${body.permission}`, {
        permission: body.permission,
        app_id: body.app_id ?? null,
        org_id: body.org_id ?? null,
        channel_id: body.channel_id ?? null,
      })
    }
  }
  const { planCheck, warnings } = callerResult

  let trialDaysLeft: number | null = null
  if (plan) {
    if (!orgId)
      return quickError(404, 'app_not_found', 'App not found', { app_id: body.app_id ?? null })
    if (planCheck?.error)
      throw planCheck.error
    const { status, trialDaysLeft: daysLeft } = planCheck!.data!
    if (status === 'permission_denied')
      return quickError(403, 'plan_permission_denied', 'The API key cannot read plan usage for this app', { org_id: orgId, app_id: body.app_id ?? null })
    if (status === 'billing_denied')
      return quickError(402, 'plan_upgrade_required', 'Plan upgrade required', { org_id: orgId, plan })
    trialDaysLeft = daysLeft
  }

  if (warnings?.error)
    throw warnings.error

  return {
    user_id: userId,
    org_id: orgId,
    app_id: appRow?.app_id ?? null,
    trial_days_left: trialDaysLeft,
    warnings: warnings?.data ?? [],
  }
}

/**
 * One call per CLI command before it acts: 2FA policy, app visibility, RBAC
 * permission, metered plan and org CLI warnings. Failures are typed errors
 * (`2fa_required`, `app_not_found`, `permission_denied`, `plan_upgrade_required`,
 * `plan_permission_denied`); success carries what the CLI needs to continue.
 */
app.post('/preflight', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const body = await parseJson(c, preflightBodySchema)
    // Json[] is recursive in generated Supabase types; avoid deep Hono json() inference.
    return c.json(await runCliPreflight(c, body) as unknown)
  },
}))

app.get('/members/2fa-status', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const { org_id: orgId } = parseQuery(c, orgIdQuerySchema, ['org_id'])
    const data = unwrap(await withCaller(c, client => settle(queryJson(client, 'SELECT * FROM public.check_org_members_2fa_enabled(org_id => $1) LIMIT 1000', [orgId]))), 'cannot_check_members_2fa', 'Cannot check org members 2FA status')
    return c.json(data ?? [])
  },
}))

app.get('/members/password-policy', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const { org_id: orgId } = parseQuery(c, orgIdQuerySchema, ['org_id'])
    const data = unwrap(await withCaller(c, client => settle(queryJson(client, 'SELECT * FROM public.check_org_members_password_policy(org_id => $1) LIMIT 1000', [orgId]))), 'cannot_check_members_password_policy', 'Cannot check org members password policy')
    return c.json(data ?? [])
  },
}))

app.post('/storage/icon', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
    return uploadCliAppIcon(c, apikey)
  },
}))

app.get('/apps/visible', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const { app_id: appId } = parseQuery(c, appIdQuerySchema, ['app_id'])
    const data = await withCaller(c, client => visibleApp(client, appId))

    return c.json({ visible: !!data, app_id: data?.app_id ?? null, owner_org: data?.owner_org ?? null })
  },
}))

app.get('/channels', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const { app_id: appId, name, linked_version_id: linkedVersionId } = parseQuery(c, channelsQuerySchema, ['app_id', 'name', 'linked_version_id'])
    const filters = ['ch.app_id = $1']
    const values: unknown[] = [appId]
    if (name) {
      values.push(name)
      filters.push(`ch.name = $${values.length}`)
    }
    if (linkedVersionId) {
      values.push(linkedVersionId)
      filters.push(`(ch.version = $${values.length} OR ch.rollout_version = $${values.length})`)
    }
    const rows = await withCaller(c, async (supabase) => {
      const rows: unknown[] = []
      // Page like the PostgREST version (1000 rows per response) so callers never see a truncated list.
      // One probe page past the cap: fail loudly instead of returning a silently truncated list.
      for (let page = 0; page <= CHANNELS_MAX_PAGES; page++) {
        const from = page * CHANNELS_PAGE_SIZE
        const data = unwrap(await settle(queryJson(
          supabase,
          `SELECT ${CLI_CHANNEL_SELECT} FROM public.channels ch WHERE ${filters.join(' AND ')} ORDER BY ch.name, ch.id LIMIT ${CHANNELS_PAGE_SIZE} OFFSET ${from}`,
          values,
        )), 'cannot_get_channels', 'Cannot get channels') ?? []
        if (page === CHANNELS_MAX_PAGES) {
          if (data.length > 0)
            throw simpleError('too_many_channels', 'Too many channels to list', { app_id: appId, limit: CHANNELS_MAX_PAGES * CHANNELS_PAGE_SIZE })
          break
        }
        rows.push(...data)
        if (data.length < CHANNELS_PAGE_SIZE)
          break
      }
      return rows
    })

    return c.json(rows)
  },
}))

app.get('/bundles/latest', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const { app_id: appId } = parseQuery(c, appIdQuerySchema, ['app_id'])
    // Includes deleted bundles: callers use this for version name occupancy.
    const data = unwrap(await withCaller(c, client => settle(queryJsonOne(
      client,
      'SELECT id, name, deleted, created_at FROM public.app_versions WHERE app_id = $1 ORDER BY created_at DESC LIMIT 1',
      [appId],
    ))), 'cannot_get_bundle', 'Cannot get latest bundle')

    return c.json(data ?? null)
  },
}))

app.post('/bundles/deleted', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const body = await parseJson(c, setBundlesDeletedBodySchema)
    // Soft-delete / restore without the channel-link guard of DELETE /bundle:
    // channel cleanup soft-deletes linked bundles before the channel is removed.
    const data = unwrap(await withCaller(c, client => settle(queryJson<{ name: string }>(
      client,
      'UPDATE public.app_versions SET deleted = $1 WHERE app_id = $2 AND deleted = $3 AND name = ANY($4::text[]) RETURNING name',
      [body.deleted, body.app_id, !body.deleted, body.names],
    ))), 'cannot_update_bundle', 'Cannot update bundle deleted state')

    return c.json({ updated: (data ?? []).map(row => row.name) })
  },
}))

app.get('/manifest', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const { app_version_id: appVersionId } = parseQuery(c, manifestQuerySchema, ['app_version_id'])
    const rows = await withCaller(c, async (supabase) => {
      const rows: { file_name: string | null, file_hash: string | null }[] = []
      // A bundle can hold up to MAX_MANIFEST_ENTRIES files: page explicitly (1000 rows, as
      // PostgREST capped responses) so large bundles are never silently truncated.
      for (let page = 0; page < MANIFEST_MAX_PAGES; page++) {
        const from = page * MANIFEST_PAGE_SIZE
        const data = unwrap(await settle(queryJson<{ file_name: string | null, file_hash: string | null }>(
          supabase,
          `SELECT file_name, file_hash FROM public.version_manifest WHERE app_version_id = $1 ORDER BY id LIMIT ${MANIFEST_PAGE_SIZE} OFFSET ${from}`,
          [appVersionId],
        )), 'cannot_get_manifest', 'Cannot get manifest') ?? []
        rows.push(...data)
        if (data.length < MANIFEST_PAGE_SIZE)
          return rows
      }
      return null
    })
    if (rows)
      return c.json(rows)

    // Every page came back full: more rows than any valid bundle can hold. Fail loudly
    // rather than return a silently truncated manifest.
    return quickError(500, 'manifest_too_large', 'Manifest exceeds the maximum number of entries', { app_version_id: appVersionId, max: MAX_MANIFEST_ENTRIES })
  },
}))
