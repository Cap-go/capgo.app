import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { z } from 'zod'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { supabaseAdmin, supabaseWithAuth } from '../../utils/supabase.ts'
import { parseOrgOnboardingIntent } from '../../utils/org_onboarding_intent.ts'
import { normalizeWebsiteUrl } from './website.ts'

const MAX_ESTIMATED_MAU = 1_000_000

const estimatedMauSchema = z.number().int().min(0).refine(
  value => value <= MAX_ESTIMATED_MAU,
  { message: `a value <= ${MAX_ESTIMATED_MAU}` },
)

const bodySchema = z.object({
  name: z.string().min(3),
  email: z.email().optional(),
  estimatedMau: estimatedMauSchema.optional(),
  website: z.string().optional(),
  intent: z.enum(['ota', 'builder', 'both', 'exploring', 'unknown']).optional(),
})


interface PgTransactionClient {
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[], rowCount?: number | null }>
  release: () => void
}

async function getInitialPlanForMau(c: Context<MiddlewareKeyVariables>, estimatedMau: number) {
  const adminClient = supabaseAdmin(c)
  const { data: plan, error } = await adminClient
    .from('plans')
    .select('name, stripe_id, mau')
    .gte('mau', estimatedMau)
    .order('mau', { ascending: true })
    .limit(1)
    .single()

  if (error || !plan?.stripe_id) {
    throw simpleError('cannot_get_plan', 'Cannot get plan', { error: error?.message, estimatedMau })
  }

  return plan
}

async function createPendingStripeInfo(c: Context<MiddlewareKeyVariables>, orgId: string, estimatedMau: number) {
  const plan = await getInitialPlanForMau(c, estimatedMau)
  const pendingCustomerId = `pending_${orgId}`
  const trialAt = new Date()
  trialAt.setDate(trialAt.getDate() + 15)

  const { error } = await supabaseAdmin(c)
    .from('stripe_info')
    .insert({
      customer_id: pendingCustomerId,
      product_id: plan.stripe_id,
      trial_at: trialAt.toISOString(),
      status: null,
      is_good_plan: true,
    })

  if (error) {
    throw simpleError('cannot_create_org_plan', 'Cannot create org plan', { error: error.message, estimatedMau, plan: plan.name })
  }

  return pendingCustomerId
}

async function getOwnerEmail(c: Context<MiddlewareKeyVariables>, auth: AuthInfo) {
  if (auth.authType === 'jwt') {
    const { data: self, error } = await supabaseWithAuth(c, auth)
      .from('users')
      .select('email')
      .eq('id', auth.userId)
      .single()

    if (error || !self?.email) {
      throw simpleError('cannot_get_user', 'Cannot get user', { error: error?.message })
    }

    return self.email
  }

  let pgClient
  try {
    pgClient = getPgClient(c)
    const result = await pgClient.query<{ email: string }>(
      'SELECT email FROM public.users WHERE id = $1::uuid LIMIT 1',
      [auth.userId],
    )
    const email = result.rows[0]?.email
    if (!email) {
      throw simpleError('cannot_get_user', 'Cannot get user')
    }

    return email
  }
  finally {
    if (pgClient) {
      closeClient(c, pgClient)
    }
  }
}

async function ensureApiKeyCanCreateOrganization(c: Context<MiddlewareKeyVariables>, auth: AuthInfo) {
  if (auth.authType !== 'apikey') {
    return
  }

  const apikeyString = auth.apikey?.key ?? c.get('capgkey')
  if (!apikeyString) {
    throw quickError(401, 'invalid_apikey', 'Invalid apikey')
  }

  let pgClient
  try {
    pgClient = getPgClient(c)
    const result = await pgClient.query<{ allowed: boolean }>(
      'SELECT public.apikey_has_global_permission($1::text, public.rbac_perm_org_create()) AS allowed',
      [apikeyString],
    )
    if (result.rows[0]?.allowed !== true) {
      throw quickError(403, 'permission_denied', 'Permission denied: org.create')
    }
  }
  finally {
    if (pgClient) {
      closeClient(c, pgClient)
    }
  }
}

