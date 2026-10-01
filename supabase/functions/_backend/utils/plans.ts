import type { Context } from 'hono'
import type { getDrizzleClient } from './pg.ts'
import type { PlanUsage } from './supabase.ts'
import type { Database } from './supabase.types.ts'
import { sql } from 'drizzle-orm'
import { maybeAutoTopUpCredits } from './credit_auto_top_up.ts'
import { quickError } from './hono.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { sendNotifToOrgMembers, sendNotifToOrgMembersOnce } from './org_email_notifications.ts'
import { buildOnboardingIntentBentoEventData, parseOrgOnboardingIntent } from './org_onboarding_intent.ts'
import { syncSubscriptionData } from './stripe.ts'
import {
  getCurrentPlanNameOrg,
  getPlanUsageAndFit,
  getPlanUsageAndFitUncached,
  getPlanUsagePercent,
  getTotalStats,
  isGoodPlanOrg,
  isOnboardedOrg,
  isOnboardingNeeded,
  isTrialOrg,
  supabaseAdmin,
} from './supabase.ts'
import { sendEventToTracking } from './tracking.ts'
import { isStripeConfigured } from './utils.ts'

type CreditMetric = Database['public']['Enums']['credit_metric_type']
type PlanUsageMetric = Exclude<keyof PlanUsage, 'total_percent'>

const PLAN_USAGE_ALERT_THRESHOLDS = [90, 70, 50] as const
const PLAN_USAGE_ALERT_EVENT_BY_THRESHOLD: Record<(typeof PLAN_USAGE_ALERT_THRESHOLDS)[number], string> = {
  50: 'user:usage_50_percent_of_plan',
  70: 'user:usage_70_percent_of_plan',
  90: 'user:usage_90_percent_of_plan',
}
const PLAN_USAGE_METRICS: Array<{ key: PlanUsageMetric, metric: CreditMetric }> = [
  { key: 'mau_percent', metric: 'mau' },
  { key: 'bandwidth_percent', metric: 'bandwidth' },
  { key: 'storage_percent', metric: 'storage' },
  { key: 'build_time_percent', metric: 'build_time' },
]

interface StripeInfoForPlanCheck {
  subscription_id: string | null
  subscription_anchor_start?: string | null
  subscription_anchor_end?: string | null
  status?: Database['public']['Enums']['stripe_status'] | null
  trial_at?: string | null
}

interface OrgWithCustomerInfo {
  customer_id: string | null
  has_usage_credits?: boolean | null
  name?: string | null
  website?: string | null
  stripe_info: StripeInfoForPlanCheck | null
}

interface BillingCycleRange {
  subscription_anchor_start: string
  subscription_anchor_end: string
}

interface CreditApplicationResult {
  overage_amount: number
  credits_required: number
  credits_applied: number
  credits_remaining: number
  overage_covered: number
  overage_unpaid: number
  credit_step_id: number | null
}

interface PlanExceededFlags {
  bandwidth_exceeded: boolean
  build_time_exceeded: boolean
  mau_exceeded: boolean
  storage_exceeded: boolean
}

interface PlanNotificationResult {
  exceededFlags: PlanExceededFlags | null
  finalIsGoodPlan: boolean
}

interface UserAbovePlanResult {
  exceededFlags: PlanExceededFlags | null
  needsUpgrade: boolean
}

const EXCEEDED_FLAG_BY_METRIC: Record<CreditMetric, keyof PlanExceededFlags> = {
  bandwidth: 'bandwidth_exceeded',
  build_time: 'build_time_exceeded',
  mau: 'mau_exceeded',
  storage: 'storage_exceeded',
}

function createEmptyExceededFlags(): PlanExceededFlags {
  return {
    bandwidth_exceeded: false,
    build_time_exceeded: false,
    mau_exceeded: false,
    storage_exceeded: false,
  }
}

function getHighestPlanUsage(percentUsage: PlanUsage) {
  return PLAN_USAGE_METRICS.reduce((highest, current) => {
    const percent = Number(percentUsage[current.key] ?? 0)
    if (percent > highest.percent) {
      return {
        metric: current.metric,
        percent,
      }
    }
    return highest
  }, {
    metric: 'mau' as CreditMetric,
    percent: 0,
  })
}

function normalizePlanUsage(percentUsage: PlanUsage): PlanUsage {
  const highestUsage = getHighestPlanUsage(percentUsage)
  return {
    ...percentUsage,
    total_percent: highestUsage.percent,
  }
}

