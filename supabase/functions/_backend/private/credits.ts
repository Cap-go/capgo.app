import type { Context } from 'hono'
import type Stripe from 'stripe'
import type { AuthInfo, MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { getFallbackCreditProductId } from '../utils/credits.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { getClaimsFromJWT, middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { checkPermission } from '../utils/rbac.ts'
import { createOneTimeCheckout, getCreditCheckoutDetails, getStripe, isStripeEmulatorEnabled } from '../utils/stripe.ts'
import { supabaseAdmin, supabaseClient } from '../utils/supabase.ts'
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
  mau: number
  bandwidth: number // in bytes
  storage: number // in bytes
  build_time?: number // in seconds
  org_id?: string
}

interface TierUsage {
  tier_id: number
  step_min: number
  step_max: number
  unit_factor: number
  units_used: number // billing units (GiB/minutes/count)
  price_per_unit: number // Price per billing unit
  cost: number
}

interface MetricBreakdown {
  cost: number
  tiers: TierUsage[]
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
}

interface CompleteTopUpRequest {
  orgId: string
  sessionId?: string
}

const DEFAULT_TOP_UP_QUANTITY = 100
const MAX_TOP_UP_QUANTITY = 100000

type AppContext = Context<MiddlewareKeyVariables, any, any>

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
  } satisfies AuthInfo)

  if (!await checkPermission(c, 'org.read', { orgId })) {
    throw simpleError('not_authorized', 'Not authorized')
  }
}

async function getScopedCreditSteps(c: AppContext, orgId?: string): Promise<CreditStep[]> {
  const authorization = c.req.header('authorization')
    ?? c.req.header('Authorization')
    ?? c.get('authorization')

  let pricingClient: ReturnType<typeof supabaseAdmin> | ReturnType<typeof supabaseClient> | undefined
  if (orgId) {
    if (!authorization) {
      throw simpleError('not_authorized', 'Not authorized')
    }

    await requireOrgScopedPricingAccess(c, orgId, authorization)
    pricingClient = supabaseClient(c, authorization)
  }
  else {
    pricingClient = supabaseAdmin(c)
  }

  if (!pricingClient)
    throw simpleError('not_authorized', 'Not authorized')

  const scopedPricingClient = pricingClient

  const [globalCreditsResult, orgCreditsResult] = await Promise.all([
    scopedPricingClient
      .from('capgo_credits_steps')
      .select()
      .is('org_id', null),
    orgId
      ? scopedPricingClient
          .from('capgo_credits_steps')
          .select()
          .eq('org_id', orgId)
      : Promise.resolve({ data: [] as CreditStep[], error: null }),
  ])

  const { data: globalCredits, error: globalCreditsError } = globalCreditsResult
  const { data: orgCredits, error: orgCreditsError } = orgCreditsResult

  if (globalCreditsError || orgCreditsError)
    throw simpleError('failed_to_fetch_pricing_data', 'Failed to fetch pricing data')

  return preferScopedCreditSteps([
    ...((globalCredits ?? []) as CreditStep[]),
    ...((orgCredits ?? []) as CreditStep[]),
  ], orgId)
}

async function getCreditTopUpProductId(c: AppContext, customerId: string, token: string): Promise<{ productId: string }> {
  const supabase = supabaseClient(c, token)
  const { data: stripeInfo, error: stripeInfoError } = await supabase
    .from('stripe_info')
    .select('product_id')
    .eq('customer_id', customerId)
    .single()

  if (stripeInfoError || !stripeInfo?.product_id) {
    const log = stripeInfoError ? cloudlogErr : cloudlog
    log({
      requestId: c.get('requestId'),
      message: 'credit_plan_missing',
      customerId,
      error: stripeInfoError,
    })
    const productId = await getFallbackCreditProductId(c, customerId, async () => {
      const { data, error } = await supabase
        .from('plans')
        .select('credit_id')
        .eq('name', 'Solo')
        .single()
      if (error)
        throw error
      return data ?? null
    })
    return { productId }
  }

  const { data: plan, error: planError } = await supabase
    .from('plans')
    .select('credit_id, name')
    .eq('stripe_id', stripeInfo.product_id)
    .single()

  if (planError || !plan?.credit_id) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'credit_top_up_product_missing',
      customerId,
      planStripeId: stripeInfo.product_id,
      error: planError,
    })
    const productId = await getFallbackCreditProductId(c, customerId, async () => {
      const { data, error } = await supabase
        .from('plans')
        .select('credit_id')
        .eq('name', 'Solo')
        .single()
      if (error)
        throw error
      return data ?? null
    })
    return { productId }
  }

  return { productId: plan.credit_id }
}

