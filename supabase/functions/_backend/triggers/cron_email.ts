import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { DeployReportState } from '../utils/deploy_report.ts'
import type { PgClient } from '../utils/pg.ts'
import { Hono } from 'hono/tiny'
import {
  buildWeeklyEmailMetadata,
  computeWeeklyInstallStats,
  getPreviousMonthUtcRange,
  shouldSendDeployInstallStatsEmail,
  sumVersionInstalls,
} from '../utils/cron_email_stats.ts'
import { DEPLOY_REPORT_CONSUME_SQL, DEPLOY_REPORT_RELEASE_SQL, DEPLOY_REPORT_SELECT_SQL } from '../utils/deploy_report.ts'
import { BRES, middlewareAPISecret, parseBody, simpleError } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { prepareEmailToOrgMembers, sendEmailToOrgMembers } from '../utils/org_email_notifications.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { queryJson } from '../utils/pg_rls.ts'
import { findBestPlan } from '../utils/plans.ts'
import { readStatsVersion } from '../utils/stats.ts'
import { getCurrentPlanNameOrg, getOrgExtraMau } from '../utils/supabase.ts'

export const app = new Hono<MiddlewareKeyVariables>()

async function getOrgIdForApp(c: Context, appId: string, pg?: PgClient): Promise<string> {
  const client = pg ?? await getPgClient(c)
  let appData: { owner_org: string | null } | null = null
  let appError: unknown = null
  try {
    const result = await client.query<{ owner_org: string | null }>('SELECT owner_org FROM public.apps WHERE app_id = $1 LIMIT 2', [appId])
    if (result.rows.length === 1)
      appData = result.rows[0]
    else
      appError = { code: 'PGRST116', message: `Expected 1 app row, got ${result.rows.length}` }
  }
  catch (error) {
    appError = error
  }
  finally {
    if (!pg)
      closeClient(c, client)
  }

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
    reportClaimedAt,
    appName,
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
    reportClaimedAt?: string
    appName?: string
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
    return c.json({ status: 'skipped', reason: 'legacy_report_job' })
  }
  else if (type === 'deploy_install_stats_v2') {
    return await handleDeployInstallStats(c, {
      appId,
      deployId,
      reportClaimedAt,
    })
  }
  else {
    throw simpleError('invalid_stats_type', 'Invalid stats type', { email, appId, type })
  }
})

async function handleWeeklyInstallStats(c: Context, appId: string) {
  const pg = await getPgClient(c)
  try {
    return await sendWeeklyInstallStats(c, pg, appId)
  }
  finally {
    closeClient(c, pg)
  }
}

async function sendWeeklyInstallStats(c: Context, pg: PgClient, appId: string) {
  let weeklyStats: { all_updates: number, failed_updates: number, open_app: number } | null = null
  let generateStatsError: unknown = null
  try {
    const rows = await queryJson<{ all_updates: number, failed_updates: number, open_app: number }>(
      pg,
      'SELECT * FROM public.get_weekly_stats(app_id => $1)',
      [appId],
    )
    if (rows.length === 1)
      weeklyStats = rows[0]
    else
      generateStatsError = { code: 'PGRST116', message: `Expected 1 weekly stats row, got ${rows.length}` }
  }
  catch (error) {
    generateStatsError = error
  }

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

  await sendEmailToOrgMembers(c, 'user:weekly_stats', 'weekly_stats', metadata, await getOrgIdForApp(c, appId, pg))

  return c.json(BRES)
}

async function handleMonthlyCreateStats(c: Context, appId: string) {
  const pg = await getPgClient(c)
  try {
    return await sendMonthlyCreateStats(c, pg, appId)
  }
  finally {
    closeClient(c, pg)
  }
}

async function sendMonthlyCreateStats(c: Context, pg: PgClient, appId: string) {
  // Previous calendar month in UTC: [start, nextMonthStart)
  const { startIso, endExclusiveIso, monthName } = getPreviousMonthUtcRange()

  // Fetch stats for bundle creation and publishing
  let bundleCount: number
  try {
    const result = await pg.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM public.app_versions WHERE app_id = $1 AND created_at >= $2 AND created_at < $3',
      [appId, startIso, endExclusiveIso],
    )
    bundleCount = result.rows[0]?.count ?? 0
  }
  catch (appVersionsError) {
    throw simpleError('cannot_fetch_monthly_bundles', 'Cannot fetch monthly bundle stats', {
      error: appVersionsError,
      appId,
    })
  }

  let publishCount: number
  try {
    const result = await pg.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM public.deploy_history WHERE app_id = $1 AND deployed_at >= $2 AND deployed_at < $3',
      [appId, startIso, endExclusiveIso],
    )
    publishCount = result.rows[0]?.count ?? 0
  }
  catch (deployHistoryError) {
    throw simpleError('cannot_fetch_monthly_publishes', 'Cannot fetch monthly publish stats', {
      error: deployHistoryError,
      appId,
    })
  }

  const metadata = {
    app_id: appId,
    month_name: monthName,
    monthly_bundles_created: bundleCount.toString(),
    monthly_publishes: publishCount.toString(),
  }

  if (bundleCount > 0 || publishCount > 0) {
    await sendEmailToOrgMembers(c, 'org:monthly_create_stats', 'monthly_stats', metadata, await getOrgIdForApp(c, appId, pg))
  }

  return c.json(BRES)
}