function getPlanUsageAlert(percentUsage: PlanUsage) {
  const normalizedUsage = normalizePlanUsage(percentUsage)
  const highestUsage = getHighestPlanUsage(normalizedUsage)
  const threshold = PLAN_USAGE_ALERT_THRESHOLDS.find(value => highestUsage.percent >= value)
  if (!threshold)
    return null

  return {
    eventName: PLAN_USAGE_ALERT_EVENT_BY_THRESHOLD[threshold],
    metric: highestUsage.metric,
    metricPercent: highestUsage.percent,
    percentUsage: normalizedUsage,
    threshold,
  }
}

function isFutureTimestamp(value: string | null | undefined): boolean {
  if (!value)
    return false

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp > Date.now()
}

function isActivePlanStatus(status: string | null | undefined): boolean {
  return status === 'succeeded'
}

function hasActivePlanEntitlement(org: Pick<OrgWithCustomerInfo, 'stripe_info'>): boolean {
  const stripeInfo = org.stripe_info
  if (!stripeInfo)
    return false

  if (isFutureTimestamp(stripeInfo.trial_at))
    return true

  if (!isActivePlanStatus(stripeInfo.status))
    return false

  if (!stripeInfo.subscription_anchor_end)
    return true

  const subscriptionEnd = Date.parse(stripeInfo.subscription_anchor_end)
  if (!Number.isFinite(subscriptionEnd))
    return true

  return subscriptionEnd > Date.now()
}

function isCreditOnlyBillingOrg(org: Pick<OrgWithCustomerInfo, 'has_usage_credits' | 'stripe_info'>): boolean {
  return org.has_usage_credits === true && !hasActivePlanEntitlement(org)
}

// Overage/credit application is keyed by billing_cycle_start/end, so it must
// only ever use the SQL cycle (get_cycle_info_org). Never substitute a guessed
// range here: a different key re-debits credits for the same period.
async function getBillingCycleRange(c: Context, orgId: string): Promise<BillingCycleRange | null> {
  try {
    const { data, error } = await supabaseAdmin(c)
      .rpc('get_cycle_info_org', { orgid: orgId })
      .single()
    if (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'getBillingCycleRange error', orgId, error })
      return null
    }
    if (!data?.subscription_anchor_start || !data?.subscription_anchor_end) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'getBillingCycleRange missing cycle',
        orgId,
        billingCycle: data,
      })
      return null
    }
    return data as BillingCycleRange
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getBillingCycleRange error', orgId, error })
    return null
  }
}

async function applyCreditsForMetric(
  c: Context,
  orgId: string,
  metric: CreditMetric,
  overageAmount: number,
  planId: string | undefined,
  usage: number,
  limit: number | null | undefined,
  billingCycle: BillingCycleRange,
): Promise<CreditApplicationResult | null> {
  if (overageAmount <= 0)
    return null

  if (!planId) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'applyCreditsForMetric missing plan context, continuing',
      orgId,
      metric,
      billingCycle,
    })
  }
  try {
    const { data, error } = await supabaseAdmin(c)
      .rpc('apply_usage_overage', {
        p_org_id: orgId,
        p_metric: metric,
        p_overage_amount: overageAmount,
        p_billing_cycle_start: billingCycle.subscription_anchor_start,
        p_billing_cycle_end: billingCycle.subscription_anchor_end,
        p_details: {
          usage,
          limit: limit ?? 0,
        },
        // Tiers follow total usage: price the overage above the plan limit.
        p_included_amount: Math.max(Number(limit ?? 0), 0),
      })
      .single()

    if (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'apply_usage_overage error', orgId, metric, overageAmount, error })
      return {
        overage_amount: overageAmount,
        credits_required: 0,
        credits_applied: 0,
        credits_remaining: 0,
        overage_covered: 0,
        overage_unpaid: overageAmount,
        credit_step_id: null,
      }
    }

    return {
      overage_amount: Number(data?.overage_amount ?? overageAmount),
      credits_required: Number(data?.credits_required ?? 0),
      credits_applied: Number(data?.credits_applied ?? 0),
      credits_remaining: Number(data?.credits_remaining ?? 0),
      overage_covered: Number(data?.overage_covered ?? 0),
      overage_unpaid: Number(data?.overage_unpaid ?? overageAmount),
      credit_step_id: data?.credit_step_id ?? null,
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'applyCreditsForMetric exception', orgId, metric, overageAmount, error })
    return {
      overage_amount: overageAmount,
      credits_required: 0,
      credits_applied: 0,
      credits_remaining: 0,
      overage_covered: 0,
      overage_unpaid: overageAmount,
      credit_step_id: null,
    }
  }
}