async function resolveOrgStripeContext(c: AppContext, orgId: string) {
  const rawAuthHeader = c.req.header('authorization')
    ?? c.req.header('Authorization')
    ?? c.get('authorization')

  if (!rawAuthHeader)
    throw simpleError('not_authorized', 'Not authorized')

  if (!await checkPermission(c, 'org.update_billing', { orgId }))
    throw simpleError('not_authorized', 'Not authorized')

  // Use authenticated client - RLS will enforce access based on JWT
  const supabase = supabaseClient(c, rawAuthHeader)

  // Get org - RLS will block if user doesn't have access
  const { data: org, error: orgError } = await supabase
    .from('orgs')
    .select('customer_id')
    .eq('id', orgId)
    .single()

  if (orgError || !org?.customer_id)
    throw simpleError('stripe_customer_missing', 'Organization does not have a Stripe customer or you don\'t have access')

  return { customerId: org.customer_id, token: rawAuthHeader }
}

async function hasProcessedCreditTopUp(
  supabase: ReturnType<typeof supabaseClient>,
  orgId: string,
  sessionId: string,
  paymentIntentId?: string | null,
) {
  const sourceMatchFilters = [`source_ref->>sessionId.eq.${sessionId}`]
  if (paymentIntentId)
    sourceMatchFilters.push(`source_ref->>paymentIntentId.eq.${paymentIntentId}`)

  const { data, error } = await supabase
    .from('usage_credit_transactions')
    .select('id')
    .eq('org_id', orgId)
    .eq('transaction_type', 'purchase')
    .or(sourceMatchFilters.join(','))
    .limit(1)

  if (error) {
    cloudlogErr({
      message: 'credit_top_up_candidate_check_failed',
      orgId,
      sessionId,
      error,
    })
    throw simpleError('idempotency_check_failed', 'Failed to verify top-up status', { error })
  }

  return Boolean(data?.length)
}

function getCheckoutSessionPaymentIntentId(session: Stripe.Checkout.Session): string | null {
  return typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id ?? null
}

async function resolveCheckoutSession(
  c: AppContext,
  stripe: ReturnType<typeof getStripe>,
  supabase: ReturnType<typeof supabaseClient>,
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
    if (await hasProcessedCreditTopUp(supabase, orgId, candidateSession.id, paymentIntentId))
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
  const { mau, bandwidth, org_id: orgId, storage } = body

  // Validate inputs
  if (mau === undefined || bandwidth === undefined || storage === undefined) {
    throw simpleError('missing_required_fields', 'Missing required fields: mau, bandwidth, storage')
  }
  if (!Number.isFinite(buildTime) || buildTime < 0)
    throw simpleError('invalid_build_time', 'build_time must be a non-negative number')

  const typedCredits = await getScopedCreditSteps(c as AppContext, orgId)

  // Calculate cost for each metric type with tier breakdown
  const calculateMetricCost = (value: number, type: string): MetricBreakdown => {
    if (value <= 0)
      return { cost: 0, tiers: [] }

    const applicableSteps = typedCredits.filter(credit => credit.type === type)
    const tiersUsed: TierUsage[] = []
    let remainingValue = value
    let totalCost = 0

    for (const step of applicableSteps) {
      const stepMin = step.step_min
      const stepMax = step.step_max
      const unitFactor = step.unit_factor || 1

      if (remainingValue > 0 && value >= stepMin) {
        const tierUsageBytes = Math.min(remainingValue, stepMax - stepMin)

        // Convert using unit_factor and round up for pricing
        const tierUsage = Math.ceil(tierUsageBytes / unitFactor)
        const tierCost = tierUsage * step.price_per_unit

        tiersUsed.push({
          tier_id: step.id,
          step_min: stepMin,
          step_max: stepMax,
          unit_factor: step.unit_factor || 1,
          units_used: tierUsage,
          price_per_unit: step.price_per_unit,
          cost: tierCost,
        })

        totalCost += tierCost
        remainingValue -= tierUsageBytes

        if (remainingValue <= 0)
          break
      }
    }

    // If there's still remaining value, use the highest tier
    if (remainingValue > 0) {
      const highestStep = applicableSteps[applicableSteps.length - 1]
      if (highestStep) {
        const unitFactor = highestStep.unit_factor || 1

        // Convert using unit_factor and round up
        const tierUsage = Math.ceil(remainingValue / unitFactor)
        const tierCost = tierUsage * highestStep.price_per_unit

        const stepMin = highestStep.step_min

        tiersUsed.push({
          tier_id: highestStep.id,
          step_min: stepMin,
          step_max: highestStep.step_max,
          unit_factor: highestStep.unit_factor || 1,
          units_used: tierUsage,
          price_per_unit: highestStep.price_per_unit,
          cost: tierCost,
        })

        totalCost += tierCost
      }
    }

    return { cost: totalCost, tiers: tiersUsed }
  }

  // Calculate costs
  const mauResult = calculateMetricCost(mau, 'mau')
  const bandwidthResult = calculateMetricCost(bandwidth, 'bandwidth')
  const storageResult = calculateMetricCost(storage, 'storage')
  const buildTimeResult = calculateMetricCost(buildTime, 'build_time')

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

  const { customerId, token } = await resolveOrgStripeContext(c, body.orgId)

  const baseUrl = getEnv(c, 'WEBAPP_URL')
  const successUrl = `${baseUrl}/settings/organization/credits?creditCheckout=success&session_id={CHECKOUT_SESSION_ID}`
  const cancelUrl = `${baseUrl}/settings/organization/credits?creditCheckout=cancelled`

  const { productId } = await getCreditTopUpProductId(c, customerId, token)

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
  )

  return c.json({ url: checkout.url })
})

