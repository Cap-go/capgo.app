import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import {
  buildWeeklyEmailMetadata,
  computeWeeklyInstallStats,
  getPreviousMonthUtcRange,
  shouldRetryDeployInstallStats,
  shouldSendDeployInstallStatsEmail,
  sumVersionInstalls,
} from '../utils/cron_email_stats.ts'
import { BRES, middlewareAPISecret, parseBody, simpleError } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { sendEmailToOrgMembers } from '../utils/org_email_notifications.ts'
import { findBestPlan } from '../utils/plans.ts'
import { readStatsVersion } from '../utils/stats.ts'
import { getCurrentPlanNameOrg, supabaseAdmin } from '../utils/supabase.ts'

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

  // get_weekly_stats.all_updates is SUM(install); failed_updates is SUM(fail).
  // Those are independent counters, so rates use install / (install + fail).
  const stats = computeWeeklyInstallStats(weeklyStats)

  if (stats.totalUpdates === 0) {
    return c.json({ status: 'No updates this week' }, 200)
  }

  const metadata = buildWeeklyEmailMetadata(appId, stats)

  await sendEmailToOrgMembers(c, 'user:weekly_stats', 'weekly_stats', metadata, await getOrgIdForApp(c, appId))

  return c.json(BRES)
}

async function handleMonthlyCreateStats(c: Context, appId: string) {
  const supabase = await supabaseAdmin(c)

  // Previous calendar month in UTC: [start, nextMonthStart)
  const { startIso, endExclusiveIso, monthName } = getPreviousMonthUtcRange()

  // Fetch stats for bundle creation and publishing
  const { data: appVersions, error: appVersionsError } = await supabase
    .from('app_versions')
    .select('id, created_at')
    .eq('app_id', appId)
    .gte('created_at', startIso)
    .lt('created_at', endExclusiveIso)

  if (appVersionsError) {
    throw simpleError('cannot_fetch_monthly_bundles', 'Cannot fetch monthly bundle stats', {
      error: appVersionsError,
      appId,
    })
  }

  const { data: deployHistory, error: deployHistoryError } = await supabase
    .from('deploy_history')
    .select('id, deployed_at')
    .eq('app_id', appId)
    .gte('deployed_at', startIso)
    .lt('deployed_at', endExclusiveIso)

  if (deployHistoryError) {
    throw simpleError('cannot_fetch_monthly_publishes', 'Cannot fetch monthly publish stats', {
      error: deployHistoryError,
      appId,
    })
  }

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
  // Do not filter by channel here: older VERSION_USAGE rows may lack channel blobs,
  // and this email counts installs for the deployed version across the app.
  const versionStats = await readStatsVersion(c, appId, windowStart, windowEnd)
  // Filter by version_name (new format) OR version_id as string (old Cloudflare format).
  // Coerce installs with Number() — Analytics Engine sum() can arrive as stringy Float64.
  const installs = sumVersionInstalls(versionStats, versionName, versionId)

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

  if (shouldSendDeployInstallStatsEmail(installs)) {
    await sendEmailToOrgMembers(c, 'bundle:install_stats_24h', 'deploy_stats_24h', metadata, orgId ?? await getOrgIdForApp(c, appId))
    return c.json(BRES)
  }

  // SQL claims install_stats_email_sent_at before the worker runs. If analytics
  // lagged or returned unusable counts, release the claim so cron can retry
  // while this deploy is still the latest within the retry window.
  if (deployId && shouldRetryDeployInstallStats(deployTime)) {
    const { error: releaseError } = await supabaseAdmin(c)
      .from('deploy_history')
      .update({ install_stats_email_sent_at: null })
      .eq('id', deployId)
    if (releaseError) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Failed to release deploy install stats email claim for retry',
        error: releaseError,
        metadata: { appId, deployId, installs },
      })
      // Fail the job so the queue can retry instead of permanently keeping the claim.
      throw simpleError('cannot_release_deploy_stats_claim', 'Cannot release deploy install stats email claim', {
        error: releaseError,
        appId,
        deployId,
        installs,
      })
    }
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Released deploy install stats email claim for retry',
      metadata: { appId, deployId, installs },
    })
  }

  return c.json({ status: 'Not enough installs for deploy stats email', installs }, 200)
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
  let startDate: string
  let endDate: string

  if (cycleStart && cycleEnd) {
    // Use dates passed from the SQL function (guaranteed to be the completed billing period)
    startDate = new Date(cycleStart).toISOString().split('T')[0]
    endDate = new Date(cycleEnd).toISOString().split('T')[0]
  }
  else {
    // Fallback: get cycle info from RPC
    const { data: cycleInfo, error: cycleError } = await supabase
      .rpc('get_cycle_info_org', { orgid: orgId })
      .single()

    if (cycleError || !cycleInfo) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Cannot get cycle info', error: cycleError, metadata: { orgId } })
      throw simpleError('cannot_get_cycle_info', 'Cannot get cycle info', { error: cycleError })
    }

    startDate = new Date(cycleInfo.subscription_anchor_start).toISOString().split('T')[0]
    endDate = new Date(cycleInfo.subscription_anchor_end).toISOString().split('T')[0]
  }

  // Get total metrics for the billing period
  const { data: metrics, error: metricsError } = await supabase
    .rpc('get_total_metrics', {
      org_id: orgId,
      start_date: startDate,
      end_date: endDate,
    })
    .single()

  if (metricsError) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Cannot get total metrics', error: metricsError, metadata: { orgId } })
    throw simpleError('cannot_get_metrics', 'Cannot get metrics', { error: metricsError })
  }

  // Get credits used in the billing period
  let creditsUsed = 0
  const { data: credits } = await supabase
    .from('usage_credit_consumptions')
    .select('credits_used')
    .eq('org_id', orgId)
    .gte('applied_at', startDate)
    .lt('applied_at', endDate)

  if (credits) {
    creditsUsed = credits.reduce((sum, row) => sum + Number(row.credits_used || 0), 0)
  }

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
    credits_used: formatNumber(Math.round(creditsUsed * 100) / 100),
    // Raw values for potential use in email templates
    mau_raw: mau.toString(),
    bandwidth_raw: bandwidth.toString(),
    storage_raw: storage.toString(),
    credits_raw: creditsUsed.toString(),
    // Include period dates for context
    period_start: startDate,
    period_end: endDate,
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