function planToInt(plan: string) {
  switch (plan) {
    case 'Solo':
      return 1
    case 'Maker':
      return 2
    case 'Team':
      return 3
    case 'Enterprise':
      return 4
    default:
      return 1
  }
}

interface FindBestPlanArgs {
  mau: number
  bandwidth: number
  storage: number
  build_time_unit?: number
}

export async function findBestPlan(c: Context, stats: Database['public']['Functions']['find_best_plan_v3']['Args'] | FindBestPlanArgs): Promise<string> {
  const buildTimeSeconds = 'build_time_unit' in stats ? stats.build_time_unit : 0

  const { data, error } = await supabaseAdmin(c)
    .rpc('find_best_plan_v3', {
      mau: stats.mau ?? 0,
      bandwidth: stats.bandwidth,
      storage: stats.storage,
      build_time_unit: buildTimeSeconds ?? 0,
    })
    .single()
  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'findBestPlan', error })
    throw new Error(error.message)
  }

  return data ?? 'Team'
}

async function userAbovePlan(c: Context, org: {
  customer_id: string | null
  has_usage_credits?: boolean | null
  stripe_info: {
    subscription_id: string | null
    status?: Database['public']['Enums']['stripe_status'] | null
    trial_at?: string | null
    subscription_anchor_end?: string | null
  } | null
}, orgId: string, is_good_plan: boolean, drizzleClient: ReturnType<typeof getDrizzleClient>, forceCreditMode = false): Promise<UserAbovePlanResult> {
  const creditOnlyMode = forceCreditMode || isCreditOnlyBillingOrg(org)
  cloudlog({ requestId: c.get('requestId'), message: 'userAbovePlan', orgId, is_good_plan, creditOnlyMode })
  const hasActivePlan = hasActivePlanEntitlement(org)
  const totalStats = await getTotalStats(c, orgId)
  if (!totalStats) {
    return { exceededFlags: null, needsUpgrade: false }
  }

  const currentPlanName = await getCurrentPlanNameOrg(c, orgId)
  let currentPlan: Database['public']['Tables']['plans']['Row'] | null = null
  const { data, error: currentPlanError } = await supabaseAdmin(c)
    .from('plans')
    .select('*')
    .eq('name', currentPlanName)
    .single()
  if (currentPlanError) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'currentPlanError', error: currentPlanError })
  }
  currentPlan = data ?? null

  const billingCycle = await getBillingCycleRange(c, orgId)
  const planId = currentPlan?.id

  const metrics: Array<{ key: CreditMetric, usage: number, limit: number | null | undefined }> = [
    { key: 'mau', usage: Number(totalStats.mau ?? 0), limit: creditOnlyMode ? 0 : currentPlan?.mau },
    { key: 'storage', usage: Number(totalStats.storage ?? 0), limit: creditOnlyMode ? 0 : currentPlan?.storage },
    { key: 'bandwidth', usage: Number(totalStats.bandwidth ?? 0), limit: creditOnlyMode ? 0 : currentPlan?.bandwidth },
    { key: 'build_time', usage: Number(totalStats.build_time_unit ?? 0), limit: creditOnlyMode ? 0 : currentPlan?.build_time_unit },
  ]

  const creditResults: Record<CreditMetric, CreditApplicationResult | null> = {
    mau: null,
    storage: null,
    bandwidth: null,
    build_time: null,
  }

  let hasUnpaidOverage = false
  const exceededFlags = createEmptyExceededFlags()

  for (const metric of metrics) {
    const planLimit = Number(metric.limit ?? 0)
    const overage = metric.usage - planLimit
    if (overage > 0) {
      if (!billingCycle) {
        // Skip this run instead of applying overage under a guessed cycle key
        // (a different key re-debits credits). Nothing was applied yet: every
        // metric needs the cycle. Throwing leaves stripe_info untouched and
        // lets the queue retry.
        cloudlogErr({ requestId: c.get('requestId'), message: 'userAbovePlan skipped overage: billing cycle unavailable', orgId, metric: metric.key, overage })
        throw new Error(`billing_cycle_unavailable for org ${orgId}`)
      }
      const creditResult = await applyCreditsForMetric(c, orgId, metric.key, overage, planId, metric.usage, metric.limit, billingCycle)
      creditResults[metric.key] = creditResult
      const unpaid = creditResult?.overage_unpaid ?? overage
      exceededFlags[EXCEEDED_FLAG_BY_METRIC[metric.key]] = unpaid > 0
      if (unpaid > 0)
        hasUnpaidOverage = true
    }
  }

  if (!hasUnpaidOverage) {
    cloudlog({ requestId: c.get('requestId'), message: 'Overage fully covered by credits', orgId, creditResults })
    return { exceededFlags, needsUpgrade: false }
  }

  if (!hasActivePlan) {
    cloudlog({ requestId: c.get('requestId'), message: 'Credits-only org overage check completed', orgId, creditResults })
    return { exceededFlags, needsUpgrade: true }
  }

  const bestPlan = await findBestPlan(c, {
    mau: totalStats.mau,
    storage: totalStats.storage,
    bandwidth: totalStats.bandwidth,
    build_time_unit: totalStats.build_time_unit,
  })

  // If the calculated best plan ranks lower than the current one, the org is over-provisioned, so skip upgrade nudges.
  if (currentPlanName && planToInt(bestPlan) < planToInt(currentPlanName)) {
    return { exceededFlags, needsUpgrade: true }
  }

  const bestPlanKey = bestPlan.toLowerCase().replace(' ', '_')
  const sent = await sendNotifToOrgMembers(
    c,
    `user:upgrade_to_${bestPlanKey}`,
    'usage_limit',
    { best_plan: bestPlanKey, plan_name: currentPlanName },
    orgId,
    orgId,
    '0 0 * * 1',
    drizzleClient,
  )
  if (sent) {
    cloudlog({ requestId: c.get('requestId'), message: `user:upgrade_to_${bestPlanKey}`, orgId })
    await sendEventToTracking(c, {
      channel: 'usage',
      event: `User need upgrade to ${bestPlanKey}`,
      user_id: orgId,
      groups: { organization: orgId },
    }).catch()
  }

  return { exceededFlags, needsUpgrade: true }
}

