import type { Context } from 'hono'
import type Stripe from 'stripe'
import type { MetricBreakdown } from '../utils/credits.ts'
import type { AuthInfo, MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PgClient } from '../utils/pg.ts'
import type { RlsPrincipal } from '../utils/pg_rls.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import {
  getAutoTopUpSettings,
  MIN_AUTO_TOP_UP_THRESHOLD,
  normalizeAutoTopUpMonthlyLimit,
  normalizeAutoTopUpThreshold,
  saveAutoTopUpSettings,
} from '../utils/credit_auto_top_up.ts'
import { getFallbackCreditProductId, priceCreditTiers } from '../utils/credits.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { getClaimsFromJWT, middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { authPrincipal, queryJson, servicePrincipal, withRlsTransaction } from '../utils/pg_rls.ts'
import { checkPermission } from '../utils/rbac.ts'
import { createOneTimeCheckout, getBillingAccountForCustomer, getCreditCheckoutDetails, getStripe, isStripeEmulatorEnabled, planProductIdOrFilter, resolvePlanCreditProductId } from '../utils/stripe.ts'
import { getEnv } from '../utils/utils.ts'

interface CreditStep {
  id: number
  step_min: number
  step_max: number
  price_per_unit: number
  type: string
  unit_factor: number
  org_id?: string | null
  created_at: string
  updated_at: string
}

interface CostCalculationRequest {
  mau: number | string
  bandwidth: number | string // in bytes
  storage: number | string // in bytes
  build_time?: number | string // in seconds
  org_id?: string
  // Usage already included in the plan, per metric. Tiers follow total
  // usage, so the overage above is priced from this point of the ladder.
  included?: Partial<Record<'mau' | 'bandwidth' | 'storage' | 'build_time', number>>
}

interface CostCalculationResponse {
  total_cost: number
  breakdown: {
    mau: MetricBreakdown
    bandwidth: MetricBreakdown
    storage: MetricBreakdown
    build_time: MetricBreakdown
  }
  usage: {
    mau: number
    bandwidth: number
    storage: number
    build_time: number
  }
}

interface StartTopUpRequest {
  orgId: string
  quantity?: number
  datafastVisitorId?: string
  datafastSessionId?: string
  affonsoReferral?: string
  // Request an in-app embedded Checkout session instead of a hosted page URL.
  embedded?: boolean
}

interface CompleteTopUpRequest {
  orgId: string
  sessionId?: string
}

const DEFAULT_TOP_UP_QUANTITY = 100
const MAX_TOP_UP_QUANTITY = 100000

type AppContext = Context<MiddlewareKeyVariables>
type PlanRow = Database['public']['Tables']['plans']['Row']

// One connection per request; each read runs in its own transaction as `principal`.
interface CallerDb { pg: PgClient, principal: RlsPrincipal }

function callerQuery<T>(db: CallerDb, text: string, values: unknown[] = []): Promise<T[]> {
  return withRlsTransaction(db.pg, db.principal, client => queryJson<T>(client, text, values))
}

// `.single()`: exactly one row, otherwise PostgREST's PGRST116 error.
function singleRow<T>(rows: T[]): T {
  if (rows.length !== 1)
    throw Object.assign(new Error('JSON object requested, multiple (or no) rows returned'), { code: 'PGRST116' })
  return rows[0]!
}

async function withCallerDb<T>(c: AppContext, run: (db: CallerDb) => Promise<T>): Promise<T> {
  const pg = await getPgClient(c)
  try {
    return await run({ pg, principal: authPrincipal(c) })
  }
  finally {
    closeClient(c, pg)
  }
}

function sortCreditSteps(steps: CreditStep[]): CreditStep[] {
  return [...steps].sort((a, b) => {
    if (a.type !== b.type)
      return a.type.localeCompare(b.type)

    if (a.step_min !== b.step_min)
      return a.step_min - b.step_min

    return a.step_max - b.step_max
  })
}

function subtractScopedRange(baseStep: CreditStep, scopedStep: CreditStep): CreditStep[] {
  const overlapStart = Math.max(baseStep.step_min, scopedStep.step_min)
  const overlapEnd = Math.min(baseStep.step_max, scopedStep.step_max)

  if (overlapStart >= overlapEnd)
    return [baseStep]

  const remainingSteps: CreditStep[] = []

  if (baseStep.step_min < overlapStart) {
    remainingSteps.push({
      ...baseStep,
      step_min: baseStep.step_min,
      step_max: overlapStart,
    })
  }

  if (overlapEnd < baseStep.step_max) {
    remainingSteps.push({
      ...baseStep,
      step_min: overlapEnd,
      step_max: baseStep.step_max,
    })
  }

  return remainingSteps
}