app.post('/complete-top-up', middlewareAuth, async (c) => {
  const body = await parseBody<CompleteTopUpRequest>(c)
  if (!body.orgId)
    throw simpleError('missing_parameters', 'orgId is required')

  const { customerId, token } = await resolveOrgStripeContext(c, body.orgId)
  const supabase = supabaseClient(c, token)

  const stripe = getStripe(c)
  const session = await resolveCheckoutSession(c, stripe, supabase, body.orgId, customerId, body.sessionId)
  const resolvedSessionId = session.id

  if (!session || session.customer !== customerId)
    throw simpleError('invalid_session_customer', 'Checkout session does not belong to this organization')

  if (session.mode !== 'payment')
    throw simpleError('invalid_session_mode', 'Checkout session is not a payment session')

  if (session.payment_status !== 'paid' || session.status !== 'complete')
    throw simpleError('session_not_paid', 'Checkout session is not paid')

  const { productId } = await getCreditTopUpProductId(c, customerId, token)
  const paymentIntentId = getCheckoutSessionPaymentIntentId(session)

  const { creditQuantity, itemsSummary } = await getCreditCheckoutDetails(c, session, productId)

  if (creditQuantity <= 0)
    throw simpleError('credit_product_not_found', 'Checkout session does not include the credit product')

  const sourceMatchFilters = [`source_ref->>sessionId.eq.${resolvedSessionId}`]
  if (paymentIntentId)
    sourceMatchFilters.push(`source_ref->>paymentIntentId.eq.${paymentIntentId}`)

  const { data: existingTx, error: existingTxError } = await supabase
    .from('usage_credit_transactions')
    .select('id, grant_id, balance_after')
    .eq('org_id', body.orgId)
    .eq('transaction_type', 'purchase')
    .or(sourceMatchFilters.join(','))
    .limit(1)

  if (existingTxError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'credit_top_up_idempotency_check_failed',
      error: existingTxError,
      orgId: body.orgId,
      sessionId: resolvedSessionId,
    })

    throw simpleError('idempotency_check_failed', 'Failed to verify top-up status', { error: existingTxError })
  }

  const matchedTx = existingTx?.[0]

  if (matchedTx) {
    const { data: balance } = await supabase
      .from('usage_credit_balances')
      .select('total_credits, available_credits, next_expiration')
      .eq('org_id', body.orgId)
      .single()

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

  // SECURITY: supabaseAdmin required — authenticated role lacks EXECUTE on
  // top_up_usage_credits. Auth enforced above (JWT + RBAC + Stripe verification).
  const { data: grant, error: rpcError } = await supabaseAdmin(c)
    .rpc('top_up_usage_credits', {
      p_org_id: body.orgId,
      p_amount: creditQuantity,
      p_source: 'stripe_top_up',
      p_notes: 'Stripe Checkout credit top-up',
      p_source_ref: sourceRef,
    })
    .single()

  if (rpcError) {
    const rpcErrorInfo = {
      code: rpcError.code ?? null,
      message: rpcError.message ?? null,
      details: (rpcError as any)?.details ?? null,
      hint: (rpcError as any)?.hint ?? null,
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
})
