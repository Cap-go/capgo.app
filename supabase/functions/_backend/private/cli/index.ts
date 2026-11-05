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
import { checkPermission } from '../../utils/rbac.ts'
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
const ORG_PERMISSION_CHECK_BATCH = 10

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

async function planActionsAllowed(supabase: CallerClient, orgId: string, actions: CliPlanAction[], appId?: string): Promise<boolean> {
  const result = appId
    ? await rpc<boolean>(supabase, 'public.is_allowed_action_org_action(orgid => $1, actions => $2::public.action_type[], appid => $3)', [orgId, actions, appId])
    : await rpc<boolean>(supabase, 'public.is_allowed_action_org_action(orgid => $1, actions => $2::public.action_type[])', [orgId, actions])
  const data = unwrap(result, 'cannot_check_billing', 'Cannot check org plan actions')
  return data === true
}

/**
 * Metered plan gate. App-scoped checks run with the caller key, so a denial there
 * while the org-wide check passes means the key cannot read app billing, not that
 * the plan is exhausted.
 */
async function meteredPlanStatus(supabase: CallerClient, orgId: string, plan: 'all' | 'upload', appId?: string): Promise<CliPlanStatus> {
  if (plan === 'all' && !appId) {
    const data = unwrap(await rpc<boolean>(supabase, 'public.is_allowed_action_org(orgid => $1)', [orgId]), 'cannot_check_billing', 'Cannot check org plan allowance')
    return data === true ? 'allowed' : 'billing_denied'
  }
  const actions: CliPlanAction[] = plan === 'upload' ? ['storage'] : ALL_PLAN_ACTIONS
  if (appId && await planActionsAllowed(supabase, orgId, actions, appId))
    return 'allowed'
  const orgAllowed = await planActionsAllowed(supabase, orgId, actions)
  if (appId)
    return orgAllowed ? 'permission_denied' : 'billing_denied'
  return orgAllowed ? 'allowed' : 'billing_denied'
}

/** Days left in an unpaid trial (no paid plan, no usage credits), else null. */
async function unpaidTrialDaysLeft(supabase: CallerClient, orgId: string, appId?: string): Promise<number | null> {
  const [payingResult, trialResult, creditsResult] = await Promise.all([
    rpc<boolean>(supabase, 'public.is_paying_org(orgid => $1)', [orgId]),
    rpc<number>(supabase, 'public.is_trial_org(orgid => $1)', [orgId]),
    appId
      ? rpc<boolean>(supabase, 'public.has_usage_credits_org(orgid => $1, appid => $2)', [orgId, appId])
      : rpc<boolean>(supabase, 'public.has_usage_credits_org(orgid => $1)', [orgId]),
  ])
  const isPaying = unwrap(payingResult, 'cannot_check_billing', 'Cannot check paying org status')
  const trialDays = unwrap(trialResult, 'cannot_check_billing', 'Cannot check trial org status')
  const hasCredits = unwrap(creditsResult, 'cannot_check_billing', 'Cannot check usage credits')
  if (isPaying === true || hasCredits === true || typeof trialDays !== 'number' || trialDays <= 0)
    return null
  return trialDays
}

async function rejectedBy2fa(supabase: CallerClient, scope: { app_id?: string, org_id?: string }): Promise<boolean> {
  if (scope.app_id) {
    const data = unwrap(await rpc<boolean>(supabase, 'public.reject_access_due_to_2fa_for_app(app_id => $1)', [scope.app_id]), 'cannot_check_2fa', 'Cannot check app 2FA access')
    return data === true
  }
  if (scope.org_id) {
    const data = unwrap(await rpc<boolean>(supabase, 'public.reject_access_due_to_2fa_for_org(org_id => $1)', [scope.org_id]), 'cannot_check_2fa', 'Cannot check org 2FA access')
    return data === true
  }
  return false
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
    const rows: unknown[] = []
    for (let index = 0; index < organizations.length; index += ORG_PERMISSION_CHECK_BATCH) {
      const batch = organizations.slice(index, index + ORG_PERMISSION_CHECK_BATCH)
      rows.push(...await Promise.all(batch.map(async org => ({
        ...org,
        allowed: await checkPermission(c, permission as Permission, { orgId: org.gid }),
      }))))
    }
    return c.json(rows)
  },
}))

app.post('/permissions', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const body = await parseJson(c, permissionsBodySchema)
    assertValidAppId(body.app_id)
    const scope = permissionScope(body)
    const entries = await Promise.all([...new Set(body.permissions)].map(async permission =>
      [permission, await checkPermission(c, permission as Permission, scope)] as const,
    ))
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
  const userId = await actorUserId(supabase)
  if (!userId)
    return invalidApikey()

  // 2FA first: a key blocked by org policy learns nothing else about the app.
  if (body.check_2fa !== false && await rejectedBy2fa(supabase, body)) {
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
  const appRow = body.app_id ? await visibleApp(supabase, body.app_id) : null
  if (body.app_id && !appRow && needsApp)
    return quickError(404, 'app_not_found', 'App not found', { app_id: body.app_id })
  const orgId = body.org_id ?? appRow?.owner_org ?? null

  if (body.permission && !(await checkPermission(c, body.permission as Permission, permissionScope(body)))) {
    return quickError(403, 'permission_denied', `Missing permission ${body.permission}`, {
      permission: body.permission,
      app_id: body.app_id ?? null,
      org_id: body.org_id ?? null,
      channel_id: body.channel_id ?? null,
    })
  }

  let trialDaysLeft: number | null = null
  if (body.plan) {
    if (!orgId)
      return quickError(404, 'app_not_found', 'App not found', { app_id: body.app_id ?? null })
    const status = await meteredPlanStatus(supabase, orgId, body.plan, body.app_id)
    if (status === 'permission_denied')
      return quickError(403, 'plan_permission_denied', 'The API key cannot read plan usage for this app', { org_id: orgId, app_id: body.app_id ?? null })
    if (status === 'billing_denied')
      return quickError(402, 'plan_upgrade_required', 'Plan upgrade required', { org_id: orgId, plan: body.plan })
    trialDaysLeft = await unpaidTrialDaysLeft(supabase, orgId, body.app_id)
  }

  const warnings = body.cli_version && orgId ? await cliWarnings(supabase, orgId, body.cli_version) : []

  return {
    user_id: userId,
    org_id: orgId,
    app_id: appRow?.app_id ?? null,
    trial_days_left: trialDaysLeft,
    warnings,
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
