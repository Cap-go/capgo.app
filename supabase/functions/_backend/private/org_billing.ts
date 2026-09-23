import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { findBestPlan } from '../utils/plans.ts'
import { supabaseClient } from '../utils/supabase.ts'

const DEFAULT_PLAN_NAME = 'Solo'

interface FindBestPlanBody {
  mau?: number
  bandwidth: number
  storage: number
  build_time_unit?: number
}

function parseOrgId(orgId: string | undefined): string {
  const trimmed = orgId?.trim()
  if (!trimmed)
    throw simpleError('missing_params', 'org_id is required')
  if (!z.uuid().safeParse(trimmed).success)
    throw simpleError('invalid_body', 'Invalid org_id')
  return trimmed
}

function getAuthedSupabase(c: Parameters<typeof supabaseClient>[0]) {
  const authorization = c.get('authorization')
  if (!authorization)
    throw simpleError('not_authorized', 'Not authorized')
  return supabaseClient(c, authorization)
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

app.get('/platform-admin', middlewareAuth, async (c) => {
  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase.rpc('is_platform_admin').single()
  if (error)
    throw simpleError('is_admin_error', error.message)

  return c.json({ is_admin: data ?? false })
})

app.get('/plan-name', middlewareAuth, async (c) => {
  const orgId = parseOrgId(c.req.query('org_id'))
  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase.rpc('get_current_plan_name_org', { orgid: orgId }).single()
  if (error)
    throw simpleError('plan_name_error', error.message)

  return c.json({ plan_name: data ?? DEFAULT_PLAN_NAME })
})

app.get('/usage-percent', middlewareAuth, async (c) => {
  const orgId = parseOrgId(c.req.query('org_id'))
  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase.rpc('get_plan_usage_percent_detailed', { orgid: orgId }).single()
  if (error)
    throw simpleError('plan_usage_error', error.message)

  return c.json(data ?? {
    total_percent: 0,
    mau_percent: 0,
    bandwidth_percent: 0,
    storage_percent: 0,
    build_time_percent: 0,
  })
})

app.get('/total-storage', middlewareAuth, async (c) => {
  const orgId = parseOrgId(c.req.query('org_id'))
  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase.rpc('get_total_storage_size_org', { org_id: orgId }).single()
  if (error)
    throw simpleError('total_storage_error', error.message)

  return c.json({ bytes: data ?? 0 })
})

app.get('/is-paying', middlewareAuth, async (c) => {
  const orgId = parseOrgId(c.req.query('org_id'))
  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase.rpc('is_paying_org', { orgid: orgId }).single()
  if (error)
    throw simpleError('is_paying_error', error.message)

  return c.json({ is_paying: data ?? false })
})

app.get('/credit-deductions', middlewareAuth, async (c) => {
  const orgId = parseOrgId(c.req.query('org_id'))
  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase
    .from('usage_credit_ledger')
    .select('*')
    .eq('org_id', orgId)
    .eq('transaction_type', 'deduction')
    .order('occurred_at', { ascending: false })

  if (error)
    throw simpleError('credit_deductions_error', error.message)

  return c.json(data ?? [])
})

app.post('/find-best-plan', middlewareAuth, async (c) => {
  const body = await parseBody<FindBestPlanBody>(c)
  if (body.bandwidth === undefined || body.storage === undefined)
    throw simpleError('missing_params', 'bandwidth and storage are required')

  const planName = await findBestPlan(c, {
    mau: body.mau ?? 0,
    bandwidth: body.bandwidth,
    storage: body.storage,
    build_time_unit: body.build_time_unit ?? 0,
  })

  return c.json({ plan_name: planName })
})