function preferScopedCreditSteps(steps: CreditStep[], orgId?: string): CreditStep[] {
  if (!orgId)
    return sortCreditSteps(steps)

  const stepGroups = new Map<string, { global: CreditStep[], scoped: CreditStep[] }>()

  for (const step of steps) {
    const currentGroup = stepGroups.get(step.type) ?? { global: [], scoped: [] }

    if (step.org_id === orgId)
      currentGroup.scoped.push(step)
    else
      currentGroup.global.push(step)

    stepGroups.set(step.type, currentGroup)
  }

  const normalizedSteps: CreditStep[] = []

  for (const [, group] of stepGroups.entries()) {
    const scopedSteps = sortCreditSteps(group.scoped)
    if (scopedSteps.length === 0) {
      normalizedSteps.push(...sortCreditSteps(group.global))
      continue
    }

    let remainingGlobalSteps = sortCreditSteps(group.global)
    for (const scopedStep of scopedSteps)
      remainingGlobalSteps = remainingGlobalSteps.flatMap(globalStep => subtractScopedRange(globalStep, scopedStep))

    normalizedSteps.push(...sortCreditSteps([...remainingGlobalSteps, ...scopedSteps]))
  }

  return sortCreditSteps(normalizedSteps)
}

async function requireOrgScopedPricingAccess(c: AppContext, orgId: string, authorization: string) {
  c.set('authorization', authorization)

  const claims = await getClaimsFromJWT(c, authorization)
  if (!claims?.sub) {
    throw simpleError('not_authorized', 'Not authorized')
  }

  c.set('auth', {
    userId: claims.sub,
    authType: 'jwt',
    apikey: null,
    jwt: authorization,
    claims,
  } satisfies AuthInfo)

  if (!await checkPermission(c, 'org.read', { orgId })) {
    throw simpleError('not_authorized', 'Not authorized')
  }
}

async function getScopedCreditSteps(c: AppContext, orgId?: string): Promise<CreditStep[]> {
  const authorization = c.req.header('authorization')
    ?? c.req.header('Authorization')
    ?? c.get('authorization')

  let principal: RlsPrincipal
  if (orgId) {
    if (!authorization) {
      throw simpleError('not_authorized', 'Not authorized')
    }

    await requireOrgScopedPricingAccess(c, orgId, authorization)
    principal = authPrincipal(c)
  }
  else {
    principal = servicePrincipal
  }

  let globalCredits: CreditStep[] = []
  let orgCredits: CreditStep[] = []
  const pg = await getPgClient(c)
  try {
    await withRlsTransaction(pg, principal, async (client) => {
      globalCredits = await queryJson<CreditStep>(client, 'SELECT * FROM public.capgo_credits_steps WHERE org_id IS NULL LIMIT 1000')
      if (orgId)
        orgCredits = await queryJson<CreditStep>(client, 'SELECT * FROM public.capgo_credits_steps WHERE org_id = $1 LIMIT 1000', [orgId])
    })
  }
  catch {
    throw simpleError('failed_to_fetch_pricing_data', 'Failed to fetch pricing data')
  }
  finally {
    closeClient(c, pg)
  }

  return preferScopedCreditSteps([
    ...globalCredits,
    ...orgCredits,
  ], orgId)
}

