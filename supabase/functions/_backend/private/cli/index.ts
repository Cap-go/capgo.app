import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { parseBody, quickError, simpleError, useCors } from '../../utils/hono.ts'
import { middlewareKey } from '../../utils/hono_middleware.ts'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { supabaseApikey } from '../../utils/supabase.ts'

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
