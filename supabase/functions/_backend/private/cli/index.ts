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

  const { data: email, error: emailError } = await supabase.rpc('request_actor_email_adress')
  if (emailError) {
    throw simpleError('cannot_resolve_identity_email', 'Cannot resolve CLI identity email', { error: emailError })
  }

  const { data: has2fa, error: has2faError } = await supabase.rpc('has_2fa_enabled')
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
    org_id: body.org_id ?? null,
    app_id: body.app_id ?? null,
    channel_id: body.channel_id ?? null,
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
