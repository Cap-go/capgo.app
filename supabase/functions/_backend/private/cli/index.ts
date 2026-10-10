import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Permission } from '../../utils/rbac.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { versionedRoute } from '../../utils/api_version.ts'
import { parseBody, quickError, simpleError, useCors } from '../../utils/hono.ts'
import { middlewareKey } from '../../utils/hono_middleware.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
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

const manifestQuerySchema = z.object({
  app_version_id: z.coerce.number().int().positive(),
})

const setBundlesDeletedBodySchema = z.object({
  app_id: z.string().min(1),
  names: z.array(z.string().min(1)).min(1).max(100),
  deleted: z.boolean(),
})

// Same columns + embeds the CLI used to read directly through PostgREST. Reads run
// with the caller API key so RLS (preview keys, channel-scoped keys) stays identical.
const CLI_CHANNEL_SELECT = `
  *,
  version_info:app_versions!channels_version_fkey(id, name, deleted),
  rollout_version_info:app_versions!channels_rollout_version_fkey(id, name, deleted)
`

type CliContext = Context<MiddlewareKeyVariables>
type CallerClient = ReturnType<typeof supabaseApikey>

/** Supabase client bound to the caller API key: RLS and RBAC RPC checks apply. */
function callerClient(c: CliContext): CallerClient {
  return supabaseApikey(c, c.get('capgkey') as string)
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
  const userId = unwrap(await supabase.rpc('request_actor_user_id'), 'cannot_resolve_identity', 'Cannot resolve CLI identity')
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
  const args = appId ? { orgid: orgId, actions, appid: appId } : { orgid: orgId, actions }
  const data = unwrap(await supabase.rpc('is_allowed_action_org_action', args), 'cannot_check_billing', 'Cannot check org plan actions')
  return data === true
}

/**
 * Metered plan gate. App-scoped checks run with the caller key, so a denial there
 * while the org-wide check passes means the key cannot read app billing, not that
 * the plan is exhausted.
 */
async function meteredPlanStatus(supabase: CallerClient, orgId: string, plan: 'all' | 'upload', appId?: string): Promise<CliPlanStatus> {
  if (plan === 'all' && !appId) {
    const data = unwrap(await supabase.rpc('is_allowed_action_org', { orgid: orgId }), 'cannot_check_billing', 'Cannot check org plan allowance')
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
    supabase.rpc('is_paying_org', { orgid: orgId }),
    supabase.rpc('is_trial_org', { orgid: orgId }),
    supabase.rpc('has_usage_credits_org', appId ? { orgid: orgId, appid: appId } : { orgid: orgId }),
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
    const data = unwrap(await supabase.rpc('reject_access_due_to_2fa_for_app', { app_id: scope.app_id }), 'cannot_check_2fa', 'Cannot check app 2FA access')
    return data === true
  }
  if (scope.org_id) {
    const data = unwrap(await supabase.rpc('reject_access_due_to_2fa_for_org', { org_id: scope.org_id }), 'cannot_check_2fa', 'Cannot check org 2FA access')
    return data === true
  }
  return false
}

async function visibleApp(supabase: CallerClient, appId: string) {
  return unwrap(await supabase
    .from('apps')
    .select('app_id, owner_org')
    .eq('app_id', appId)
    .maybeSingle(), 'cannot_get_app', 'Cannot get app')
}

async function cliWarnings(supabase: CallerClient, orgId: string, cliVersion: string): Promise<unknown[]> {
  const data = unwrap(await supabase.rpc('get_organization_cli_warnings', {
    orgid: orgId,
    cli_version: cliVersion,
  }), 'cannot_get_cli_warnings', 'Cannot get CLI warnings')
  return Array.isArray(data) ? data : []
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

app.get('/identity', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
    const supabase = callerClient(c)
    const userId = await actorUserId(supabase)
    if (!userId)
      return invalidApikey()

    const [emailResult, has2faResult] = await Promise.all([
      supabase.rpc('request_actor_email_adress'),
      supabase.rpc('has_2fa_enabled'),
    ])
    const email = unwrap(emailResult, 'cannot_resolve_identity_email', 'Cannot resolve CLI identity email')
    const has2fa = unwrap(has2faResult, 'cannot_resolve_identity_2fa', 'Cannot resolve CLI identity 2FA status')

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
    const supabase = callerClient(c)
    if (!(await actorUserId(supabase)))
      return invalidApikey()

    const organizations = unwrap(await supabase.rpc('get_orgs_v7'), 'cannot_list_organizations', 'Cannot list organizations') ?? []
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

/**
 * One call per CLI command before it acts: 2FA policy, app visibility, RBAC
 * permission, metered plan and org CLI warnings. Failures are typed errors
 * (`2fa_required`, `app_not_found`, `permission_denied`, `plan_upgrade_required`,
 * `plan_permission_denied`); success carries what the CLI needs to continue.
 */
app.post('/preflight', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const body = await parseJson(c, preflightBodySchema)
    assertValidAppId(body.app_id)
    const supabase = callerClient(c)
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

    // Channel-scoped keys may not see the app row; their channel permission decides.
    const channelScoped = body.channel_id !== undefined && body.permission?.startsWith('channel.') === true
    const appRow = body.app_id ? await visibleApp(supabase, body.app_id) : null
    if (body.app_id && !appRow && !channelScoped)
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

    // Json[] is recursive in generated Supabase types; avoid deep Hono json() inference.
    return c.json({
      user_id: userId,
      org_id: orgId,
      app_id: appRow?.app_id ?? null,
      trial_days_left: trialDaysLeft,
      warnings,
    } as unknown)
  },
}))

