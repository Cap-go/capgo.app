import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, parseBody, simpleError } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { sendEmailToOrgMembers } from '../utils/org_email_notifications.ts'
import { findBestPlan } from '../utils/plans.ts'
import { readStatsVersion } from '../utils/stats.ts'
import { getCurrentPlanNameOrg, supabaseAdmin } from '../utils/supabase.ts'

const thresholds = {
  // Number of updates in plain number
  updates: [
    100,
    1000,
    10000,
  ],
  // Percentage in decimal form (0.9 ==== 90%)
  failRate: [
    // Failure rate bands (0 = 0% failures, 0.3 = 30% failures)
    0,
    0.10,
    0.20,
    0.30,
  ],
  // Number of app opens in plain number
  appOpen: [
    500,
    1500,
    5000,
  ],
}

const funComparisons = {
  updates: [
    'a cupcake to every student in a small school!',
    'a pizza to every resident of a small town!',
    'a burger to everyone in a big city!',
  ],
  failRate: [
    'Flawless streak—no failed updates this week! 🏅',
    'Roughly one in ten updates failed; a quick health check could help.',
    'About one in five updates failed; let\'s squash those errors.',
    'Heads up: nearly a third of updates are failing—worth a closer look.',
  ],
  appOpen: [
    'Your app was opened more times than a popular local bakery\'s door!',
    'Your app was more popular than the latest episode of a hit TV show!',
    'Your app was opened more times than a blockbuster movie on its opening weekend!',
  ],
}

// Check what threshold does the stat qualify for and return the fun comparison
function getFunComparison(comparison: keyof typeof funComparisons, stat: number): string {
  const thresholdsForComparisons = thresholds[comparison]
  // Choose the highest threshold that is <= stat so that bigger stats map to
  // the more impressive comparison string (including 100% success rate).
  let chosenIndex = 0
  for (let i = thresholdsForComparisons.length - 1; i >= 0; i -= 1) {
    if (stat >= thresholdsForComparisons[i]) {
      chosenIndex = i
      break
    }
  }

  const comparisonStrings = funComparisons[comparison]
  if (!comparisonStrings[chosenIndex])
    throw new Error(`Cannot find index for fun comparison, ${chosenIndex}`)

  return comparisonStrings[chosenIndex]
}

export const app = new Hono<MiddlewareKeyVariables>()

async function getOrgIdForApp(c: Context, appId: string): Promise<string> {
  const { data: appData, error: appError } = await supabaseAdmin(c)
    .from('apps')
    .select('owner_org')
    .eq('app_id', appId)
    .single()

  if (appError || !appData?.owner_org)
    throw simpleError('org_not_found', 'Organization not found for app', { appError, appId })

  return appData.owner_org
}

app.post('/', middlewareAPISecret, async (c) => {
  const {
    email,
    appId,
    orgId,
    type,
    deployId,
    versionId,
    versionName,
    channelId,
    channelName,
    platform,
    appName,
    deployedAt,
    cycleStart,
    cycleEnd,
    totalInstalls,
    totalFails,
    failPercentage,
    reportDate,
  } = await parseBody<{
    email: string
    appId?: string
    orgId?: string
    type: string
    deployId?: number
    versionId?: number
    versionName?: string
    channelId?: number
    channelName?: string
    platform?: string
    appName?: string
    deployedAt?: string
    cycleStart?: string
    cycleEnd?: string
    totalInstalls?: number
    totalFails?: number
    failPercentage?: number
    reportDate?: string
  }>(c)

  if (!email || !type) {
    throw simpleError('missing_email_type', 'Missing email or type', { email, type })
  }

  // billing_period_stats uses orgId instead of appId
  if (type === 'billing_period_stats') {
    if (!orgId) {
      throw simpleError('missing_orgId', 'Missing orgId for billing_period_stats', { email, type })
    }
    return await handleBillingPeriodStats(c, email, orgId, cycleStart, cycleEnd)
  }

  if (type === 'daily_fail_ratio') {
    if (!appId) {
      throw simpleError('missing_appId', 'Missing appId for daily_fail_ratio', { email, type })
    }
    return await handleDailyFailRatio(c, {
      appId,
      orgId,
      appName,
      totalInstalls,
      totalFails,
      failPercentage,
      reportDate,
    })
  }

  // All other types require appId
  if (!appId) {
    throw simpleError('missing_appId', 'Missing appId', { email, type })
  }

  if (type === 'weekly_install_stats') {
    return await handleWeeklyInstallStats(c, appId)
  }
  else if (type === 'monthly_create_stats') {
    return await handleMonthlyCreateStats(c, appId)
  }
  else if (type === 'deploy_install_stats') {
    return await handleDeployInstallStats(c, {
      appId,
      orgId,
      deployId,
      versionId,
      versionName,
      channelId,
      channelName,
      platform,
      appName,
      deployedAt,
    })
  }
  else {
    throw simpleError('invalid_stats_type', 'Invalid stats type', { email, appId, type })
  }
})

