import type { Context } from 'hono'
import type { getDrizzleClient } from './pg.ts'
import type { PlanUsage } from './supabase.ts'
import type { Database } from './supabase.types.ts'
import { quickError } from './hono.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { sendNotifToOrgMembers, sendNotifToOrgMembersOnce } from './org_email_notifications.ts'
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
  set_bandwidth_exceeded,
  set_build_time_exceeded,
  set_mau_exceeded,
  set_storage_exceeded,
  supabaseAdmin,
} from './supabase.ts'
import { buildOnboardingIntentBentoEventData, parseOrgOnboardingIntent } from './org_onboarding_intent.ts'
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

interface BillingCycleInfo {
  subscription_anchor_start: string | null
  subscription_anchor_end: string | null
}

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

function getDefaultBillingCycleRange(referenceDate = new Date()): BillingCycleRange {
  const start = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), 1, 0, 0, 0, 0))
  const end = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + 1, 1, 0, 0, 0, 0))
  return {
    subscription_anchor_start: start.toISOString(),
    subscription_anchor_end: end.toISOString(),
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

async function getBillingCycleRange(c: Context, orgId: string): Promise<BillingCycleRange> {
  try {
    const { data, error } = await supabaseAdmin(c)
      .rpc('get_cycle_info_org', { orgid: orgId })
      .single()
    if (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'getBillingCycleRange error', orgId, error })
      return getDefaultBillingCycleRange()
    }
    if (!data?.subscription_anchor_start || !data?.subscription_anchor_end) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'getBillingCycleRange fallback to default',
        orgId,
        billingCycle: data,
      })
      return getDefaultBillingCycleRange()
    }
    return data as BillingCycleRange
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getBillingCycleRange error', orgId, error })
    return getDefaultBillingCycleRange()
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
  billingCycle: BillingCycleInfo | null,
): Promise<CreditApplicationResult | null> {
  if (overageAmount <= 0)
    return null

  const resolvedBillingCycle: BillingCycleRange = billingCycle?.subscription_anchor_start && billingCycle?.subscription_anchor_end
    ? (billingCycle as BillingCycleRange)
    : getDefaultBillingCycleRange()

  if (!planId) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'applyCreditsForMetric missing plan context, continuing',
      orgId,
      metric,
      billingCycle: resolvedBillingCycle,
    })
  }
  try {
    const { data, error } = await supabaseAdmin(c)
      .rpc('apply_usage_overage', {
        p_org_id: orgId,
        p_metric: metric,
        p_overage_amount: overageAmount,
        p_billing_cycle_start: resolvedBillingCycle.subscription_anchor_start!,
        p_billing_cycle_end: resolvedBillingCycle.subscription_anchor_end!,
        p_details: {
          usage,
          limit: limit ?? 0,
        },
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
}, orgId: string, is_good_plan: boolean, drizzleClient: ReturnType<typeof getDrizzleClient>, forceCreditMode = false): Promise<boolean> {
  const creditOnlyMode = forceCreditMode || isCreditOnlyBillingOrg(org)
  cloudlog({ requestId: c.get('requestId'), message: 'userAbovePlan', orgId, is_good_plan, creditOnlyMode })
  const hasActivePlan = hasActivePlanEntitlement(org)
  const totalStats = await getTotalStats(c, orgId)
  if (!totalStats) {
    return false
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

  for (const metric of metrics) {
    const planLimit = Number(metric.limit ?? 0)
    const overage = metric.usage - planLimit
    if (overage > 0) {
      const creditResult = await applyCreditsForMetric(c, orgId, metric.key, overage, planId, metric.usage, metric.limit, billingCycle)
      creditResults[metric.key] = creditResult
      const unpaid = creditResult?.overage_unpaid ?? overage
      if (metric.key === 'mau') {
        await set_mau_exceeded(c, org.customer_id, unpaid > 0, orgId)
      }
      else if (metric.key === 'storage') {
        await set_storage_exceeded(c, org.customer_id, unpaid > 0, orgId)
      }
      else if (metric.key === 'bandwidth') {
        await set_bandwidth_exceeded(c, org.customer_id, unpaid > 0, orgId)
      }
      else if (metric.key === 'build_time') {
        await set_build_time_exceeded(c, orgId, unpaid > 0)
      }
      if (unpaid > 0)
        hasUnpaidOverage = true
    }
    else {
      if (metric.key === 'mau')
        await set_mau_exceeded(c, org.customer_id, false, orgId)
      else if (metric.key === 'storage')
        await set_storage_exceeded(c, org.customer_id, false, orgId)
      else if (metric.key === 'bandwidth')
        await set_bandwidth_exceeded(c, org.customer_id, false, orgId)
      else if (metric.key === 'build_time')
        await set_build_time_exceeded(c, orgId, false)
    }
  }

  if (!hasUnpaidOverage) {
    cloudlog({ requestId: c.get('requestId'), message: 'Overage fully covered by credits', orgId, creditResults })
    return false
  }

  if (!hasActivePlan) {
    cloudlog({ requestId: c.get('requestId'), message: 'Credits-only org overage check completed', orgId, creditResults })
    return true
  }

  const bestPlan = await findBestPlan(c, {
    mau: totalStats.mau,
    storage: totalStats.storage,
    bandwidth: totalStats.bandwidth,
    build_time_unit: totalStats.build_time_unit,
  })

  // If the calculated best plan ranks lower than the current one, the org is over-provisioned, so skip upgrade nudges.
  if (currentPlanName && planToInt(bestPlan) < planToInt(currentPlanName)) {
    return true
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
      icon: '⚠️',
      user_id: orgId,
      groups: { organization: orgId },
      notify: false,
    }).catch()
  }

  return true
}