async function handleDeployInstallStats(
  c: Context,
  payload: { appId: string, deployId?: number, reportClaimedAt?: string },
) {
  const { appId, deployId, reportClaimedAt } = payload
  // Older jobs have no claim token and cannot safely authorize a report.
  if (!Number.isSafeInteger(deployId) || !reportClaimedAt || !Number.isFinite(Date.parse(reportClaimedAt)))
    return c.json({ status: 'skipped', reason: 'invalid_report_claim' })

  const pg = await getPgClient(c)
  const claim = [deployId, appId, reportClaimedAt]
  try {
    const [deploy] = await queryJson<DeployReportState>(pg, DEPLOY_REPORT_SELECT_SQL, claim)
    if (!deploy)
      return c.json({ status: 'skipped', reason: 'deployment_no_longer_eligible' })

    const windowStart = new Date(deploy.deployed_at).toISOString()
    const windowEnd = new Date(Date.parse(windowStart) + 24 * 60 * 60 * 1000).toISOString()
    let installs: number
    try {
      // This is app-wide bundle activity, including legacy rows without channels.
      const rows = await readStatsVersion(c, appId, windowStart, windowEnd, undefined, { throwOnError: true })
      if (rows.some(row => row.app_id !== appId))
        throw new Error('Analytics returned rows for another app')
      installs = sumVersionInstalls(rows, deploy.version_name, deploy.version_id)
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Deploy report analytics unavailable or invalid; deferring email', deployId, error })
      // The hourly producer can re-enqueue within 48h without spending queue retries.
      await pg.query(DEPLOY_REPORT_RELEASE_SQL, claim)
      return c.json({ status: 'deferred', reason: 'invalid_or_unavailable_analytics' })
    }

    if (!shouldSendDeployInstallStatsEmail(installs)) {
      await pg.query(DEPLOY_REPORT_RELEASE_SQL, claim)
      return c.json({ status: 'deferred', reason: 'not_enough_installs' })
    }

    // Connection and recipient lookup failures leave the original claim retryable.
    const delivery = await prepareEmailToOrgMembers(c, 'bundle:install_stats_24h', 'deploy_stats_24h', deploy.owner_org, undefined, { requireCompleteRecipients: true })
    if (!delivery)
      return c.json({ status: 'skipped', reason: 'no_eligible_recipients' })

    const [current] = await queryJson<DeployReportState>(pg, DEPLOY_REPORT_CONSUME_SQL, [
      ...claim, deploy.version_id, deploy.version_name, deploy.owner_org, deploy.deployed_at,
    ])
    if (!current)
      return c.json({ status: 'skipped', reason: 'deployment_changed_or_claim_consumed' })

    delivery.send({
      report_schema_version: '2',
      app_id: current.app_id,
      app_name: current.app_name || current.app_id,
      deploy_id: current.id.toString(),
      version_id: current.version_id.toString(),
      version_name: current.version_name,
      channel_id: current.channel_id.toString(),
      channel_name: current.channel_name,
      platform: current.platform,
      deployed_at: windowStart,
      window_start: windowStart,
      window_end: windowEnd,
      install_count_24h: installs.toString(),
      install_count_is_estimate: c.env.VERSION_USAGE ? 'true' : 'false',
      window_hours: '24',
    })
    return c.json(BRES)
  }
  finally {
    closeClient(c, pg)
  }
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
  const pg = await getPgClient(c)
  try {
    return await sendBillingPeriodStats(c, pg, orgId, cycleStart, cycleEnd)
  }
  finally {
    closeClient(c, pg)
  }
}