async function handleWeeklyInstallStats(c: Context, appId: string) {
  const supabase = await supabaseAdmin(c)

  const { data: weeklyStats, error: generateStatsError } = await supabase.rpc('get_weekly_stats', {
    app_id: appId,
  }).single()

  if (!weeklyStats || generateStatsError) {
    throw simpleError('cannot_generate_stats', 'Cannot generate stats', { error: generateStatsError })
  }

  if (weeklyStats.all_updates === 0) {
    return c.json({ status: 'No updates this week' }, 200)
  }

  const successUpdates = weeklyStats.all_updates - weeklyStats.failed_updates
  if (successUpdates < 0) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Cannot send email for app, successUpdates < 0', error: weeklyStats, metadata: { app_id: appId } })
    cloudlogErr({ requestId: c.get('requestId'), message: 'Invalid stats detected', error: weeklyStats, metadata: { app_id: appId } })
    return c.json({ status: 'No valid stats available' }, 200)
  }

  const successPercentage = Math.round((successUpdates / weeklyStats.all_updates) * 10_000) / 10_000
  const failureRate = Math.round((weeklyStats.failed_updates / weeklyStats.all_updates) * 10_000) / 10_000

  // Calculate week number and month name for the reported period
  const now = new Date()
  const monthName = now.toLocaleString('en-US', { month: 'long' })
  // Calculate ISO week number
  const startOfYear = new Date(now.getFullYear(), 0, 1)
  const days = Math.floor((now.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000))
  const weekNumber = Math.ceil((days + startOfYear.getDay() + 1) / 7)

  const metadata = {
    app_id: appId,
    month_name: monthName,
    week_number: weekNumber.toString(),
    weekly_updates: (weeklyStats.all_updates).toString(),
    fun_comparison: getFunComparison('updates', weeklyStats.all_updates),
    weekly_install: successUpdates.toString(),
    weekly_install_success: (successPercentage * 100).toString(),
    fun_comparison_2: getFunComparison('failRate', failureRate),
    weekly_fail: (weeklyStats.failed_updates).toString(),
    weekly_open: (weeklyStats.open_app).toString(),
    fun_comparison_3: getFunComparison('appOpen', weeklyStats.open_app),
  }

  await sendEmailToOrgMembers(c, 'user:weekly_stats', 'weekly_stats', metadata, await getOrgIdForApp(c, appId))

  return c.json(BRES)
}

async function handleMonthlyCreateStats(c: Context, appId: string) {
  const supabase = await supabaseAdmin(c)

  // Calculate the previous month's date range
  const now = new Date()
  const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0) // Last day of previous month

  // Get full month name for the reported period
  const monthName = previousMonth.toLocaleString('en-US', { month: 'long' })

  // Fetch stats for bundle creation and publishing
  const { data: appVersions, error: _appVersionsError } = await supabase
    .from('app_versions')
    .select('id, created_at')
    .eq('app_id', appId)
    .gte('created_at', previousMonth.toISOString())
    .lte('created_at', previousMonthEnd.toISOString())

  const { data: deployHistory, error: _deployHistoryError } = await supabase
    .from('deploy_history')
    .select('id, deployed_at')
    .eq('app_id', appId)
    .gte('deployed_at', previousMonth.toISOString())
    .lte('deployed_at', previousMonthEnd.toISOString())

  const bundleCount = appVersions?.length ?? 0
  const publishCount = deployHistory?.length ?? 0

  const metadata = {
    app_id: appId,
    month_name: monthName,
    monthly_bundles_created: bundleCount.toString(),
    monthly_publishes: publishCount.toString(),
  }

  if (bundleCount > 0 || publishCount > 0) {
    await sendEmailToOrgMembers(c, 'org:monthly_create_stats', 'monthly_stats', metadata, await getOrgIdForApp(c, appId))
  }

  return c.json(BRES)
}