async function userIsAtPlanUsage(c: Context, orgId: string, percentUsage: PlanUsage, drizzleClient: ReturnType<typeof getDrizzleClient>) {
  const alert = getPlanUsageAlert(percentUsage)
  if (!alert)
    return

  const sent = await sendNotifToOrgMembers(c, alert.eventName, 'usage_limit', {
    metric: alert.metric,
    metric_percent: alert.metricPercent,
    percent: alert.percentUsage,
    threshold: alert.threshold,
  }, orgId, orgId, '0 0 1 * *', drizzleClient)
  if (sent) {
    await sendEventToTracking(c, {
      channel: 'usage',
      event: `User is at ${alert.threshold}% of plan usage`,
      user_id: orgId,
      groups: { organization: orgId },
      tags: {
        metric: alert.metric,
        metric_percent: alert.metricPercent.toString(),
        threshold: alert.threshold.toString(),
      },
    }).catch()
  }
}

// Get org data with customer info
export async function getOrgWithCustomerInfo(c: Context, orgId: string) {
  const { data: org, error: userError } = await supabaseAdmin(c)
    .from('orgs')
    .select('customer_id, has_usage_credits, name, website, onboarding, stripe_info(status, subscription_id, subscription_anchor_start, subscription_anchor_end, trial_at)')
    .eq('id', orgId)
    .maybeSingle()
  if (userError)
    return quickError(500, 'cannot_get_org', 'Cannot get org', { orgId, userError })
  if (!org)
    return quickError(404, 'org_not_found', 'Org not found', { orgId })
  return org
}

// Sync subscription data with Stripe
export async function syncOrgSubscriptionData(c: Context, org: any): Promise<void> {
  if (org.customer_id) {
    await syncSubscriptionData(c, org.customer_id, org?.stripe_info?.subscription_id ?? null)
  }
}

// Handle trial organization logic
export async function handleTrialOrg(c: Context, orgId: string, org: any, drizzleClient: ReturnType<typeof getDrizzleClient>): Promise<boolean> {
  if (await isTrialOrg(c, orgId)) {
    if (org.customer_id) {
      await drizzleClient.execute(sql`
        UPDATE public.stripe_info
        SET is_good_plan = true
        WHERE customer_id = ${org.customer_id}
          AND is_good_plan IS DISTINCT FROM true
      `)
    }
    return true // Trial handled
  }
  return false // Not a trial
}