async function userIsAtPlanUsage(c: Context, orgId: string, customerId: string | null, percentUsage: PlanUsage, drizzleClient: ReturnType<typeof getDrizzleClient>) {
  // Reset exceeded flags if plan is good
  await set_mau_exceeded(c, customerId, false, orgId)
  await set_storage_exceeded(c, customerId, false, orgId)
  await set_bandwidth_exceeded(c, customerId, false, orgId)
  await set_build_time_exceeded(c, orgId, false)

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
      icon: '⚠️',
      user_id: orgId,
      groups: { organization: orgId },
      notify: false,
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
export async function handleTrialOrg(c: Context, orgId: string, org: any): Promise<boolean> {
  if (await isTrialOrg(c, orgId)) {
    const { error } = await supabaseAdmin(c)
      .from('stripe_info')
      .update({ is_good_plan: true })
      .eq('customer_id', org.customer_id!)
      .then()
    if (error)
      cloudlogErr({ requestId: c.get('requestId'), message: 'update stripe info', error })
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
export async function handleOrgNotificationsAndEvents(c: Context, org: any, orgId: string, is_good_plan: boolean, percentUsage: PlanUsage, drizzleClient: ReturnType<typeof getDrizzleClient>): Promise<boolean> {
  const is_onboarded = await isOnboardedOrg(c, orgId)
  const is_onboarding_needed = await isOnboardingNeeded(c, orgId)

  let finalIsGoodPlan = is_good_plan

  if (is_onboarded && isCreditOnlyBillingOrg(org)) {
    const needsUpgrade = await userAbovePlan(c, org, orgId, is_good_plan, drizzleClient, true)
    finalIsGoodPlan = !needsUpgrade
  }
  else if (!is_good_plan && is_onboarded) {
    const needsUpgrade = await userAbovePlan(c, org, orgId, is_good_plan, drizzleClient)
    finalIsGoodPlan = !needsUpgrade
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
        icon: '🥲',
        user_id: orgId,
        groups: { organization: orgId },
        notify: false,
      }).catch()
    }
  }
  else if (is_good_plan && is_onboarded) {
    await userIsAtPlanUsage(c, orgId, org.customer_id, percentUsage, drizzleClient)
    finalIsGoodPlan = true
  }

  return finalIsGoodPlan
}

// Update stripe_info with plan status
export async function updatePlanStatus(c: Context, org: any, finalIsGoodPlan: boolean, isAbovePlan: boolean, percentUsage: PlanUsage): Promise<void> {
  const normalizedUsage = normalizePlanUsage(percentUsage)
  await supabaseAdmin(c)
    .from('stripe_info')
    .update({
      is_above_plan: isAbovePlan,
      is_good_plan: finalIsGoodPlan,
      plan_usage: Math.round(normalizedUsage.total_percent),
    })
    .eq('customer_id', org.customer_id!)
    .then()
}

// New function for cron_stat_org - handles is_good_plan + plan % + exceeded flags
export async function checkPlanStatusOnly(c: Context, orgId: string, drizzleClient: ReturnType<typeof getDrizzleClient>): Promise<void> {
  // This cron task updates plan usage + exceeded flags based on DB state.
  // It must run even when Stripe is not configured (e.g. local tests / on-prem),
  // as it does not require Stripe API calls.
  const org = await getOrgWithCustomerInfo(c, orgId)

  // Handle trial organizations
  if (await handleTrialOrg(c, orgId, org)) {
    return // Trial handled, exit early
  }

  // Calculate plan status and usage
  let planStatus: { is_good_plan: boolean, percentUsage: PlanUsage }
  try {
    planStatus = await calculatePlanStatusFresh(c, orgId)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'calculatePlanStatus failed', orgId, error })
    return
  }
  const { is_good_plan, percentUsage } = planStatus
  // Credits can restore final plan eligibility, so retain the raw usage threshold separately.
  const isAbovePlan = percentUsage.total_percent > 100

  // Update plan status in database
  const finalIsGoodPlan = await handleOrgNotificationsAndEvents(c, org, orgId, is_good_plan, percentUsage, drizzleClient)
  await updatePlanStatus(c, org, finalIsGoodPlan, isAbovePlan, percentUsage)
}

// New function for cron_sync_sub - handles subscription sync + events
export async function syncSubscriptionAndEvents(c: Context, orgId: string, drizzleClient: ReturnType<typeof getDrizzleClient>): Promise<void> {
  if (!isStripeConfigured(c))
    return
  const org = await getOrgWithCustomerInfo(c, orgId)

  // Sync subscription data with Stripe
  await syncOrgSubscriptionData(c, org)

  // Handle trial organizations
  if (await handleTrialOrg(c, orgId, org)) {
    return // Trial handled, exit early
  }

  // Calculate plan status and usage for notifications
  const { is_good_plan, percentUsage } = await calculatePlanStatus(c, orgId)

  // Handle notifications and events
  await handleOrgNotificationsAndEvents(c, org, orgId, is_good_plan, percentUsage, drizzleClient)
}