async function handleDeployInstallStats(
  c: Context,
  payload: {
    appId: string
    orgId?: string
    deployId?: number
    versionId?: number
    versionName?: string
    channelId?: number
    channelName?: string
    platform?: string
    appName?: string
    deployedAt?: string
  },
) {
  const {
    appId,
    orgId,
    deployId,
    versionId,
    versionName,
    channelId,
    channelName,
    platform,
    appName,
    deployedAt,
  } = payload

  if (!versionId) {
    throw simpleError('missing_version_id', 'Missing versionId', { appId, deployId })
  }

  let deployTime = deployedAt ? new Date(deployedAt) : null
  if (!deployTime || Number.isNaN(deployTime.getTime())) {
    if (deployId) {
      const { data: deploy, error: deployError } = await supabaseAdmin(c)
        .from('deploy_history')
        .select('deployed_at')
        .eq('id', deployId)
        .single()
      if (deployError || !deploy?.deployed_at) {
        throw simpleError('missing_deployed_at', 'Missing deployedAt', { appId, deployId, deployError })
      }
      deployTime = new Date(deploy.deployed_at)
    }
    else {
      throw simpleError('missing_deployed_at', 'Missing deployedAt', { appId, deployId, versionId })
    }
  }

  const windowStart = deployTime.toISOString()
  const windowEnd = new Date(deployTime.getTime() + 24 * 60 * 60 * 1000).toISOString()
  const versionStats = await readStatsVersion(c, appId, windowStart, windowEnd)
  // Filter by version_name (new format) OR version_id as string (old Cloudflare format)
  // This handles backwards compatibility during the transition period
  const versionIdStr = versionId ? String(versionId) : null
  const installs = versionStats
    .filter(row => row.version_name === versionName || (versionIdStr && row.version_name === versionIdStr))
    .reduce((sum, row) => sum + (row.install ?? 0), 0)

  const metadata = {
    app_id: appId,
    app_name: appName ?? '',
    deploy_id: deployId?.toString(),
    version_id: versionId?.toString(),
    version_name: versionName ?? '',
    channel_id: channelId?.toString(),
    channel_name: channelName ?? '',
    platform: platform ?? '',
    deployed_at: windowStart,
    install_count_24h: installs.toString(),
    window_hours: '24',
  }

  if (installs > 1) {
    await sendEmailToOrgMembers(c, 'bundle:install_stats_24h', 'deploy_stats_24h', metadata, orgId ?? await getOrgIdForApp(c, appId))
  }

  return c.json(BRES)
}

/**
 * Format bytes to human readable format (e.g., 1.5 GB, 250 MB)
 */