// Calculate plan status and usage
export async function calculatePlanStatus(c: Context, orgId: string) {
  const planUsage = await getPlanUsageAndFit(c, orgId)
  const { is_good_plan, total_percent, mau_percent, bandwidth_percent, storage_percent, build_time_percent } = planUsage
  const percentUsage = normalizePlanUsage({ total_percent, mau_percent, bandwidth_percent, storage_percent, build_time_percent })
  return { is_good_plan, percentUsage }
}

export async function calculatePlanStatusFresh(c: Context, orgId: string) {
  try {
    const planUsage = await getPlanUsageAndFitUncached(c, orgId)
    const { is_good_plan, total_percent, mau_percent, bandwidth_percent, storage_percent, build_time_percent } = planUsage
    const percentUsage = normalizePlanUsage({ total_percent, mau_percent, bandwidth_percent, storage_percent, build_time_percent })
    return { is_good_plan, percentUsage }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'calculatePlanStatusFresh fallback', orgId, error })
    const percentUsage = normalizePlanUsage(await getPlanUsagePercent(c, orgId))
    const is_good_plan = await isGoodPlanOrg(c, orgId)
    return { is_good_plan, percentUsage }
  }
}

// Handle notifications and events based on org status
export async function handleOrgNotificationsAndEvents(c: Context, org: any, orgId: string, is_good_plan: boolean, percentUsage: PlanUsage, drizzleClient: ReturnType<typeof getDrizzleClient>): Promise<PlanNotificationResult> {
  const is_onboarded = await isOnboardedOrg(c, orgId)
  const is_onboarding_needed = await isOnboardingNeeded(c, orgId)

  let finalIsGoodPlan = is_good_plan
  let exceededFlags: PlanExceededFlags | null = null

  if (is_onboarded && isCreditOnlyBillingOrg(org)) {
    const result = await userAbovePlan(c, org, orgId, is_good_plan, drizzleClient, true)
    finalIsGoodPlan = !result.needsUpgrade
    exceededFlags = result.exceededFlags
  }
  else if (!is_good_plan && is_onboarded) {
    const result = await userAbovePlan(c, org, orgId, is_good_plan, drizzleClient)
    finalIsGoodPlan = !result.needsUpgrade
    exceededFlags = result.exceededFlags
  }
  else if (!is_onboarded && is_onboarding_needed) {
    const onboardingIntent = parseOrgOnboardingIntent(org.onboarding)
    // Once returns true only on the first org claim (not on later cron passes).
    const sent = await sendNotifToOrgMembersOnce(c, 'user:need_onboarding', 'onboarding', buildOnboardingIntentBentoEventData(c, onboardingIntent, {
      id: orgId,
      name: org.name ?? '',
      website: org.website ?? null,
    }), orgId, orgId, drizzleClient)
    if (sent) {
      await sendEventToTracking(c, {
        channel: 'usage',
        event: 'User need onboarding',
        user_id: orgId,
        groups: { organization: orgId },
      }).catch()
    }
  }
  else if (is_good_plan && is_onboarded) {
    await userIsAtPlanUsage(c, orgId, percentUsage, drizzleClient)
    finalIsGoodPlan = true
    exceededFlags = createEmptyExceededFlags()
  }

  return { exceededFlags, finalIsGoodPlan }
}

async function updateExceededFlags(customerId: string | null, flags: PlanExceededFlags, drizzleClient: ReturnType<typeof getDrizzleClient>): Promise<void> {
  if (!customerId)
    return

  await drizzleClient.execute(sql`
    UPDATE public.stripe_info
    SET mau_exceeded = ${flags.mau_exceeded},
        storage_exceeded = ${flags.storage_exceeded},
        bandwidth_exceeded = ${flags.bandwidth_exceeded},
        build_time_exceeded = ${flags.build_time_exceeded}
    WHERE customer_id = ${customerId}
      AND ROW(mau_exceeded, storage_exceeded, bandwidth_exceeded, build_time_exceeded)
        IS DISTINCT FROM ROW(${flags.mau_exceeded}, ${flags.storage_exceeded}, ${flags.bandwidth_exceeded}, ${flags.build_time_exceeded})
  `)
}