async function getCreditTopUpProductId(c: AppContext, db: CallerDb, customerId: string): Promise<{ productId: string }> {
  const billingAccount = await getBillingAccountForCustomer(c, customerId)
  const fetchSoloPlan = async () => {
    const data = singleRow(await callerQuery<PlanRow>(db, 'SELECT * FROM public.plans WHERE name = $1 LIMIT 2', ['Solo']))
    return data ? { credit_id: resolvePlanCreditProductId(data, billingAccount) } : null
  }

  let stripeInfo: { product_id: string | null } | null = null
  let stripeInfoError: unknown = null
  try {
    stripeInfo = singleRow(await callerQuery<{ product_id: string | null }>(db, 'SELECT product_id FROM public.stripe_info WHERE customer_id = $1 LIMIT 2', [customerId]))
  }
  catch (error) {
    stripeInfoError = error
  }

  if (stripeInfoError || !stripeInfo?.product_id) {
    const log = stripeInfoError ? cloudlogErr : cloudlog
    log({
      requestId: c.get('requestId'),
      message: 'credit_plan_missing',
      customerId,
      error: stripeInfoError,
    })
    const productId = await getFallbackCreditProductId(c, customerId, fetchSoloPlan)
    return { productId }
  }

  planProductIdOrFilter(stripeInfo.product_id)
  let plan: PlanRow | null = null
  let planError: unknown = null
  try {
    plan = singleRow(await callerQuery<PlanRow>(db, 'SELECT * FROM public.plans WHERE stripe_id = $1 OR stripe_id_us = $1 LIMIT 2', [stripeInfo.product_id]))
  }
  catch (error) {
    planError = error
  }

  if (planError || !plan) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'credit_top_up_product_missing',
      customerId,
      planStripeId: stripeInfo.product_id,
      error: planError,
    })
    const productId = await getFallbackCreditProductId(c, customerId, fetchSoloPlan)
    return { productId }
  }

  const productId = resolvePlanCreditProductId(plan, billingAccount)
  if (!productId) {
    const fallbackProductId = await getFallbackCreditProductId(c, customerId, fetchSoloPlan)
    return { productId: fallbackProductId }
  }

  return { productId }
}

async function resolveOrgStripeContext(c: AppContext, db: CallerDb, orgId: string) {
  const rawAuthHeader = c.req.header('authorization')
    ?? c.req.header('Authorization')
    ?? c.get('authorization')

  if (!rawAuthHeader)
    throw simpleError('not_authorized', 'Not authorized')

  if (!await checkPermission(c, 'org.update_billing', { orgId }))
    throw simpleError('not_authorized', 'Not authorized')

  // Run as the caller - RLS will block if user doesn't have access to the org
  let org: { customer_id: string | null } | undefined
  try {
    const rows = await callerQuery<{ customer_id: string | null }>(db, 'SELECT customer_id FROM public.orgs WHERE id = $1', [orgId])
    org = rows.length === 1 ? rows[0] : undefined
  }
  catch {}

  if (!org?.customer_id)
    throw simpleError('stripe_customer_missing', 'Organization does not have a Stripe customer or you don\'t have access')

  return { customerId: org.customer_id }
}

// `source_ref->>sessionId = $3 OR source_ref->>paymentIntentId = $4` for this org's purchases.
function findTopUpTransactions<T>(db: CallerDb, columns: string, orgId: string, sessionId: string, paymentIntentId?: string | null) {
  return callerQuery<T>(
    db,
    `SELECT ${columns} FROM public.usage_credit_transactions
    WHERE org_id = $1 AND transaction_type = $2
      AND (source_ref->>'sessionId' = $3${paymentIntentId ? ' OR source_ref->>\'paymentIntentId\' = $4' : ''})
    LIMIT 1`,
    paymentIntentId ? [orgId, 'purchase', sessionId, paymentIntentId] : [orgId, 'purchase', sessionId],
  )
}

async function hasProcessedCreditTopUp(
  db: CallerDb,
  orgId: string,
  sessionId: string,
  paymentIntentId?: string | null,
) {
  let data: { id: number }[] = []
  try {
    data = await findTopUpTransactions<{ id: number }>(db, 'id', orgId, sessionId, paymentIntentId)
  }
  catch (error) {
    cloudlogErr({
      message: 'credit_top_up_candidate_check_failed',
      orgId,
      sessionId,
      error,
    })
    throw simpleError('idempotency_check_failed', 'Failed to verify top-up status', { error })
  }

  return Boolean(data.length)
}

function getCheckoutSessionPaymentIntentId(session: Stripe.Checkout.Session): string | null {
  return typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id ?? null
}