function formatBytes(bytes: number): string {
  if (bytes === 0)
    return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`
}

/**
 * Format large numbers with commas (e.g., 1,234,567)
 */
function formatNumber(num: number): string {
  return num.toLocaleString('en-US')
}

/** Calendar date (YYYY-MM-DD) from a timestamptz/ISO string without TZ day-shift. */
function toDateOnlyUtc(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value)
  if (match)
    return match[1]
  return new Date(value).toISOString().slice(0, 10)
}

/** Shift a YYYY-MM-DD date by N days in UTC. */
function addDaysToDateOnly(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * Billing cycles are half-open [start, end).
 * get_total_metrics uses inclusive BETWEEN, so the metrics end date is end - 1 day.
 */
function billingPeriodMetricsRange(cycleStart: string, cycleEnd: string): {
  periodStart: string
  periodEndExclusive: string
  metricsEndInclusive: string
} {
  const periodStart = toDateOnlyUtc(cycleStart)
  const periodEndExclusive = toDateOnlyUtc(cycleEnd)
  const metricsEndInclusive = addDaysToDateOnly(periodEndExclusive, -1)
  return { periodStart, periodEndExclusive, metricsEndInclusive }
}

export const billingPeriodStatsTestUtils = {
  toDateOnlyUtc,
  addDaysToDateOnly,
  billingPeriodMetricsRange,
}

async function handleBillingPeriodStats(c: Context, _email: string, orgId: string, cycleStart?: string, cycleEnd?: string) {
  const supabase = await supabaseAdmin(c)

  // Get organization info
  const { data: org, error: orgError } = await supabase
    .from('orgs')
    .select('id, name')
    .eq('id', orgId)
    .single()

  if (orgError || !org) {
    throw simpleError('org_not_found', 'Organization not found', { orgId, orgError })
  }

  // Use cycle dates passed from the SQL function if available,
  // otherwise fall back to get_cycle_info_org (for backwards compatibility)
  let periodStart: string
  let periodEndExclusive: string
  let metricsEndInclusive: string

  if (cycleStart && cycleEnd) {
    // Completed billing period from SQL: [cycleStart, cycleEnd)
    ;({ periodStart, periodEndExclusive, metricsEndInclusive } = billingPeriodMetricsRange(cycleStart, cycleEnd))
  }
  else {
    // Fallback: get cycle info from RPC (current cycle, same half-open bounds)
    const { data: cycleInfo, error: cycleError } = await supabase
      .rpc('get_cycle_info_org', { orgid: orgId })
      .single()

    if (cycleError || !cycleInfo) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Cannot get cycle info', error: cycleError, metadata: { orgId } })
      throw simpleError('cannot_get_cycle_info', 'Cannot get cycle info', { error: cycleError })
    }

    ;({ periodStart, periodEndExclusive, metricsEndInclusive } = billingPeriodMetricsRange(
      cycleInfo.subscription_anchor_start,
      cycleInfo.subscription_anchor_end,
    ))
  }

  // Guard against inverted/empty ranges (e.g. bad payloads)
  if (metricsEndInclusive < periodStart) {
    throw simpleError('invalid_billing_period', 'Invalid billing period dates', {
      periodStart,
      periodEndExclusive,
      metricsEndInclusive,
    })
  }

  // Get total metrics for the completed billing period days
  const { data: metrics, error: metricsError } = await supabase
    .rpc('get_total_metrics', {
      org_id: orgId,
      start_date: periodStart,
      end_date: metricsEndInclusive,
    })
    .single()

  if (metricsError) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Cannot get total metrics', error: metricsError, metadata: { orgId } })
    throw simpleError('cannot_get_metrics', 'Cannot get metrics', { error: metricsError })
  }

  // Sum credits in [periodStart, periodEndExclusive) without PostgREST row limits
  const { data: creditsSum, error: creditsError } = await supabase.rpc(
    'get_org_credits_used_in_period',
    {
      p_org_id: orgId,
      p_start: `${periodStart}T00:00:00.000Z`,
      p_end: `${periodEndExclusive}T00:00:00.000Z`,
    },
  )

  if (creditsError) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Cannot get credits used', error: creditsError, metadata: { orgId } })
    throw simpleError('cannot_get_credits', 'Cannot get credits used', { error: creditsError })
  }
  const creditsUsed = Number(creditsSum || 0)

  // Format the metrics for the email
  const mau = metrics?.mau ?? 0
  const bandwidth = metrics?.bandwidth ?? 0
  const storage = metrics?.storage ?? 0
  const buildTimeUnit = metrics?.build_time_unit ?? 0

  // Get current plan and find the best plan for this usage
  const currentPlanName = await getCurrentPlanNameOrg(c, orgId)

  // Get current plan limits
  const { data: currentPlan } = await supabase
    .from('plans')
    .select('mau, bandwidth, storage, build_time_unit')
    .eq('name', currentPlanName)
    .single()

  // Find the best plan for the actual usage
  const bestPlanName = await findBestPlan(c, {
    mau,
    bandwidth,
    storage,
    build_time_unit: buildTimeUnit,
  })

  // Calculate usage percentages against current plan limits
  const mauPercent = currentPlan?.mau ? Math.round((mau / currentPlan.mau) * 100) : 0
  const bandwidthPercent = currentPlan?.bandwidth ? Math.round((bandwidth / currentPlan.bandwidth) * 100) : 0
  const storagePercent = currentPlan?.storage ? Math.round((storage / currentPlan.storage) * 100) : 0
  const buildTimePercent = currentPlan?.build_time_unit ? Math.round((buildTimeUnit / currentPlan.build_time_unit) * 100) : 0

  // The highest usage percentage determines if we should recommend an upgrade
  const maxUsagePercent = Math.max(mauPercent, bandwidthPercent, storagePercent, buildTimePercent)

  // Determine if the user should consider upgrading
  // If usage is >= 90% of any limit, or if the best plan is higher than current plan
  const planOrder = ['Solo', 'Maker', 'Team', 'Enterprise']
  const rawCurrentPlanIndex = planOrder.indexOf(currentPlanName)
  const rawBestPlanIndex = planOrder.indexOf(bestPlanName)

  // Handle unknown plan names (e.g., Free, custom plans, legacy plans)
  // Treat unknown plans as lowest tier (index 0) for comparison purposes
  const currentPlanIndex = rawCurrentPlanIndex === -1 ? 0 : rawCurrentPlanIndex
  const bestPlanIndex = rawBestPlanIndex === -1 ? 0 : rawBestPlanIndex

  // Should upgrade if:
  // 1. Best plan is higher tier than current plan (user exceeded their plan), OR
  // 2. Usage is >= 90% of any metric limit (user is close to exceeding)
  const exceededPlan = bestPlanIndex > currentPlanIndex
  const nearingLimits = maxUsagePercent >= 90
  const shouldUpgrade = exceededPlan || nearingLimits

  // If should upgrade, recommend the best plan for their usage
  // If best plan equals current (user is within limits but near 90%), recommend next tier
  let recommendedPlan = currentPlanName
  if (shouldUpgrade) {
    if (exceededPlan) {
      // User already exceeded their plan, recommend the best fitting plan
      recommendedPlan = bestPlanName
    }
    else if (nearingLimits && currentPlanIndex < planOrder.length - 1) {
      // User is near limits but hasn't exceeded, recommend next tier up
      recommendedPlan = planOrder[currentPlanIndex + 1]
    }
  }

  // Determine which metrics are at high usage (>= 90%)
  const highUsageMetrics: string[] = []
  if (mauPercent >= 90)
    highUsageMetrics.push('MAU')
  if (bandwidthPercent >= 90)
    highUsageMetrics.push('Bandwidth')
  if (storagePercent >= 90)
    highUsageMetrics.push('Storage')
  if (buildTimePercent >= 90)
    highUsageMetrics.push('Build Time')

  const metadata = {
    org_id: orgId,
    org_name: org.name ?? '',
    monthly_active_users: formatNumber(mau),
    bandwidth_used: formatBytes(bandwidth),
    storage_used: formatBytes(storage),
    build_time_used: formatNumber(buildTimeUnit),
    credits_used: formatNumber(Math.round(creditsUsed * 100) / 100),
    // Raw values for potential use in email templates
    mau_raw: mau.toString(),
    bandwidth_raw: bandwidth.toString(),
    storage_raw: storage.toString(),
    build_time_raw: buildTimeUnit.toString(),
    credits_raw: creditsUsed.toString(),
    // Include period dates for context (half-open [start, end))
    period_start: periodStart,
    period_end: periodEndExclusive,
    // Plan information
    current_plan: currentPlanName,
    recommended_plan: recommendedPlan,
    should_upgrade: shouldUpgrade ? 'true' : 'false',
    // Upgrade reason details
    exceeded_plan: exceededPlan ? 'true' : 'false',
    nearing_limits: nearingLimits ? 'true' : 'false',
    high_usage_metrics: highUsageMetrics.join(', ') || 'none',
    // Usage percentages
    mau_percent: mauPercent.toString(),
    bandwidth_percent: bandwidthPercent.toString(),
    storage_percent: storagePercent.toString(),
    build_time_percent: buildTimePercent.toString(),
    max_usage_percent: maxUsagePercent.toString(),
  }

  await sendEmailToOrgMembers(c, 'org:billing_period_stats', 'billing_period_stats', metadata, orgId)

  return c.json(BRES)
}

async function handleDailyFailRatio(
  c: Context,
  payload: {
    appId?: string
    orgId?: string
    appName?: string
    totalInstalls?: number
    totalFails?: number
    failPercentage?: number
    reportDate?: string
  },
) {
  const {
    appId,
    orgId,
    appName,
    totalInstalls,
    totalFails,
    failPercentage,
    reportDate,
  } = payload

  if (!appId) {
    throw simpleError('missing_app_id', 'Missing appId for daily_fail_ratio', { orgId })
  }

  // Safely handle numeric values and clamp percentages to valid range
  const safeFailPercentage = typeof failPercentage === 'number' && Number.isFinite(failPercentage)
    ? Math.min(Math.max(failPercentage, 0), 100)
    : 0
  const safeSuccessPercentage = Math.max(100 - safeFailPercentage, 0)

  const metadata = {
    app_id: appId,
    org_id: orgId ?? '',
    app_name: appName ?? '',
    total_installs: (totalInstalls ?? 0).toString(),
    total_fails: (totalFails ?? 0).toString(),
    fail_percentage: safeFailPercentage.toFixed(2),
    report_date: reportDate ?? '',
    success_percentage: safeSuccessPercentage.toFixed(2),
  }

  await sendEmailToOrgMembers(c, 'app:daily_fail_ratio', 'daily_fail_ratio', metadata, orgId ?? await getOrgIdForApp(c, appId))

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Daily fail ratio email sent',
    appId,
    failPercentage,
  })

  return c.json(BRES)
}
