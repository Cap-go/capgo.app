import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { parseBody, quickError, simpleError, useCors } from '../../utils/hono.ts'
import { middlewareKey } from '../../utils/hono_middleware.ts'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { uploadCliAppIcon } from './storage_icon.ts'

const checkPermissionBodySchema = z.object({
  apikey: z.string().optional(),
  permission_key: z.string().min(1),
  org_id: z.uuid().nullable().optional(),
  app_id: z.string().nullable().optional(),
  channel_id: z.number().int().nullable().optional(),
})

const orgIdQuerySchema = z.object({
  org_id: z.uuid(),
})

const orgAppQuerySchema = z.object({
  org_id: z.uuid(),
  app_id: z.string().min(1).optional(),
})

const cliWarningsQuerySchema = z.object({
  org_id: z.uuid(),
  cli_version: z.string().min(1),
})

const actionTypeSchema = z.enum(['mau', 'storage', 'bandwidth', 'build_time'])

const checkActionsBodySchema = z.object({
  org_id: z.uuid(),
  actions: z.array(actionTypeSchema).min(1),
  app_id: z.string().min(1).optional(),
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

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

app.get('/identity', middlewareKey(), async (c) => {
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
})

app.post('/check-permission', middlewareKey(), async (c) => {
  const body = await parseJson(c, checkPermissionBodySchema)
  const data = unwrap(await callerClient(c).rpc('cli_check_permission', {
    apikey: body.apikey ?? c.get('capgkey') as string,
    permission_key: body.permission_key,
    org_id: body.org_id ?? undefined,
    app_id: body.app_id ?? undefined,
    channel_id: body.channel_id ?? undefined,
  }), 'cannot_check_permission', 'Cannot check CLI permission')

  return c.json({ allowed: data === true })
})

app.get('/organizations', middlewareKey(), async (c) => {
  const supabase = callerClient(c)
  if (!(await actorUserId(supabase)))
    return invalidApikey()

  const data = unwrap(await supabase.rpc('get_orgs_v7'), 'cannot_list_organizations', 'Cannot list organizations')
  return c.json(data ?? [])
})

app.get('/billing/entitlements', middlewareKey(), async (c) => {
  const { org_id: orgId, app_id: appId } = parseQuery(c, orgAppQuerySchema, ['org_id', 'app_id'])
  const supabase = callerClient(c)

  const [payingResult, trialResult, creditsResult] = await Promise.all([
    supabase.rpc('is_paying_org', { orgid: orgId }),
    supabase.rpc('is_trial_org', { orgid: orgId }),
    supabase.rpc('has_usage_credits_org', appId ? { orgid: orgId, appid: appId } : { orgid: orgId }),
  ])
  const isPaying = unwrap(payingResult, 'cannot_check_billing', 'Cannot check paying org status')
  const trialDays = unwrap(trialResult, 'cannot_check_billing', 'Cannot check trial org status')
  const hasCredits = unwrap(creditsResult, 'cannot_check_billing', 'Cannot check usage credits')

  return c.json({
    isPaying: isPaying === true,
    trialDays: typeof trialDays === 'number' ? trialDays : 0,
    hasCredits: hasCredits === true,
  })
})

app.get('/billing/allowed', middlewareKey(), async (c) => {
  const { org_id: orgId } = parseQuery(c, orgIdQuerySchema, ['org_id'])
  const data = unwrap(await callerClient(c).rpc('is_allowed_action_org', { orgid: orgId }), 'cannot_check_billing', 'Cannot check org plan allowance')
  return c.json({ allowed: data === true })
})

app.post('/billing/allowed-actions', middlewareKey(), async (c) => {
  const body = await parseJson(c, checkActionsBodySchema)
  const args = body.app_id
    ? { orgid: body.org_id, actions: body.actions, appid: body.app_id }
    : { orgid: body.org_id, actions: body.actions }
  const data = unwrap(await callerClient(c).rpc('is_allowed_action_org_action', args), 'cannot_check_billing', 'Cannot check org plan actions')
  return c.json({ allowed: data === true })
})

app.get('/warnings', middlewareKey(), async (c) => {
  const query = parseQuery(c, cliWarningsQuerySchema, ['org_id', 'cli_version'])
  const data = unwrap(await callerClient(c).rpc('get_organization_cli_warnings', {
    orgid: query.org_id,
    cli_version: query.cli_version,
  }), 'cannot_get_cli_warnings', 'Cannot get CLI warnings')

  // Json[] is recursive in generated Supabase types; avoid deep Hono json() inference.
  return c.json((data ?? []) as unknown)
})

app.get('/2fa/reject-org', middlewareKey(), async (c) => {
  const { org_id: orgId } = parseQuery(c, orgIdQuerySchema, ['org_id'])
  const data = unwrap(await callerClient(c).rpc('reject_access_due_to_2fa_for_org', { org_id: orgId }), 'cannot_check_2fa', 'Cannot check org 2FA access')
  return c.json({ reject: data === true })
})

app.get('/2fa/reject-app', middlewareKey(), async (c) => {
  const { app_id: appId } = parseQuery(c, appIdQuerySchema, ['app_id'])
  const data = unwrap(await callerClient(c).rpc('reject_access_due_to_2fa_for_app', { app_id: appId }), 'cannot_check_2fa', 'Cannot check app 2FA access')
  return c.json({ reject: data === true })
})

app.get('/members/2fa-status', middlewareKey(), async (c) => {
  const { org_id: orgId } = parseQuery(c, orgIdQuerySchema, ['org_id'])
  const data = unwrap(await callerClient(c).rpc('check_org_members_2fa_enabled', { org_id: orgId }), 'cannot_check_members_2fa', 'Cannot check org members 2FA status')
  return c.json(data ?? [])
})

app.get('/members/password-policy', middlewareKey(), async (c) => {
  const { org_id: orgId } = parseQuery(c, orgIdQuerySchema, ['org_id'])
  const data = unwrap(await callerClient(c).rpc('check_org_members_password_policy', { org_id: orgId }), 'cannot_check_members_password_policy', 'Cannot check org members password policy')
  return c.json(data ?? [])
})

app.post('/storage/icon', middlewareKey(), async (c) => {
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return uploadCliAppIcon(c, apikey)
})

app.get('/apps/visible', middlewareKey(), async (c) => {
  const { app_id: appId } = parseQuery(c, appIdQuerySchema, ['app_id'])
  const data = unwrap(await callerClient(c)
    .from('apps')
    .select('app_id, owner_org')
    .eq('app_id', appId)
    .maybeSingle(), 'cannot_get_app', 'Cannot get app')

  return c.json({ visible: !!data, app_id: data?.app_id ?? null, owner_org: data?.owner_org ?? null })
})

app.get('/channels', middlewareKey(), async (c) => {
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
})

app.get('/bundles/latest', middlewareKey(), async (c) => {
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
})

app.post('/bundles/deleted', middlewareKey(), async (c) => {
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
})

app.get('/manifest', middlewareKey(), async (c) => {
  const { app_version_id: appVersionId } = parseQuery(c, manifestQuerySchema, ['app_version_id'])
  const data = unwrap(await callerClient(c)
    .from('manifest')
    .select('file_name, file_hash')
    .eq('app_version_id', appVersionId), 'cannot_get_manifest', 'Cannot get manifest')

  return c.json(data ?? [])
})