app.get('/members/2fa-status', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const { org_id: orgId } = parseQuery(c, orgIdQuerySchema, ['org_id'])
    const data = unwrap(await callerClient(c).rpc('check_org_members_2fa_enabled', { org_id: orgId }), 'cannot_check_members_2fa', 'Cannot check org members 2FA status')
    return c.json(data ?? [])
  },
}))

app.get('/members/password-policy', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const { org_id: orgId } = parseQuery(c, orgIdQuerySchema, ['org_id'])
    const data = unwrap(await callerClient(c).rpc('check_org_members_password_policy', { org_id: orgId }), 'cannot_check_members_password_policy', 'Cannot check org members password policy')
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
    const data = unwrap(await callerClient(c)
      .from('apps')
      .select('app_id, owner_org')
      .eq('app_id', appId)
      .maybeSingle(), 'cannot_get_app', 'Cannot get app')

    return c.json({ visible: !!data, app_id: data?.app_id ?? null, owner_org: data?.owner_org ?? null })
  },
}))

app.get('/channels', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const { app_id: appId, name, linked_version_id: linkedVersionId } = parseQuery(c, channelsQuerySchema, ['app_id', 'name', 'linked_version_id'])
    const supabase = callerClient(c)
    const rows: unknown[] = []
    // PostgREST caps responses (1000 rows); page so callers never see a truncated list.
    // One probe page past the cap: fail loudly instead of returning a silently truncated list.
    for (let page = 0; page <= CHANNELS_MAX_PAGES; page++) {
      let query = supabase
        .from('channels')
        .select(CLI_CHANNEL_SELECT)
        .eq('app_id', appId)
      if (name)
        query = query.eq('name', name)
      if (linkedVersionId)
        query = query.or(`version.eq.${linkedVersionId},rollout_version.eq.${linkedVersionId}`)
      const from = page * CHANNELS_PAGE_SIZE
      const data = unwrap(await query
        .order('name')
        .order('id')
        .range(from, from + CHANNELS_PAGE_SIZE - 1), 'cannot_get_channels', 'Cannot get channels') ?? []
      if (page === CHANNELS_MAX_PAGES) {
        if (data.length > 0)
          throw simpleError('too_many_channels', 'Too many channels to list', { app_id: appId, limit: CHANNELS_MAX_PAGES * CHANNELS_PAGE_SIZE })
        break
      }
      rows.push(...data)
      if (data.length < CHANNELS_PAGE_SIZE)
        break
    }

    return c.json(rows)
  },
}))

app.get('/bundles/latest', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const { app_id: appId } = parseQuery(c, appIdQuerySchema, ['app_id'])
    // Includes deleted bundles: callers use this for version name occupancy.
    const data = unwrap(await callerClient(c)
      .from('app_versions')
      .select('id, name, deleted, created_at')
      .eq('app_id', appId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(), 'cannot_get_bundle', 'Cannot get latest bundle')

    return c.json(data ?? null)
  },
}))

app.post('/bundles/deleted', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const body = await parseJson(c, setBundlesDeletedBodySchema)
    // Soft-delete / restore without the channel-link guard of DELETE /bundle:
    // channel cleanup soft-deletes linked bundles before the channel is removed.
    const data = unwrap(await callerClient(c)
      .from('app_versions')
      .update({ deleted: body.deleted })
      .eq('app_id', body.app_id)
      .eq('deleted', !body.deleted)
      .in('name', body.names)
      .select('name'), 'cannot_update_bundle', 'Cannot update bundle deleted state')

    return c.json({ updated: (data ?? []).map(row => row.name) })
  },
}))

app.get('/manifest', middlewareKey(), versionedRoute<CliContext>({
  [CLI_API_2025_10_01]: async (c) => {
    const { app_version_id: appVersionId } = parseQuery(c, manifestQuerySchema, ['app_version_id'])
    const data = unwrap(await callerClient(c)
      .from('manifest')
      .select('file_name, file_hash')
      .eq('app_version_id', appVersionId), 'cannot_get_manifest', 'Cannot get manifest')

    return c.json(data ?? [])
  },
}))