async function resolveCheckoutSession(
  c: AppContext,
  stripe: ReturnType<typeof getStripe>,
  db: CallerDb,
  orgId: string,
  customerId: string,
  sessionId?: string,
) {
  if (sessionId) {
    const isValidStripeSessionId = /^cs_(?:test|live)_[a-zA-Z0-9]+$/.test(sessionId)
    const isValidEmulatorSessionId = isStripeEmulatorEnabled(c) && /^cs_[\w-]+$/.test(sessionId)

    if (!isValidStripeSessionId && !isValidEmulatorSessionId)
      throw simpleError('invalid_session_id', 'Invalid session ID format')

    return await stripe.checkout.sessions.retrieve(sessionId)
  }

  const candidateSessions: Stripe.Checkout.Session[] = []
  let startingAfter: string | undefined

  while (true) {
    const sessions = await stripe.checkout.sessions.list({
      customer: customerId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })

    candidateSessions.push(...sessions.data.filter(session =>
      session.customer === customerId
      && session.mode === 'payment'
      && session.payment_status === 'paid'
      && session.status === 'complete'
      && (
        session.client_reference_id === orgId
        || session.metadata?.orgId === orgId
      ),
    ))

    if (!sessions.has_more || sessions.data.length === 0)
      break

    startingAfter = sessions.data[sessions.data.length - 1]?.id
    if (!startingAfter)
      break
  }

  candidateSessions
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))

  let unresolvedSession: Stripe.Checkout.Session | null = null
  for (const candidateSession of candidateSessions) {
    const paymentIntentId = getCheckoutSessionPaymentIntentId(candidateSession)
    if (await hasProcessedCreditTopUp(db, orgId, candidateSession.id, paymentIntentId))
      continue

    if (unresolvedSession) {
      throw simpleError('multiple_unprocessed_sessions', 'Multiple completed checkout sessions require an explicit sessionId')
    }

    unresolvedSession = candidateSession
  }

  if (!unresolvedSession)
    throw simpleError('session_not_found', 'No completed checkout session found')

  return unresolvedSession
}

// A usage amount is a non-negative finite number, or a non-empty string of
// one. Number() alone would turn '', null, true or [] into 0.
function parseUsageAmount(value: unknown): number | null {
  let parsed: number
  if (typeof value === 'number')
    parsed = value
  else if (typeof value === 'string' && value.trim() !== '')
    parsed = Number(value)
  else
    return null
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

app.get('/', async (c) => {
  const orgId = c.req.query('org_id') ?? undefined
  const credits = await getScopedCreditSteps(c as AppContext, orgId)
  return c.json(credits)
})

app.post('/', async (c) => {
  const body = await parseBody<CostCalculationRequest>(c)
  const buildTime = Number(body.build_time ?? 0)
  const orgId = body.org_id

  // Validate inputs
  if (body.mau === undefined || body.bandwidth === undefined || body.storage === undefined) {
    throw simpleError('missing_required_fields', 'Missing required fields: mau, bandwidth, storage')
  }
  if (!Number.isFinite(buildTime) || buildTime < 0)
    throw simpleError('invalid_build_time', 'build_time must be a non-negative number')

  // Clients (the website calculator) send numeric strings: coerce once here.
  const mau = parseUsageAmount(body.mau)
  const bandwidth = parseUsageAmount(body.bandwidth)
  const storage = parseUsageAmount(body.storage)
  if (mau === null || bandwidth === null || storage === null)
    throw simpleError('invalid_usage', 'mau, bandwidth and storage must be non-negative numbers')

  const typedCredits = await getScopedCreditSteps(c as AppContext, orgId)

  const calculateMetricCost = (value: number, type: string, included: number): MetricBreakdown =>
    priceCreditTiers(typedCredits.filter(credit => credit.type === type), value, included)

  // Calculate costs
  const included = body.included ?? {}
  const mauResult = calculateMetricCost(mau, 'mau', Number(included.mau ?? 0))
  const bandwidthResult = calculateMetricCost(bandwidth, 'bandwidth', Number(included.bandwidth ?? 0))
  const storageResult = calculateMetricCost(storage, 'storage', Number(included.storage ?? 0))
  const buildTimeResult = calculateMetricCost(buildTime, 'build_time', Number(included.build_time ?? 0))

  const totalCost = mauResult.cost + bandwidthResult.cost + storageResult.cost + buildTimeResult.cost

  const response: CostCalculationResponse = {
    total_cost: totalCost,
    breakdown: {
      mau: mauResult,
      bandwidth: bandwidthResult,
      storage: storageResult,
      build_time: buildTimeResult,
    },
    usage: {
      mau,
      bandwidth,
      storage,
      build_time: buildTime,
    },
  }

  return c.json(response)
})

app.post('/start-top-up', middlewareAuth, async (c) => {
  const body = await parseBody<StartTopUpRequest>(c)
  const parsedQuantity = Number.isFinite(body.quantity) ? Math.floor(body.quantity!) : undefined
  const quantity = parsedQuantity
    ? Math.min(Math.max(parsedQuantity, 1), MAX_TOP_UP_QUANTITY)
    : DEFAULT_TOP_UP_QUANTITY
  if (!body.orgId)
    throw simpleError('missing_org_id', 'Organization id is required')

  const orgId = body.orgId
  const { customerId, productId } = await withCallerDb(c, async (db) => {
    const { customerId } = await resolveOrgStripeContext(c, db, orgId)
    return { customerId, ...await getCreditTopUpProductId(c, db, customerId) }
  })

  const baseUrl = getEnv(c, 'WEBAPP_URL')
  const successUrl = `${baseUrl}/settings/organization/credits?creditCheckout=success&session_id={CHECKOUT_SESSION_ID}`
  const cancelUrl = `${baseUrl}/settings/organization/credits?creditCheckout=cancelled`

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Starting credit top-up checkout',
    orgId: body.orgId,
    quantity,
    productId,
  })

  const checkout = await createOneTimeCheckout(
    c,
    customerId,
    productId,
    quantity,
    successUrl,
    cancelUrl,
    body.orgId,
    {
      visitorId: body.datafastVisitorId,
      sessionId: body.datafastSessionId,
    },
    body.affonsoReferral,
    body.embedded === true,
  )

  return c.json(checkout)
})