// Update stripe_info once, and only when the calculated plan state changed.
export async function updatePlanStatus(org: any, result: PlanNotificationResult, isAbovePlan: boolean, percentUsage: PlanUsage, drizzleClient: ReturnType<typeof getDrizzleClient>): Promise<void> {
  if (!org.customer_id)
    return

  const normalizedUsage = normalizePlanUsage(percentUsage)
  const planUsage = Math.round(normalizedUsage.total_percent)
  if (!result.exceededFlags) {
    await drizzleClient.execute(sql`
      UPDATE public.stripe_info
      SET is_above_plan = ${isAbovePlan},
          is_good_plan = ${result.finalIsGoodPlan},
          plan_usage = ${planUsage}
      WHERE customer_id = ${org.customer_id}
        AND ROW(is_above_plan, is_good_plan, plan_usage)
          IS DISTINCT FROM ROW(${isAbovePlan}, ${result.finalIsGoodPlan}, ${planUsage})
    `)
    return
  }

  const flags = result.exceededFlags
  await drizzleClient.execute(sql`
    UPDATE public.stripe_info
    SET is_above_plan = ${isAbovePlan},
        is_good_plan = ${result.finalIsGoodPlan},
        plan_usage = ${planUsage},
        mau_exceeded = ${flags.mau_exceeded},
        storage_exceeded = ${flags.storage_exceeded},
        bandwidth_exceeded = ${flags.bandwidth_exceeded},
        build_time_exceeded = ${flags.build_time_exceeded}
    WHERE customer_id = ${org.customer_id}
      AND ROW(is_above_plan, is_good_plan, plan_usage, mau_exceeded, storage_exceeded, bandwidth_exceeded, build_time_exceeded)
        IS DISTINCT FROM ROW(${isAbovePlan}, ${result.finalIsGoodPlan}, ${planUsage}, ${flags.mau_exceeded}, ${flags.storage_exceeded}, ${flags.bandwidth_exceeded}, ${flags.build_time_exceeded})
  `)
}

// New function for cron_stat_org - handles is_good_plan + plan % + exceeded flags
export async function checkPlanStatusOnly(c: Context, orgId: string, drizzleClient: ReturnType<typeof getDrizzleClient>): Promise<void> {
  // This cron task updates plan usage + exceeded flags based on DB state.
  // It must run even when Stripe is not configured (e.g. local tests / on-prem),
  // as it does not require Stripe API calls.
  const org = await getOrgWithCustomerInfo(c, orgId)

  // Handle trial organizations
  const trialHandled = await handleTrialOrg(c, orgId, org, drizzleClient)
  let planStatusWriteError: unknown
  if (!trialHandled) {
    // Calculate plan status and usage
    let planStatus: { is_good_plan: boolean, percentUsage: PlanUsage } | undefined
    try {
      planStatus = await calculatePlanStatusFresh(c, orgId)
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'calculatePlanStatus failed', orgId, error })
      throw error
    }
    if (planStatus) {
      const { is_good_plan, percentUsage } = planStatus
      // Credits can restore final plan eligibility, so retain the raw usage threshold separately.
      const isAbovePlan = percentUsage.total_percent > 100
      try {
        const result = await handleOrgNotificationsAndEvents(c, org, orgId, is_good_plan, percentUsage, drizzleClient)
        await updatePlanStatus(org, result, isAbovePlan, percentUsage, drizzleClient)
      }
      catch (error) {
        planStatusWriteError = error
        cloudlogErr({ requestId: c.get('requestId'), message: 'plan status write failed', orgId, error })
      }
    }
  }

  try {
    await maybeAutoTopUpCredits(c, orgId)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'credit auto top-up failed', orgId, error })
  }
  if (planStatusWriteError)
    throw planStatusWriteError
}

// New function for cron_sync_sub - handles subscription sync + events
export async function syncSubscriptionAndEvents(c: Context, orgId: string, drizzleClient: ReturnType<typeof getDrizzleClient>): Promise<void> {
  if (!isStripeConfigured(c))
    return
  const org = await getOrgWithCustomerInfo(c, orgId)

  // Sync subscription data with Stripe
  await syncOrgSubscriptionData(c, org)

  // Handle trial organizations
  if (await handleTrialOrg(c, orgId, org, drizzleClient)) {
    return // Trial handled, exit early
  }

  // Calculate plan status and usage for notifications
  const { is_good_plan, percentUsage } = await calculatePlanStatus(c, orgId)

  // Handle notifications and events
  const result = await handleOrgNotificationsAndEvents(c, org, orgId, is_good_plan, percentUsage, drizzleClient)
  if (result.exceededFlags)
    await updateExceededFlags(org.customer_id, result.exceededFlags, drizzleClient)
}