async function insertOrgForApiKey(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
  org: {
    id: string
    name: string
    created_by: string
    management_email: string
    customer_id: string
    website: string | null
    onboarding: { intent: string }
  },
) {
  const apikeyRbacId = auth.apikey?.rbac_id
  if (!apikeyRbacId) {
    throw quickError(401, 'invalid_apikey', 'Invalid apikey')
  }
  const apikeyValue = c.get('capgkey') ?? auth.apikey?.key
  if (!apikeyValue) {
    throw quickError(401, 'invalid_apikey', 'Invalid apikey')
  }

  // API-key Supabase clients run as anon, so this checked endpoint owns the write path instead of reopening direct anon RLS inserts.
  let pgPool: ReturnType<typeof getPgClient> | null = null
  let dbClient: PgTransactionClient | null = null
  let transactionStarted = false
  try {
    pgPool = getPgClient(c)
    dbClient = await pgPool.connect() as PgTransactionClient
    const capabilityResult = await dbClient.query<{ allowed: boolean }>(
      'SELECT public.apikey_has_current_org_create_capability($1::uuid) AS allowed',
      [apikeyRbacId],
    )
    if (capabilityResult.rows[0]?.allowed !== true) {
      throw quickError(403, 'permission_denied', 'Permission denied: org.create')
    }

    await dbClient.query('BEGIN')
    transactionStarted = true
    await dbClient.query(
      'SELECT set_config($1, $2, true)',
      ['request.headers', JSON.stringify({ capgkey: apikeyValue })],
    )

    const roleResult = await dbClient.query<{ id: string }>(
      'SELECT id FROM public.roles WHERE name = public.rbac_role_org_super_admin() AND scope_type = public.rbac_scope_org() LIMIT 1',
    )
    const orgSuperAdminRoleId = roleResult.rows[0]?.id
    if (!orgSuperAdminRoleId) {
      throw simpleError('cannot_create_org', 'Cannot create org', { error: 'missing_org_super_admin_role' })
    }

    await dbClient.query(
      `INSERT INTO public.orgs (
         id,
         name,
         created_by,
         management_email,
         customer_id,
         website,
         onboarding
       )
       VALUES ($1::uuid, $2::varchar, $3::uuid, $4::varchar, $5::varchar, $6::varchar, $7::jsonb)`,
      [org.id, org.name, org.created_by, org.management_email, org.customer_id, org.website, JSON.stringify(org.onboarding)],
    )

    await dbClient.query(
      `INSERT INTO public.role_bindings (
         principal_type,
         principal_id,
         role_id,
         scope_type,
         org_id,
         granted_by,
         granted_at,
         reason,
         is_direct
       )
       VALUES (
         public.rbac_principal_apikey(),
         $1::uuid,
         $2::uuid,
         public.rbac_scope_org(),
         $3::uuid,
         $4::uuid,
         pg_catalog.now(),
         'Auto-granted to API key on org creation',
         true
       )
       ON CONFLICT DO NOTHING`,
      [apikeyRbacId, orgSuperAdminRoleId, org.id, auth.userId],
    )

    await dbClient.query('COMMIT')
  }
  catch (error) {
    if (dbClient && transactionStarted) {
      try {
        await dbClient.query('ROLLBACK')
      }
      catch {
        // Keep the original error as the one reported to the caller.
      }
    }
    throw error
  }
  finally {
    dbClient?.release()
    if (pgPool) {
      closeClient(c, pgPool)
    }
  }
}

export async function post(
  c: Context<MiddlewareKeyVariables>,
  bodyRaw: any,
  _apikey: Database['public']['Tables']['apikeys']['Row'] | null | undefined,
): Promise<Response> {
  const bodyParsed = safeParseSchema(bodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data
  const website = normalizeWebsiteUrl(body.website)
  const estimatedMau = body.estimatedMau ?? 0

  const auth = c.get('auth') as AuthInfo | undefined
  if (!auth?.userId) {
    throw simpleError('not_authorized', 'Not authorized')
  }

  await ensureApiKeyCanCreateOrganization(c, auth)
  const ownerEmail = await getOwnerEmail(c, auth)
  const orgId = crypto.randomUUID()
  const pendingCustomerId = await createPendingStripeInfo(c, orgId, estimatedMau)
  const onboarding = { intent: parseOrgOnboardingIntent({ intent: body.intent }) }
  const newOrg = {
    id: orgId,
    name: body.name,
    created_by: auth.userId,
    management_email: body.email ?? ownerEmail,
    customer_id: pendingCustomerId,
    website,
    onboarding,
  }

  try {
    if (auth.authType === 'apikey') {
      await insertOrgForApiKey(c, auth, newOrg)
    }
    else {
      const { error: errorOrg } = await supabaseWithAuth(c, auth)
        .from('orgs')
        .insert({
          ...newOrg,
          onboarding,
        })

      if (errorOrg) {
        throw simpleError('cannot_create_org', 'Cannot create org', { error: errorOrg.message })
      }
    }
  }
  catch (error) {
    await supabaseAdmin(c)
      .from('stripe_info')
      .delete()
      .eq('customer_id', pendingCustomerId)

    throw error
  }

  return c.json({ id: orgId })
}