app.post('/complete-top-up', middlewareAuth, async (c) => {
  const body = await parseBody<CompleteTopUpRequest>(c)
  if (!body.orgId)
    throw simpleError('missing_parameters', 'orgId is required')

  return withCallerDb(c, db => completeTopUp(c, db, body))
})

async function completeTopUp(c: AppContext, db: CallerDb, body: CompleteTopUpRequest) {
  const { customerId } = await resolveOrgStripeContext(c, db, body.orgId)

  const billingAccount = await getBillingAccountForCustomer(c, customerId)
  const stripe = getStripe(c, billingAccount)
  const session = await resolveCheckoutSession(c, stripe, db, body.orgId, customerId, body.sessionId)
  const resolvedSessionId = session.id

  if (!session || session.customer !== customerId)
    throw simpleError('invalid_session_customer', 'Checkout session does not belong to this organization')

  if (session.mode !== 'payment')
    throw simpleError('invalid_session_mode', 'Checkout session is not a payment session')

  if (session.payment_status !== 'paid' || session.status !== 'complete')
    throw simpleError('session_not_paid', 'Checkout session is not paid')

  const { productId } = await getCreditTopUpProductId(c, db, customerId)
  const paymentIntentId = getCheckoutSessionPaymentIntentId(session)

  const { creditQuantity, itemsSummary } = await getCreditCheckoutDetails(c, session, productId, billingAccount)

  if (creditQuantity <= 0)
    throw simpleError('credit_product_not_found', 'Checkout session does not include the credit product')

  let existingTx: { id: number, grant_id: string | null, balance_after: number | null }[] = []
  try {
    existingTx = await findTopUpTransactions(db, 'id, grant_id, balance_after', body.orgId, resolvedSessionId, paymentIntentId)
  }
  catch (existingTxError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'credit_top_up_idempotency_check_failed',
      error: existingTxError,
      orgId: body.orgId,
      sessionId: resolvedSessionId,
    })

    throw simpleError('idempotency_check_failed', 'Failed to verify top-up status', { error: existingTxError })
  }

  const matchedTx = existingTx[0]

  if (matchedTx) {
    let balance: { total_credits: number | null, available_credits: number | null, next_expiration: string | null } | null = null
    try {
      balance = singleRow(await callerQuery<{ total_credits: number | null, available_credits: number | null, next_expiration: string | null }>(
        db,
        'SELECT total_credits, available_credits, next_expiration FROM public.usage_credit_balances WHERE org_id = $1 LIMIT 2',
        [body.orgId],
      ))
    }
    catch {}

    cloudlog({
      requestId: c.get('requestId'),
      message: 'Skipping credit top-up RPC due to existing transaction',
      orgId: body.orgId,
      sessionId: resolvedSessionId,
      transactionId: matchedTx.id,
    })

    return c.json({
      grant: {
        grant_id: matchedTx.grant_id,
        transaction_id: matchedTx.id,
        available_credits: balance?.available_credits ?? matchedTx.balance_after ?? 0,
        total_credits: balance?.total_credits ?? matchedTx.balance_after ?? 0,
        next_expiration: balance?.next_expiration ?? null,
      },
    })
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Completing credit top-up',
    orgId: body.orgId,
    sessionId: resolvedSessionId,
    creditQuantity,
    itemsSummary,
  })

  const sourceRef = {
    sessionId: resolvedSessionId,
    paymentIntentId,
    itemsSummary,
  }

  // SECURITY: connection role required — authenticated role lacks EXECUTE on
  // top_up_usage_credits. Auth enforced above (JWT + RBAC + Stripe verification).
  let grant: Database['public']['Functions']['top_up_usage_credits']['Returns'][number]
  try {
    grant = singleRow(await callerQuery<Database['public']['Functions']['top_up_usage_credits']['Returns'][number]>(
      { pg: db.pg, principal: servicePrincipal },
      `SELECT * FROM public.top_up_usage_credits(
        p_org_id => $1, p_amount => $2, p_source => $3, p_notes => $4, p_source_ref => $5::jsonb
      ) LIMIT 2`,
      [body.orgId, creditQuantity, 'stripe_top_up', 'Stripe Checkout credit top-up', JSON.stringify(sourceRef)],
    ))
  }
  catch (error) {
    const rpcError = error as { code?: string, message?: string, detail?: string, hint?: string }
    const rpcErrorInfo = {
      code: rpcError.code ?? null,
      message: rpcError.message ?? null,
      details: rpcError.detail ?? null,
      hint: rpcError.hint ?? null,
    }

    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'credit_top_up_rpc_failed',
      orgId: body.orgId,
      sessionId: resolvedSessionId,
      rpcError: rpcErrorInfo,
    })

    throw simpleError('top_up_failed', 'Failed to top up credits', { rpcError: rpcErrorInfo }, rpcError)
  }

  return c.json({ grant })
}

