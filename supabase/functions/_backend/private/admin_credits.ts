import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { z } from 'zod'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { createHono, parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { supabaseAdmin, supabaseClient } from '../utils/supabase.ts'
import { version } from '../utils/version.ts'

type AppContext = Context<MiddlewareKeyVariables, any, any>

const grantSchema = z.object({
  org_id: z.string().min(1),
  amount: z.number().min(1),
  notes: z.string().min(1).optional(),
  expires_at: z.string().optional(),
})

interface GrantRequest {
  org_id: string
  amount: number
  notes?: string
  expires_at?: string
}

interface SearchOrgsQuery {
  q?: string
}

async function verifyAdmin(c: AppContext): Promise<{ isAdmin: boolean, userId: string | null }> {
  const auth = c.get('auth')
  if (!auth || !auth.userId || auth.authType !== 'jwt' || !auth.jwt) {
    cloudlog({ requestId: c.get('requestId'), message: 'admin_verify_no_auth' })
    return { isAdmin: false, userId: null }
  }

  const userId = auth.userId
  const userSupabase = supabaseClient(c, auth.jwt)

  // is_platform_admin() is MFA-aware and must run with the caller JWT context.
  const { data: isAdmin, error: adminError } = await userSupabase.rpc('is_platform_admin')

  if (adminError) {
    cloudlog({ requestId: c.get('requestId'), message: 'is_admin_error', error: adminError })
    return { isAdmin: false, userId }
  }

  return { isAdmin: !!isAdmin, userId }
}

export const app = createHono('', version)

app.use('*', useCors)

// Grant credits to an organization (admin only)
app.post('/grant', middlewareAuth(), async (c) => {
  const { isAdmin, userId } = await verifyAdmin(c)

  if (!isAdmin) {
    cloudlog({ requestId: c.get('requestId'), message: 'not_admin_grant_attempt', userId })
    throw simpleError('not_admin', 'Only admin users can grant credits')
  }

  const body = await parseBody<GrantRequest>(c)
  const parsedBodyResult = safeParseSchema(grantSchema, body)

  if (!parsedBodyResult.success) {
    throw simpleError('invalid_json_body', 'Invalid request body', { body, parsedBodyResult })
  }

  const { org_id, amount, notes, expires_at } = parsedBodyResult.data

  cloudlog({
    requestId: c.get('requestId'),
    message: 'admin_credit_grant_request',
    adminUserId: userId,
    org_id,
    amount,
    notes,
    expires_at,
  })

  // Verify org exists using admin client
  const adminSupabase = supabaseAdmin(c)
  const { data: org, error: orgError } = await adminSupabase
    .from('orgs')
    .select('id, name, management_email')
    .eq('id', org_id)
    .single()

  if (orgError || !org) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'admin_grant_org_not_found',
      org_id,
      error: orgError,
    })
    throw simpleError('org_not_found', 'Organization not found')
  }

  const sourceRef = {
    admin_user_id: userId,
    granted_via: 'admin_ui',
    org_name: org.name,
  }

  const { data: grant, error: rpcError } = await adminSupabase
    .rpc('top_up_usage_credits', {
      p_org_id: org_id,
      p_amount: amount,
      p_expires_at: expires_at || undefined,
      p_source: 'manual',
      p_notes: notes || `Admin grant by ${userId}`,
      p_source_ref: sourceRef,
    })

  if (rpcError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'admin_credit_grant_failed',
      org_id,
      amount,
      adminUserId: userId,
      error: rpcError,
    })
    throw simpleError('grant_failed', 'Failed to grant credits', { error: rpcError })
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'admin_credit_grant_success',
    adminUserId: userId,
    org_id,
    org_name: org.name,
    amount,
    grant,
  })

  return c.json({
    success: true,
    grant,
    org: {
      id: org.id,
      name: org.name,
    },
  })
})

// Search organizations (admin only)
app.get('/search-orgs', middlewareAuth(), async (c) => {
  const { isAdmin } = await verifyAdmin(c)

  if (!isAdmin) {
    throw simpleError('not_admin', 'Only admin users can search organizations')
  }

  const query = c.req.query() as SearchOrgsQuery
  const searchTerm = query.q?.trim() || ''

  if (searchTerm.length < 2) {
    return c.json({ orgs: [] })
  }

  const adminSupabase = supabaseAdmin(c)

  // Escape special characters to avoid breaking the PostgREST filter grammar
  const sanitizedSearchTerm = searchTerm.replace(/[%_,()]/g, c => `\\${c}`)
  const ilikePattern = `%${sanitizedSearchTerm}%`

  // Check if searchTerm is a valid UUID for id.eq filter
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const isValidUuid = uuidRegex.test(searchTerm)

  // Build filter: always search by name and email, only add id.eq if it's a valid UUID
  const filterParts = [
    `name.ilike.${ilikePattern}`,
    `management_email.ilike.${ilikePattern}`,
  ]
  if (isValidUuid) {
    filterParts.push(`id.eq.${searchTerm}`)
  }

  // Search by name, email, or exact ID match (only if valid UUID)
  const { data: orgs, error } = await adminSupabase
    .from('orgs')
    .select('id, name, management_email, created_at')
    .or(filterParts.join(','))
    .order('name')
    .limit(20)

  if (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'admin_search_orgs_failed',
      searchTerm,
      error,
    })
    throw simpleError('search_failed', 'Failed to search organizations')
  }

  return c.json({ orgs: orgs || [] })
})

// Get org credit balance (admin only)
app.get('/org-balance/:orgId', middlewareAuth(), async (c) => {
  const { isAdmin } = await verifyAdmin(c)

  if (!isAdmin) {
    throw simpleError('not_admin', 'Only admin users can view organization balances')
  }

  const orgId = c.req.param('orgId')

  if (!orgId) {
    throw simpleError('missing_org_id', 'Organization ID is required')
  }

  const adminSupabase = supabaseAdmin(c)

  const { data: balance, error } = await adminSupabase
    .from('usage_credit_balances')
    .select('total_credits, available_credits, next_expiration')
    .eq('org_id', orgId)
    .single()

  if (error && error.code !== 'PGRST116') {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'admin_get_balance_failed',
      orgId,
      error,
    })
    throw simpleError('balance_fetch_failed', 'Failed to fetch balance')
  }

  return c.json({
    balance: balance || { total_credits: 0, available_credits: 0, next_expiration: null },
  })
})

// Get recent admin grants (admin only)
app.get('/grants-history', middlewareAuth(), async (c) => {
  const { isAdmin } = await verifyAdmin(c)

  if (!isAdmin) {
    throw simpleError('not_admin', 'Only admin users can view grant history')
  }

  const adminSupabase = supabaseAdmin(c)

  // Query grants with source='manual' and admin_user_id in source_ref (admin UI grants)
  const { data: grants, error } = await adminSupabase
    .from('usage_credit_grants')
    .select(`
      id,
      org_id,
      credits_total,
      notes,
      source_ref,
      granted_at,
      expires_at,
      orgs!inner (
        name,
        management_email
      )
    `)
    .eq('source', 'manual')
    .not('source_ref->admin_user_id', 'is', null)
    .order('granted_at', { ascending: false })
    .limit(50)

  if (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'admin_grants_history_failed',
      error,
    })
    throw simpleError('history_fetch_failed', 'Failed to fetch grant history')
  }

  return c.json({ grants: grants || [] })
})
