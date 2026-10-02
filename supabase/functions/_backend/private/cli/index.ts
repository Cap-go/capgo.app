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

const rejectAppQuerySchema = z.object({
  app_id: z.string().min(1),
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

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

app.get('/identity', middlewareKey(), async (c) => {
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const capgkey = c.get('capgkey') as string
  const supabase = supabaseApikey(c, capgkey)

  const { data: userId, error: userIdError } = await supabase.rpc('request_actor_user_id')
  if (userIdError) {
    throw simpleError('cannot_resolve_identity', 'Cannot resolve CLI identity', { error: userIdError })
  }
  if (!userId) {
    return quickError(401, 'invalid_apikey', 'Invalid apikey or insufficient permissions')
  }

  const [{ data: email, error: emailError }, { data: has2fa, error: has2faError }] = await Promise.all([
    supabase.rpc('request_actor_email_adress'),
    supabase.rpc('has_2fa_enabled'),
  ])
  if (emailError) {
    throw simpleError('cannot_resolve_identity_email', 'Cannot resolve CLI identity email', { error: emailError })
  }
  if (has2faError) {
    throw simpleError('cannot_resolve_identity_2fa', 'Cannot resolve CLI identity 2FA status', { error: has2faError })
  }

  return c.json({
    userId,
    email: email ?? null,
    has2fa: has2fa === true,
    apikey_id: apikey.id,
  })
})

app.post('/check-permission', middlewareKey(), async (c) => {
  const bodyRaw = await parseBody<unknown>(c)
  const bodyParsed = safeParseSchema(checkPermissionBodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }

  const capgkey = c.get('capgkey') as string
  const supabase = supabaseApikey(c, capgkey)
  const body = bodyParsed.data

  const { data, error } = await supabase.rpc('cli_check_permission', {
    apikey: body.apikey ?? capgkey,
    permission_key: body.permission_key,
    org_id: body.org_id ?? undefined,
    app_id: body.app_id ?? undefined,
    channel_id: body.channel_id ?? undefined,
  })

  if (error) {
    throw simpleError('cannot_check_permission', 'Cannot check CLI permission', { error })
  }

  return c.json({ allowed: data === true })
})

app.get('/organizations', middlewareKey(), async (c) => {
  const capgkey = c.get('capgkey') as string
  const supabase = supabaseApikey(c, capgkey)

  const { data: userId, error: userIdError } = await supabase.rpc('request_actor_user_id')
  if (userIdError) {
    throw simpleError('cannot_resolve_identity', 'Cannot resolve CLI identity', { error: userIdError })
  }
  if (!userId) {
    return quickError(401, 'invalid_apikey', 'Invalid apikey or insufficient permissions')
  }

  const { data, error } = await supabase.rpc('get_orgs_v7')
  if (error) {
    throw simpleError('cannot_list_organizations', 'Cannot list organizations', { error })
  }

  return c.json(data ?? [])
})

app.get('/billing/entitlements', middlewareKey(), async (c) => {
  const queryParsed = safeParseSchema(orgAppQuerySchema, {
    org_id: c.req.query('org_id'),
    app_id: c.req.query('app_id') || undefined,
  })
  if (!queryParsed.success) {
    throw simpleError('invalid_query', 'Invalid query', { error: queryParsed.error })
  }

  const capgkey = c.get('capgkey') as string
  const supabase = supabaseApikey(c, capgkey)
  const { org_id: orgId, app_id: appId } = queryParsed.data

  const [payingResult, trialResult, creditsResult] = await Promise.all([
    supabase.rpc('is_paying_org', { orgid: orgId }),
    supabase.rpc('is_trial_org', { orgid: orgId }),
    supabase.rpc('has_usage_credits_org', appId ? { orgid: orgId, appid: appId } : { orgid: orgId }),
  ])

  if (payingResult.error) {
    throw simpleError('cannot_check_billing', 'Cannot check paying org status', { error: payingResult.error })
  }
  if (trialResult.error) {
    throw simpleError('cannot_check_billing', 'Cannot check trial org status', { error: trialResult.error })
  }
  if (creditsResult.error) {
    throw simpleError('cannot_check_billing', 'Cannot check usage credits', { error: creditsResult.error })
  }

  return c.json({
    isPaying: payingResult.data === true,
    trialDays: typeof trialResult.data === 'number' ? trialResult.data : 0,
    hasCredits: creditsResult.data === true,
  })
})

app.get('/billing/allowed', middlewareKey(), async (c) => {
  const queryParsed = safeParseSchema(orgIdQuerySchema, { org_id: c.req.query('org_id') })
  if (!queryParsed.success) {
    throw simpleError('invalid_query', 'Invalid query', { error: queryParsed.error })
  }

  const capgkey = c.get('capgkey') as string
  const supabase = supabaseApikey(c, capgkey)
  const { data, error } = await supabase.rpc('is_allowed_action_org', { orgid: queryParsed.data.org_id })
  if (error) {
    throw simpleError('cannot_check_billing', 'Cannot check org plan allowance', { error })
  }

  return c.json({ allowed: data === true })
})

app.post('/billing/allowed-actions', middlewareKey(), async (c) => {
  const bodyRaw = await parseBody<unknown>(c)
  const bodyParsed = safeParseSchema(checkActionsBodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }

  const capgkey = c.get('capgkey') as string
  const supabase = supabaseApikey(c, capgkey)
  const body = bodyParsed.data
  const { data, error } = body.app_id
    ? await supabase.rpc('is_allowed_action_org_action', {
      orgid: body.org_id,
      actions: body.actions,
      appid: body.app_id,
    })
    : await supabase.rpc('is_allowed_action_org_action', {
      orgid: body.org_id,
      actions: body.actions,
    })

  if (error) {
    throw simpleError('cannot_check_billing', 'Cannot check org plan actions', { error })
  }

  return c.json({ allowed: data === true })
})

app.get('/warnings', middlewareKey(), async (c) => {
  const queryParsed = safeParseSchema(cliWarningsQuerySchema, {
    org_id: c.req.query('org_id'),
    cli_version: c.req.query('cli_version'),
  })
  if (!queryParsed.success) {
    throw simpleError('invalid_query', 'Invalid query', { error: queryParsed.error })
  }

  const capgkey = c.get('capgkey') as string
  const supabase = supabaseApikey(c, capgkey)
  const { data, error } = await supabase.rpc('get_organization_cli_warnings', {
    orgid: queryParsed.data.org_id,
    cli_version: queryParsed.data.cli_version,
  })
  if (error) {
    throw simpleError('cannot_get_cli_warnings', 'Cannot get CLI warnings', { error })
  }

  // Json[] is recursive in generated Supabase types; avoid deep Hono json() inference.
  return c.json((data ?? []) as unknown)
})

app.get('/2fa/reject-org', middlewareKey(), async (c) => {
  const queryParsed = safeParseSchema(orgIdQuerySchema, { org_id: c.req.query('org_id') })
  if (!queryParsed.success) {
    throw simpleError('invalid_query', 'Invalid query', { error: queryParsed.error })
  }

  const capgkey = c.get('capgkey') as string
  const supabase = supabaseApikey(c, capgkey)
  const { data, error } = await supabase.rpc('reject_access_due_to_2fa_for_org', {
    org_id: queryParsed.data.org_id,
  })
  if (error) {
    throw simpleError('cannot_check_2fa', 'Cannot check org 2FA access', { error })
  }

  return c.json({ reject: data === true })
})

app.get('/2fa/reject-app', middlewareKey(), async (c) => {
  const queryParsed = safeParseSchema(rejectAppQuerySchema, { app_id: c.req.query('app_id') })
  if (!queryParsed.success) {
    throw simpleError('invalid_query', 'Invalid query', { error: queryParsed.error })
  }

  const capgkey = c.get('capgkey') as string
  const supabase = supabaseApikey(c, capgkey)
  const { data, error } = await supabase.rpc('reject_access_due_to_2fa_for_app', {
    app_id: queryParsed.data.app_id,
  })
  if (error) {
    throw simpleError('cannot_check_2fa', 'Cannot check app 2FA access', { error })
  }

  return c.json({ reject: data === true })
})

app.get('/members/2fa-status', middlewareKey(), async (c) => {
  const queryParsed = safeParseSchema(orgIdQuerySchema, { org_id: c.req.query('org_id') })
  if (!queryParsed.success) {
    throw simpleError('invalid_query', 'Invalid query', { error: queryParsed.error })
  }

  const capgkey = c.get('capgkey') as string
  const supabase = supabaseApikey(c, capgkey)
  const { data, error } = await supabase.rpc('check_org_members_2fa_enabled', {
    org_id: queryParsed.data.org_id,
  })
  if (error) {
    throw simpleError('cannot_check_members_2fa', 'Cannot check org members 2FA status', { error })
  }

  return c.json(data ?? [])
})

app.post('/storage/icon', middlewareKey(), async (c) => {
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return uploadCliAppIcon(c, apikey)
})

app.get('/members/password-policy', middlewareKey(), async (c) => {
  const queryParsed = safeParseSchema(orgIdQuerySchema, { org_id: c.req.query('org_id') })
  if (!queryParsed.success) {
    throw simpleError('invalid_query', 'Invalid query', { error: queryParsed.error })
  }

  const capgkey = c.get('capgkey') as string
  const supabase = supabaseApikey(c, capgkey)
  const { data, error } = await supabase.rpc('check_org_members_password_policy', {
    org_id: queryParsed.data.org_id,
  })
  if (error) {
    throw simpleError('cannot_check_members_password_policy', 'Cannot check org members password policy', { error })
  }

  return c.json(data ?? [])
})

app.get('/apps/visible', middlewareKey(), async (c) => {
  const queryParsed = safeParseSchema(appIdQuerySchema, { app_id: c.req.query('app_id') })
  if (!queryParsed.success) {
    throw simpleError('invalid_query', 'Invalid query', { error: queryParsed.error })
  }

  const capgkey = c.get('capgkey') as string
  const { data, error } = await supabaseApikey(c, capgkey)
    .from('apps')
    .select('app_id, owner_org')
    .eq('app_id', queryParsed.data.app_id)
    .maybeSingle()
  if (error) {
    throw simpleError('cannot_get_app', 'Cannot get app', { error })
  }

  return c.json({ visible: !!data, app_id: data?.app_id ?? null, owner_org: data?.owner_org ?? null })
})

app.get('/channels', middlewareKey(), async (c) => {
  const queryParsed = safeParseSchema(channelsQuerySchema, {
    app_id: c.req.query('app_id'),
    name: c.req.query('name') || undefined,
    linked_version_id: c.req.query('linked_version_id') || undefined,
  })
  if (!queryParsed.success) {
    throw simpleError('invalid_query', 'Invalid query', { error: queryParsed.error })
  }

  const capgkey = c.get('capgkey') as string
  const { app_id: appId, name, linked_version_id: linkedVersionId } = queryParsed.data
  const supabase = supabaseApikey(c, capgkey)
  const rows: unknown[] = []
  // PostgREST caps responses (1000 rows); page so callers never see a truncated list.
  for (let page = 0; page < CHANNELS_MAX_PAGES; page++) {
    let query = supabase
      .from('channels')
      .select(CLI_CHANNEL_SELECT)
      .eq('app_id', appId)
    if (name)
      query = query.eq('name', name)
    if (linkedVersionId)
      query = query.or(`version.eq.${linkedVersionId},rollout_version.eq.${linkedVersionId}`)
    const from = page * CHANNELS_PAGE_SIZE
    const { data, error } = await query
      .order('name')
      .order('id')
      .range(from, from + CHANNELS_PAGE_SIZE - 1)
    if (error) {
      throw simpleError('cannot_get_channels', 'Cannot get channels', { error })
    }
    rows.push(...(data ?? []))
    if ((data?.length ?? 0) < CHANNELS_PAGE_SIZE)
      break
  }

  return c.json(rows)
})

app.get('/bundles/latest', middlewareKey(), async (c) => {
  const queryParsed = safeParseSchema(appIdQuerySchema, { app_id: c.req.query('app_id') })
  if (!queryParsed.success) {
    throw simpleError('invalid_query', 'Invalid query', { error: queryParsed.error })
  }

  // Includes deleted bundles: callers use this for version name occupancy.
  const capgkey = c.get('capgkey') as string
  const { data, error } = await supabaseApikey(c, capgkey)
    .from('app_versions')
    .select('id, name, deleted, created_at')
    .eq('app_id', queryParsed.data.app_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw simpleError('cannot_get_bundle', 'Cannot get latest bundle', { error })
  }

  return c.json(data ?? null)
})

app.post('/bundles/deleted', middlewareKey(), async (c) => {
  const bodyRaw = await parseBody<unknown>(c)
  const bodyParsed = safeParseSchema(setBundlesDeletedBodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }

  // Soft-delete / restore without the channel-link guard of DELETE /bundle:
  // channel cleanup soft-deletes linked bundles before the channel is removed.
  const capgkey = c.get('capgkey') as string
  const body = bodyParsed.data
  const { data, error } = await supabaseApikey(c, capgkey)
    .from('app_versions')
    .update({ deleted: body.deleted })
    .eq('app_id', body.app_id)
    .eq('deleted', !body.deleted)
    .in('name', body.names)
    .select('name')
  if (error) {
    throw simpleError('cannot_update_bundle', 'Cannot update bundle deleted state', { error })
  }

  return c.json({ updated: (data ?? []).map(row => row.name) })
})

app.get('/manifest', middlewareKey(), async (c) => {
  const queryParsed = safeParseSchema(manifestQuerySchema, { app_version_id: c.req.query('app_version_id') })
  if (!queryParsed.success) {
    throw simpleError('invalid_query', 'Invalid query', { error: queryParsed.error })
  }

  const capgkey = c.get('capgkey') as string
  const { data, error } = await supabaseApikey(c, capgkey)
    .from('manifest')
    .select('file_name, file_hash')
    .eq('app_version_id', queryParsed.data.app_version_id)
  if (error) {
    throw simpleError('cannot_get_manifest', 'Cannot get manifest', { error })
  }

  return c.json(data ?? [])
})