app.get('/auto-top-up', middlewareAuth, async (c) => {
  const orgId = c.req.query('orgId') ?? c.req.query('org_id')
  if (!orgId)
    throw simpleError('missing_org_id', 'Organization id is required')
  if (!await checkPermission(c, 'org.read_billing', { orgId }))
    throw simpleError('not_authorized', 'Not authorized')

  return c.json(await getAutoTopUpSettings(c as AppContext, orgId))
})

app.post('/auto-top-up', middlewareAuth, async (c) => {
  const body = await parseBody<{ orgId?: string, enabled?: boolean, threshold?: number, monthlyLimit?: number }>(c)
  if (!body.orgId)
    throw simpleError('missing_org_id', 'Organization id is required')
  if (!await checkPermission(c, 'org.update_billing', { orgId: body.orgId }))
    throw simpleError('not_authorized', 'Not authorized')

  if (body.enabled !== undefined && typeof body.enabled !== 'boolean')
    throw simpleError('invalid_enabled', 'enabled must be a boolean')

  const threshold = normalizeAutoTopUpThreshold(body.threshold)
  if (threshold === null)
    throw simpleError('invalid_threshold', `Auto top-up amount must be at least ${MIN_AUTO_TOP_UP_THRESHOLD}`)

  let monthlyLimit: number | undefined
  if (body.monthlyLimit !== undefined) {
    const normalizedLimit = normalizeAutoTopUpMonthlyLimit(body.monthlyLimit, threshold)
    if (normalizedLimit === null)
      throw simpleError('invalid_monthly_limit', 'Auto top-up monthly limit must be 0 (no limit) or at least the top-up amount')
    monthlyLimit = normalizedLimit
  }

  try {
    return c.json(await saveAutoTopUpSettings(c as AppContext, body.orgId, body.enabled === true, threshold, monthlyLimit))
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'payment_method_required')
      throw simpleError('payment_method_required', 'Add a card before enabling auto top-up')
    if (message === 'invalid_monthly_limit')
      throw simpleError('invalid_monthly_limit', 'Auto top-up monthly limit must be 0 (no limit) or at least the top-up amount')
    if (message === 'stripe_customer_missing')
      throw simpleError('stripe_customer_missing', 'Organization does not have a Stripe customer')
    cloudlogErr({ requestId: c.get('requestId'), message: 'auto_top_up_save_failed', orgId: body.orgId, error })
    throw simpleError('auto_top_up_save_failed', 'Failed to save auto top-up settings')
  }
})
