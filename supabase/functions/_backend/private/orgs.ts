import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { BRES, parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { getStorageAllowedOrigins, resolveWritableImageValue } from '../utils/storage.ts'
import { supabaseClient } from '../utils/supabase.ts'

const orgIdSchema = z.uuid()

const passwordPolicyMinLengthSchema = z.number().int().min(6).refine(
  value => value <= 72,
  { message: 'a value <= 72' },
)

const passwordPolicyConfigSchema = z.object({
  enabled: z.boolean(),
  min_length: passwordPolicyMinLengthSchema,
  require_uppercase: z.boolean(),
  require_number: z.boolean(),
  require_special: z.boolean(),
})

const emailPreferencesSchema = z.record(z.string(), z.boolean())

const patchBodySchema = z.object({
  org_id: orgIdSchema,
  name: z.string().min(1).optional(),
  logo: z.string().optional(),
  password_policy_config: passwordPolicyConfigSchema.nullable().optional(),
  email_preferences: emailPreferencesSchema.optional(),
})

function parseOrgId(orgId: string | undefined): string {
  const trimmed = orgId?.trim()
  if (!trimmed)
    throw simpleError('missing_params', 'org_id is required')
  const parsed = orgIdSchema.safeParse(trimmed)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid org_id')
  return parsed.data
}

function parseOrgIds(orgIds: string | undefined): string[] {
  const trimmed = orgIds?.trim()
  if (!trimmed)
    throw simpleError('missing_params', 'ids is required')

  const ids = trimmed.split(',').map(id => id.trim()).filter(Boolean)
  if (ids.length === 0)
    throw simpleError('missing_params', 'ids is required')

  const parsed = z.array(orgIdSchema).safeParse(ids)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid ids')

  return parsed.data
}

function getAuthedSupabase(c: Parameters<typeof supabaseClient>[0]) {
  const authorization = c.get('authorization')
  if (!authorization)
    throw simpleError('not_authorized', 'Not authorized')
  return supabaseClient(c, authorization)
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

app.get('/', middlewareAuth, async (c) => {
  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase.rpc('get_orgs_v7')

  if (error)
    throw simpleError('orgs_list_error', error.message)

  return c.json(data ?? [])
})

app.get('/security-settings', middlewareAuth, async (c) => {
  const orgId = parseOrgId(c.req.query('org_id'))
  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase
    .from('orgs')
    .select('enforcing_2fa, enforce_hashed_api_keys, enforce_encrypted_bundles, required_encryption_key')
    .eq('id', orgId)
    .maybeSingle()

  if (error)
    throw simpleError('org_security_settings_error', error.message)

  if (!data)
    throw simpleError('org_not_found', 'Organization not found')

  return c.json(data)
})

app.get('/support-channel', middlewareAuth, async (c) => {
  const orgId = parseOrgId(c.req.query('org_id'))
  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase
    .from('orgs')
    .select('support_channel_type, support_channel_url')
    .eq('id', orgId)
    .maybeSingle()

  if (error)
    throw simpleError('org_support_channel_error', error.message)

  if (!data)
    throw simpleError('org_not_found', 'Organization not found')

  return c.json(data)
})

app.get('/chart-refresh-state', middlewareAuth, async (c) => {
  const orgId = parseOrgId(c.req.query('org_id'))
  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase
    .from('orgs')
    .select('stats_updated_at, stats_refresh_requested_at')
    .eq('id', orgId)
    .maybeSingle()

  if (error)
    throw simpleError('org_chart_refresh_state_error', error.message)

  if (!data)
    throw simpleError('org_not_found', 'Organization not found')

  return c.json(data)
})

app.get('/billing-paid-at', middlewareAuth, async (c) => {
  const orgId = parseOrgId(c.req.query('org_id'))
  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase
    .from('orgs')
    .select('stripe_info(paid_at)')
    .eq('id', orgId)
    .maybeSingle()

  if (error)
    throw simpleError('org_billing_paid_at_error', error.message)

  const stripeInfo = data?.stripe_info as { paid_at: string | null } | { paid_at: string | null }[] | null
  const paidAt = Array.isArray(stripeInfo)
    ? stripeInfo[0]?.paid_at ?? null
    : stripeInfo?.paid_at ?? null

  return c.json({ paid_at: paidAt })
})

app.get('/names', middlewareAuth, async (c) => {
  const orgIds = parseOrgIds(c.req.query('ids'))
  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase
    .from('orgs')
    .select('id, name')
    .in('id', orgIds)

  if (error)
    throw simpleError('org_names_error', error.message)

  return c.json(data ?? [])
})

app.patch('/', middlewareAuth, async (c) => {
  const body = await parseBody<unknown>(c)
  const parsed = patchBodySchema.safeParse(body)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error.message })

  const { org_id: orgId, ...fields } = parsed.data
  const updateFields: Partial<Database['public']['Tables']['orgs']['Update']> = {}

  if (fields.name !== undefined)
    updateFields.name = fields.name

  if (fields.logo !== undefined) {
    if (fields.logo === '') {
      updateFields.logo = ''
    }
    else {
      const allowedLogo = resolveWritableImageValue(
        fields.logo,
        { orgId },
        getStorageAllowedOrigins(c),
      )
      if (!allowedLogo)
        throw simpleError('invalid_logo_path', 'Logo path must belong to this organization')
      updateFields.logo = allowedLogo
    }
  }

  if (fields.password_policy_config !== undefined)
    updateFields.password_policy_config = fields.password_policy_config

  if (fields.email_preferences !== undefined)
    updateFields.email_preferences = fields.email_preferences

  if (Object.keys(updateFields).length === 0)
    throw simpleError('invalid_body', 'No supported fields to update')

  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase
    .from('orgs')
    .update(updateFields)
    .eq('id', orgId)
    .select('id')
    .maybeSingle()

  if (error)
    throw simpleError('org_update_error', error.message)

  if (!data)
    throw simpleError('org_not_found', 'Organization not found')

  return c.json(BRES)
})

app.delete('/', middlewareAuth, async (c) => {
  const orgId = parseOrgId(c.req.query('org_id'))
  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase
    .from('orgs')
    .delete()
    .eq('id', orgId)
    .select('id')
    .maybeSingle()

  if (error)
    throw simpleError('org_delete_error', error.message)

  if (!data)
    throw simpleError('org_not_found', 'Organization not found')

  return c.json(BRES)
})