async function sendBillingPeriodStats(c: Context, pg: PgClient, orgId: string, cycleStart?: string, cycleEnd?: string) {
  // Get organization info
  let org: { id: string, name: string } | null = null
  let orgError: unknown = null
  try {
    const result = await pg.query<{ id: string, name: string }>('SELECT id, name FROM public.orgs WHERE id = $1', [orgId])
    if (result.rows.length === 1)
      org = result.rows[0]
    else
      orgError = { code: 'PGRST116', message: `Expected 1 org row, got ${result.rows.length}` }
  }
  catch (error) {
    orgError = error
  }

  if (orgError || !org) {
    throw simpleError('org_not_found', 'Organization not found', { orgId, orgError })
  }

  // Use cycle dates passed from the SQL function if available,
  // otherwise fall back to get_cycle_info_org (for backwards compatibility)
  let cycleStartTs: string
  let cycleEndTs: string

  if (cycleStart && cycleEnd) {
    // Completed billing period from SQL: [cycleStart, cycleEnd)
    cycleStartTs = cycleStart
    cycleEndTs = cycleEnd
  }
  else {
    // Fallback: get cycle info from RPC (current cycle, same half-open bounds)
    let cycleInfo: { subscription_anchor_start: string, subscription_anchor_end: string } | null = null
    let cycleError: unknown = null
    try {
      const rows = await queryJson<{ subscription_anchor_start: string, subscription_anchor_end: string }>(
        pg,
        'SELECT * FROM public.get_cycle_info_org(orgid => $1)',
        [orgId],
      )
      if (rows.length === 1)
        cycleInfo = rows[0]
      else
        cycleError = { code: 'PGRST116', message: `Expected 1 cycle info row, got ${rows.length}` }
    }
    catch (error) {
      cycleError = error
    }

    if (cycleError || !cycleInfo) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Cannot get cycle info', error: cycleError, metadata: { orgId } })
      throw simpleError('cannot_get_cycle_info', 'Cannot get cycle info', { error: cycleError })
    }

    cycleStartTs = cycleInfo.subscription_anchor_start
    cycleEndTs = cycleInfo.subscription_anchor_end
  }

  const { periodStart, periodEndExclusive, metricsEndInclusive } = billingPeriodMetricsRange(
    cycleStartTs,
    cycleEndTs,
  )

  // Guard against inverted/empty ranges (e.g. bad payloads)
  if (metricsEndInclusive < periodStart) {
    throw simpleError('invalid_billing_period', 'Invalid billing period dates', {
      periodStart,
      periodEndExclusive,
      metricsEndInclusive,
    })
  }

  // Get total metrics for the completed billing period days
  let metrics: { mau: number, bandwidth: number, storage: number, build_time_unit: number } | null = null
  let metricsError: unknown = null
  try {
    const rows = await queryJson<{ mau: number, bandwidth: number, storage: number, build_time_unit: number }>(
      pg,
      'SELECT * FROM public.get_total_metrics(org_id => $1, start_date => $2::date, end_date => $3::date)',
      [orgId, periodStart, metricsEndInclusive],
    )
    if (rows.length === 1)
      metrics = rows[0]
    else
      metricsError = { code: 'PGRST116', message: `Expected 1 metrics row, got ${rows.length}` }
  }
  catch (error) {
    metricsError = error
  }

  if (metricsError) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Cannot get total metrics', error: metricsError, metadata: { orgId } })
    throw simpleError('cannot_get_metrics', 'Cannot get metrics', { error: metricsError })
  }

  // Half-open credit sum on the same timestamptz bounds as the cycle payload.
  // Cron path uses UTC midnight bounds so the 12:00 UTC job never under-counts
  // a still-open Stripe afternoon anchor.
  let creditsSum: string | number | null = null
  let creditsError: unknown = null
  try {
    const result = await pg.query<{ credits: string | null }>(
      'SELECT public.get_org_credits_used_in_period(p_org_id => $1, p_start => $2::timestamptz, p_end => $3::timestamptz) AS credits',
      [orgId, cycleStartTs, cycleEndTs],
    )
    creditsSum = result.rows[0]?.credits ?? null
  }
  catch (error) {
    creditsError = error
  }

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
  const currentPlanRows = await queryJson<{ mau: number, bandwidth: number, storage: number, build_time_unit: number }>(
    pg,
    'SELECT mau, bandwidth, storage, build_time_unit FROM public.plans WHERE name = $1 LIMIT 2',
    [currentPlanName],
  ).catch((error: unknown) => {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Cannot get current plan limits', error, metadata: { orgId, currentPlanName } })
    return []
  })
  const currentPlan = currentPlanRows.length === 1 ? currentPlanRows[0] : null

  // Find the best plan for the actual usage
  const bestPlanName = await findBestPlan(c, {
    mau,
    bandwidth,
    storage,
    build_time_unit: buildTimeUnit,
  })

  // Calculate usage percentages against current plan limits
  const mauLimit = currentPlan?.mau ? currentPlan.mau + await getOrgExtraMau(c, orgId) : 0
  const mauPercent = mauLimit ? Math.round((mau / mauLimit) * 100) : 0
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
