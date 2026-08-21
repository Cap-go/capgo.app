import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database, Json } from '../utils/supabase.types.ts'

import { sql } from 'drizzle-orm'
import { Hono } from 'hono/tiny'

import { getDeviceDaySuccessRateCF, getLastMonthAnalyticsWindowStart, getPluginBreakdownCF, readActiveAppsCF, readLastMonthDevicesByPlatformCF, readLastMonthDevicesCF, readLastMonthUpdatesCF } from '../utils/cloudflare.ts'
import { GLOBAL_STATS_SHARDS, REQUIRED_GLOBAL_STATS_SHARDS, USAGE_GLOBAL_STATS_SHARDS } from '../utils/global_stats.ts'
import { BRES, middlewareAPISecret, quickError } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { readGlobalNotificationStatsCF } from '../utils/nativeNotifications.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { countAllApps, countAllUpdates, countAllUpdatesExternal } from '../utils/stats.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { sendEventToTracking } from '../utils/tracking.ts'
import { backgroundTask } from '../utils/utils.ts'

const DAY_IN_MS = 24 * 60 * 60 * 1000

interface PlanTotal { [key: string]: number }
interface BuildStats {
  total: number
  ios: number
  android: number
  last_month: number
  last_month_ios: number
  last_month_android: number
  success_total: number
  success_ios: number
  success_android: number
  total_seconds_day_ios: number
  total_seconds_day_android: number
  avg_seconds_day_ios: number
  avg_seconds_day_android: number
  build_count_day_ios: number
  build_count_day_android: number
  daily_metrics_available: boolean
}
type AppBuildOnboardingMetrics = Record<string, unknown> & {
  apps_created: number
  apps_with_cli_onboarding_builds_24h: number
  apps_with_manual_builds_24h: number
}
interface AppBuildOnboardingMetricRow {
  [key: string]: unknown
  created_at: string | Date | null
  created_from_onboarding: boolean | null
  onboarding_completed_at: string | Date | null
  build_count: number | string | null
}

function parseMetricDate(value: string | Date | null): number | null {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : null
  }
  if (!value)
    return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

function summarizeAppBuildOnboardingRows(rows: AppBuildOnboardingMetricRow[]): AppBuildOnboardingMetrics {
  return rows.reduce<AppBuildOnboardingMetrics>((totals, row) => {
    totals.apps_created += 1

    const buildCount = Number(row.build_count) || 0
    if (buildCount <= 2)
      return totals

    if (row.created_from_onboarding === true) {
      const createdAt = parseMetricDate(row.created_at)
      const completedAt = parseMetricDate(row.onboarding_completed_at)
      const completedWithinFirstDay = createdAt !== null
        && completedAt !== null
        && completedAt >= createdAt
        && completedAt < createdAt + DAY_IN_MS
      if (completedWithinFirstDay)
        totals.apps_with_cli_onboarding_builds_24h += 1
    }
    else {
      totals.apps_with_manual_builds_24h += 1
    }

    return totals
  }, {
    apps_created: 0,
    apps_with_cli_onboarding_builds_24h: 0,
    apps_with_manual_builds_24h: 0,
  })
}

interface DailyWindow {
  prevDayStart: Date
  prevDayEnd: Date
  prevDayDateId: string
}
interface CurrentDayWindow {
  dayStart: Date
  nextDayStart: Date
  dayDateId: string
}
interface PlanRevenue {
  mrr: number
  total_revenue: number
  revenue_solo: number
  revenue_maker: number
  revenue_team: number
  revenue_enterprise: number
  plan_solo_monthly: number
  plan_solo_yearly: number
  plan_maker_monthly: number
  plan_maker_yearly: number
  plan_team_monthly: number
  plan_team_yearly: number
  plan_enterprise_monthly: number
  plan_enterprise_yearly: number
}
interface PlanConversionRates {
  enterprise: number
  maker: number
  solo: number
  team: number
  total: number
}
interface DailyRevenueChangeSummary {
  churnMrr: number
  contractionMrr: number
  expansionMrr: number
}
interface RevenueRetentionMetrics {
  churnRevenue: number
  churnRevenueSolo: number
  churnRevenueMaker: number
  churnRevenueTeam: number
  churnRevenueEnterprise: number
  nrr: number
}
interface PaidProductActivityStats {
  builder_active_paying_clients_60d: number
  live_updates_active_paying_clients_60d: number
}
interface LtvStats {
  average_ltv: number
  shortest_ltv: number
  longest_ltv: number
}
interface TrialExtensionStats {
  [key: string]: unknown
  trial_extended_orgs: number
  trial_extended_subscribed_orgs: number
}
interface BillingSnapshotCustomerCounts {
  yearly: number
  monthly: number
  total: number
}
interface BillingSnapshotCounts {
  customers: BillingSnapshotCustomerCounts
  plans: PlanTotal
  payingOrgsForConversion: number
}
interface BillingSnapshotRow {
  [key: string]: unknown
  yearly: number | string | null
  monthly: number | string | null
  total: number | string | null
  paying_orgs_for_conversion: number | string | null
  plan_name: string | null
  plan_count: number | string | null
}
interface CoreSnapshotCounts {
  onboarded: number
  needUpgrade: number
  abovePlanWithCredits: number
  abovePlanWithoutCredits: number
}
interface CoreSnapshotRow {
  [key: string]: unknown
  onboarded: number | string | null
  need_upgrade: number | string | null
  above_plan_with_credits: number | string | null
  above_plan_without_credits: number | string | null
}
interface CustomerIdRow {
  customer_id: string
}
interface PastDueOrgStats {
  past_due_orgs: number
  past_due_orgs_average_days: number
}
interface PastDueOrgRow extends CustomerIdRow {
  past_due_at?: string | null
  updated_at?: string | null
}
interface SubscriptionAccessSnapshotCounts {
  active_canceled_orgs: number
  active_past_due_orgs: number
}
interface SubscriptionAccessRow extends CustomerIdRow {
  created_at?: string | null
  paid_at?: string | null
  canceled_at?: string | null
  past_due_at?: string | null
  subscription_anchor_end?: string | null
  status?: string | null
  is_good_plan?: boolean | null
}
interface SubscriptionAccessSnapshotSqlRow {
  [key: string]: unknown
  active_canceled_orgs: number | string | null
  active_past_due_orgs: number | string | null
}
const REVENUE_ACTIVE_STRIPE_STATUSES: Database['public']['Enums']['stripe_status'][] = ['succeeded']

function getDateId(targetDate = new Date()): string {
  return new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate())).toISOString().slice(0, 10)
}

function calculateConversionRate(converted: number | null | undefined, totalOrgs: number) {
  if (totalOrgs <= 0)
    return 0
  return Number((((converted ?? 0) * 100) / totalOrgs).toFixed(1))
}

const GLOBAL_STATS_PLAN_KEYS = ['Trial', 'Solo', 'Maker', 'Team', 'Enterprise', 'Credits'] as const

function normalizePlanTotals(plans: PlanTotal): PlanTotal {
  const normalized: PlanTotal = {}

  for (const [key, value] of Object.entries(plans))
    normalized[key] = Number(value) || 0

  for (const key of GLOBAL_STATS_PLAN_KEYS)
    normalized[key] = Number(normalized[key]) || 0

  return normalized
}

function getEmptyBillingSnapshotCounts(): BillingSnapshotCounts {
  return {
    customers: { yearly: 0, monthly: 0, total: 0 },
    payingOrgsForConversion: 0,
    plans: normalizePlanTotals({}),
  }
}

function normalizeBillingSnapshotCounts(rows: BillingSnapshotRow[]): BillingSnapshotCounts {
  const firstRow = rows[0]
  if (!firstRow)
    return getEmptyBillingSnapshotCounts()

  const plans: PlanTotal = {}
  for (const row of rows) {
    if (!row.plan_name)
      continue
    plans[row.plan_name] = Number(row.plan_count) || 0
  }

  return {
    customers: {
      yearly: Number(firstRow.yearly) || 0,
      monthly: Number(firstRow.monthly) || 0,
      total: Number(firstRow.total) || 0,
    },
    payingOrgsForConversion: Number(firstRow.paying_orgs_for_conversion) || 0,
    plans: normalizePlanTotals(plans),
  }
}

function isUnpaidAtBillingSnapshot(paidAt: Date | string | null | undefined, snapshotExclusiveEnd: Date): boolean {
  if (!paidAt)
    return true
  return new Date(paidAt).getTime() >= snapshotExclusiveEnd.getTime()
}

function isPaidPlanAtBillingSnapshot(
  paidAt: Date | string | null | undefined,
  _trialAt: Date | string | null | undefined,
  snapshotExclusiveEnd: Date,
): boolean {
  // Paying plan snapshots must have converted (paid_at). Unpaid / never-converted
  // trial rows used to inflate Solo/Maker counts and diverge from Stripe MRR.
  if (!paidAt)
    return false
  return new Date(paidAt).getTime() < snapshotExclusiveEnd.getTime()
}

const YEARLY_ANCHOR_DAYS = 300
const ONE_DAY_SECONDS = 24 * 60 * 60

function getEmptyPlanRevenue(): PlanRevenue {
  return {
    mrr: 0,
    total_revenue: 0,
    revenue_solo: 0,
    revenue_maker: 0,
    revenue_team: 0,
    revenue_enterprise: 0,
    plan_solo_monthly: 0,
    plan_solo_yearly: 0,
    plan_maker_monthly: 0,
    plan_maker_yearly: 0,
    plan_team_monthly: 0,
    plan_team_yearly: 0,
    plan_enterprise_monthly: 0,
    plan_enterprise_yearly: 0,
  }
}

function roundRevenueMoney(value: number) {
  return Number(value.toFixed(2))
}

export function resolvePlanBillingInterval(options: {
  priceId: string | null | undefined
  priceMId: string | null | undefined
  priceYId: string | null | undefined
  anchorStart: Date | string | null | undefined
  anchorEnd: Date | string | null | undefined
}): 'monthly' | 'yearly' {
  if (options.priceId && options.priceMId && options.priceId === options.priceMId)
    return 'monthly'
  if (options.priceId && options.priceYId && options.priceId === options.priceYId)
    return 'yearly'

  const startMs = options.anchorStart ? new Date(options.anchorStart).getTime() : Number.NaN
  const endMs = options.anchorEnd ? new Date(options.anchorEnd).getTime() : Number.NaN
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
    const days = (endMs - startMs) / (ONE_DAY_SECONDS * 1000)
    if (days >= YEARLY_ANCHOR_DAYS)
      return 'yearly'
  }

  return 'monthly'
}

export function resolvePlanMrrDollars(options: {
  billing: 'monthly' | 'yearly'
  priceId: string | null | undefined
  priceMId: string | null | undefined
  priceYId: string | null | undefined
  priceM: number | null | undefined
  priceY: number | null | undefined
}): number {
  const priceM = Number(options.priceM) || 0
  const priceY = Number(options.priceY) || 0

  if (options.priceId && options.priceMId && options.priceId === options.priceMId)
    return priceM
  if (options.priceId && options.priceYId && options.priceId === options.priceYId)
    return priceY / 12

  return options.billing === 'yearly' ? priceY / 12 : priceM
}

function hasLeftTrialAtSnapshot(
  trialAt: Date | string | null | undefined,
  snapshotExclusiveEnd: Date,
): boolean {
  // Mirrors SQL: si.trial_at <= snapshotExclusiveEnd (NULL does not pass).
  // paid_at can be set on subscription.created / checkout before the first charge;
  // Capgo stores Stripe trial_end in trial_at, so MRR stays $0 until that boundary.
  if (!trialAt)
    return false
  const trialAtTime = new Date(trialAt).getTime()
  return Number.isFinite(trialAtTime) && trialAtTime <= snapshotExclusiveEnd.getTime()
}

function applySubscriptionRevenue(
  revenue: PlanRevenue,
  planKey: string,
  billing: 'monthly' | 'yearly',
  mrr: number,
) {
  if (planKey === 'solo') {
    revenue.mrr += mrr
    revenue.revenue_solo += mrr * 12
    if (billing === 'monthly')
      revenue.plan_solo_monthly++
    else
      revenue.plan_solo_yearly++
    return
  }
  if (planKey === 'maker') {
    revenue.mrr += mrr
    revenue.revenue_maker += mrr * 12
    if (billing === 'monthly')
      revenue.plan_maker_monthly++
    else
      revenue.plan_maker_yearly++
    return
  }
  if (planKey === 'team') {
    revenue.mrr += mrr
    revenue.revenue_team += mrr * 12
    if (billing === 'monthly')
      revenue.plan_team_monthly++
    else
      revenue.plan_team_yearly++
    return
  }
  if (planKey === 'enterprise') {
    revenue.mrr += mrr
    revenue.revenue_enterprise += mrr * 12
    if (billing === 'monthly')
      revenue.plan_enterprise_monthly++
    else
      revenue.plan_enterprise_yearly++
  }
}

function normalizeCoreSnapshotCounts(row: Partial<CoreSnapshotRow> | null | undefined): CoreSnapshotCounts {
  return {
    onboarded: Number(row?.onboarded) || 0,
    needUpgrade: Number(row?.need_upgrade) || 0,
    abovePlanWithCredits: Number(row?.above_plan_with_credits) || 0,
    abovePlanWithoutCredits: Number(row?.above_plan_without_credits) || 0,
  }
}

const GLOBAL_STATS_BACKGROUND_MAX_RETRIES = 4
const GLOBAL_STATS_RETRY_DELAY_SECONDS = 300
const GLOBAL_STATS_QUEUE_NAME = 'admin_stats'
const GLOBAL_STATS_NOTIFICATION_DELAY_SECONDS = 180
const GLOBAL_STATS_RECENT_REPAIR_LOOKBACK_DAYS = 30
// Keep the legacy key so old and new workers contend on the same lock during rolling deployments.
const GLOBAL_STATS_NOTIFICATION_LOCK_NAMESPACE = 'logsnag_insights_notifications'
const GLOBAL_STATS_NOTIFICATION_TRACKING_STEP = 'notifications_tracking'
const GLOBAL_STATS_NOTIFICATION_TRACKING_CLAIM = 'notifications_tracking_claim'
const GLOBAL_STATS_COMPLETION_MARKERS = [
  ...GLOBAL_STATS_SHARDS,
  GLOBAL_STATS_NOTIFICATION_TRACKING_STEP,
  GLOBAL_STATS_NOTIFICATION_TRACKING_CLAIM,
] as const
const GLOBAL_STATS_SHARD_SET = new Set<string>(GLOBAL_STATS_SHARDS)
const GLOBAL_STATS_COMPLETION_MARKER_SET = new Set<string>(GLOBAL_STATS_COMPLETION_MARKERS)
const GLOBAL_STATS_BUILD_AVG_EPSILON = 0.05

type GlobalStatsShard = typeof GLOBAL_STATS_SHARDS[number]
type GlobalStatsCompletionMarker = typeof GLOBAL_STATS_COMPLETION_MARKERS[number]
type RequiredGlobalStatsShard = typeof REQUIRED_GLOBAL_STATS_SHARDS[number]
type GlobalStatsNotificationStepAction = 'send' | 'complete_claimed' | 'skip'
type GlobalStatsUpdate = Database['public']['Tables']['global_stats']['Update']
type GlobalStatsRow = Database['public']['Tables']['global_stats']['Row']
type GlobalStatsSnapshotPatch = GlobalStatsUpdate & {
  orgs?: number
  // Present in repo migrations before prod deploy; keep writable while generated types lag.
  apps_with_preview?: number
  plan_credits?: number
}
type GlobalStatsSnapshotRow = GlobalStatsRow & {
  orgs?: number | null
  apps_with_preview?: number | null
  plan_credits?: number | null
}

interface GlobalStatsPayload {
  retry_count?: unknown
  shard?: unknown
  date_id?: unknown
}

interface BuildShardStats {
  totalSeconds: Record<'ios' | 'android', number>
  avgSeconds: Record<'ios' | 'android', number>
  counts: Record<'ios' | 'android', number>
}

interface GlobalStatsRepairRow {
  dateId: string
  completedShards: Set<GlobalStatsCompletionMarker>
  orgs: number
  bundleStorageGb: number
  buildTotalSecondsDayIos: number
  buildTotalSecondsDayAndroid: number
  buildAvgSecondsDayIos: number
  buildAvgSecondsDayAndroid: number
  buildCountDayIos: number
  buildCountDayAndroid: number
}

interface GlobalStatsRepairSqlRow {
  date_id: string
  completed_shards: unknown
  orgs: number | string | null
  bundle_storage_gb: number | string | null
  build_total_seconds_day_ios: number | string | null
  build_total_seconds_day_android: number | string | null
  build_avg_seconds_day_ios: number | string | null
  build_avg_seconds_day_android: number | string | null
  build_count_day_ios: number | string | null
  build_count_day_android: number | string | null
}

interface ScheduleGlobalStatsUpdateOptions {
  retryCount?: number
  retryMsgId?: number | null
  cancelRetry?: (c: Context, retryMsgId: number) => Promise<void>
}

interface ScheduleGlobalStatsShardOptions {
  retryCount?: number
  retryMsgId?: number | null
  cancelRetry?: (c: Context, retryMsgId: number) => Promise<void>
  runShard?: (c: Context, shard: GlobalStatsShard, dateId: string) => Promise<void>
}

function normalizeGlobalStatsRetryCount(value: unknown): number {
  const retryCount = Number(value)
  if (!Number.isFinite(retryCount) || retryCount < 0)
    return 0
  return Math.floor(retryCount)
}

function buildGlobalStatsRetryMessage(retryCount: number, dateId?: string) {
  return {
    function_name: 'global_stats',
    function_type: 'cloudflare',
    payload: {
      ...(dateId ? { date_id: dateId } : {}),
      retry_count: retryCount,
    },
  }
}

function getGlobalStatsShardFunctionName(shard: GlobalStatsShard): string {
  return `global_stats_${shard}`
}

function buildGlobalStatsShardMessage(shard: GlobalStatsShard, dateId: string, retryCount = 0) {
  return {
    function_name: getGlobalStatsShardFunctionName(shard),
    function_type: 'cloudflare',
    payload: {
      date_id: dateId,
      ...(retryCount > 0 ? { retry_count: retryCount } : {}),
    },
  }
}

async function readGlobalStatsPayload(c: Context): Promise<GlobalStatsPayload> {
  const rawBody = await c.req.raw.clone().text()
  if (!rawBody.trim())
    return {}

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  }
  catch (error) {
    quickError(400, 'invalid_global_stats_payload', 'Invalid Global stats payload', undefined, error, { alert: false })
  }

  if (!body || typeof body !== 'object' || Array.isArray(body))
    return {}
  return body as GlobalStatsPayload
}
function normalizeGlobalStatsShard(value: unknown): GlobalStatsShard | null {
  if (typeof value !== 'string' || !GLOBAL_STATS_SHARD_SET.has(value))
    return null
  return value as GlobalStatsShard
}

function normalizeGlobalStatsDateId(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null

  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || getDateId(date) !== value)
    return null

  return value
}

function getCompletedDayWindowForDateId(dateId: string): DailyWindow {
  const prevDayStart = new Date(`${dateId}T00:00:00.000Z`)
  const prevDayEnd = new Date(prevDayStart.getTime() + 24 * 60 * 60 * 1000)
  return {
    prevDayStart,
    prevDayEnd,
    prevDayDateId: dateId,
  }
}

function buildRecentGlobalStatsRepairDateIds(anchorDateId: string, lookbackDays = GLOBAL_STATS_RECENT_REPAIR_LOOKBACK_DAYS): string[] {
  const anchor = new Date(`${anchorDateId}T00:00:00.000Z`)
  if (Number.isNaN(anchor.getTime()))
    return []

  const dateIds: string[] = []
  for (let offset = Math.max(0, Math.floor(lookbackDays)); offset >= 0; offset--) {
    const date = new Date(anchor)
    date.setUTCDate(anchor.getUTCDate() - offset)
    dateIds.push(getDateId(date))
  }
  return dateIds
}

function getMetricWindowFromDailyWindow(window: DailyWindow): CurrentDayWindow {
  return {
    dayStart: window.prevDayStart,
    nextDayStart: window.prevDayEnd,
    dayDateId: window.prevDayDateId,
  }
}

async function reserveGlobalStatsRetry(c: Context, retryCount: number, dateId?: string): Promise<number | null> {
  if (retryCount >= GLOBAL_STATS_BACKGROUND_MAX_RETRIES)
    return null

  const nextRetryCount = retryCount + 1
  const delaySeconds = GLOBAL_STATS_RETRY_DELAY_SECONDS * nextRetryCount
  const retryMessage = buildGlobalStatsRetryMessage(nextRetryCount, dateId)
  const db = getPgClient(c)

  try {
    const retryMsgId = await queueGlobalStatsMessage(db, retryMessage, delaySeconds)
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Reserved global stats dispatcher retry',
      retryCount: nextRetryCount,
      delaySeconds,
      retryMsgId,
      dateId,
    })
    return retryMsgId
  }
  finally {
    await closeClient(c, db)
  }
}

async function reserveGlobalStatsShardRetry(c: Context, shard: GlobalStatsShard, dateId: string, retryCount: number): Promise<number | null> {
  if (retryCount >= GLOBAL_STATS_BACKGROUND_MAX_RETRIES)
    return null

  const nextRetryCount = retryCount + 1
  const delaySeconds = GLOBAL_STATS_RETRY_DELAY_SECONDS * nextRetryCount
  const retryMessage = buildGlobalStatsShardMessage(shard, dateId, nextRetryCount)
  const db = getPgClient(c)

  try {
    const retryMsgId = await queueGlobalStatsMessage(db, retryMessage, delaySeconds)
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Reserved global stats shard retry',
      shard,
      retryCount: nextRetryCount,
      delaySeconds,
      retryMsgId,
      dateId,
    })
    return retryMsgId
  }
  finally {
    await closeClient(c, db)
  }
}

async function cancelGlobalStatsRetry(c: Context, retryMsgId: number): Promise<void> {
  const db = getPgClient(c)

  try {
    await db.query('SELECT pgmq.delete($1, $2::bigint[])', [
      GLOBAL_STATS_QUEUE_NAME,
      [retryMsgId],
    ])
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Cancelled reserved global stats dispatcher retry',
      retryMsgId,
    })
  }
  catch (cancelError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to cancel reserved global stats dispatcher retry',
      retryMsgId,
      error: cancelError,
    })
    throw cancelError
  }
  finally {
    await closeClient(c, db)
  }
}

function getPaidPlanTotal(plans: PlanTotal) {
  return (plans.Solo ?? 0) + (plans.Maker ?? 0) + (plans.Team ?? 0) + (plans.Enterprise ?? 0)
}

function getPlanConversionRates(plans: PlanTotal, payingCount: number): PlanConversionRates {
  // Plan mix among paying orgs (not all orgs/users). Matches the daily admin snapshot.
  return {
    solo: calculateConversionRate(plans.Solo, payingCount),
    maker: calculateConversionRate(plans.Maker, payingCount),
    team: calculateConversionRate(plans.Team, payingCount),
    enterprise: calculateConversionRate(plans.Enterprise, payingCount),
    total: calculateConversionRate(getPaidPlanTotal(plans), payingCount),
  }
}

function getDailyWindow(referenceDate = new Date()): DailyWindow {
  const todayStartMillis = Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate())
  const prevDayStart = new Date(todayStartMillis - 24 * 60 * 60 * 1000)
  const prevDayEnd = new Date(todayStartMillis)
  return {
    prevDayStart,
    prevDayEnd,
    prevDayDateId: getDateId(prevDayStart),
  }
}

function getCurrentDayWindow(referenceDate = new Date()): CurrentDayWindow {
  const dayStartMillis = Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate())
  const dayStart = new Date(dayStartMillis)
  const nextDayStart = new Date(dayStartMillis + 24 * 60 * 60 * 1000)
  return {
    dayStart,
    nextDayStart,
    dayDateId: getDateId(dayStart),
  }
}

function getCompletedDayWindow(referenceDate = new Date()): CurrentDayWindow {
  const { prevDayStart, prevDayEnd, prevDayDateId } = getDailyWindow(referenceDate)
  return {
    dayStart: prevDayStart,
    nextDayStart: prevDayEnd,
    dayDateId: prevDayDateId,
  }
}

function countUniqueCustomers(...rowSets: Array<Array<CustomerIdRow | null | undefined>>) {
  return new Set(
    rowSets
      .flat()
      .filter((row): row is CustomerIdRow => Boolean(row?.customer_id))
      .map(row => row.customer_id),
  ).size
}

function getPreviousDateId(dateId: string) {
  const target = new Date(`${dateId}T00:00:00.000Z`)
  target.setUTCDate(target.getUTCDate() - 1)
  return getDateId(target)
}

function calculateNrr(previousMrr: number, dailyChanges: DailyRevenueChangeSummary) {
  if (previousMrr <= 0)
    return 100

  const retainedMrr = Math.max(
    previousMrr - dailyChanges.churnMrr - dailyChanges.contractionMrr + dailyChanges.expansionMrr,
    0,
  )

  return Number(((retainedMrr / previousMrr) * 100).toFixed(2))
}

function calculateChurnRevenue(dailyChanges: DailyRevenueChangeSummary) {
  return Number((dailyChanges.churnMrr + dailyChanges.contractionMrr).toFixed(2))
}

function calculateAveragePastDueDays(rows: PastDueOrgRow[], snapshotAt: Date) {
  const startTimeByCustomer = getPastDueStartTimesByCustomer(rows, snapshotAt)
  const snapshotTime = snapshotAt.getTime()

  const durations = Array.from(startTimeByCustomer.values())
    .map(startTime => (snapshotTime - startTime) / (24 * 60 * 60 * 1000))

  if (durations.length === 0)
    return 0

  const totalDays = durations.reduce((sum, days) => sum + days, 0)
  return Number((totalDays / durations.length).toFixed(1))
}

function getPastDueStartTimesByCustomer(rows: PastDueOrgRow[], snapshotAt: Date) {
  const snapshotTime = snapshotAt.getTime()
  const startTimeByCustomer = new Map<string, number>()

  for (const row of rows) {
    if (!row.customer_id)
      continue

    const startDate = row.past_due_at ?? row.updated_at
    if (!startDate)
      continue

    const startTime = new Date(startDate).getTime()
    if (!Number.isFinite(startTime) || startTime > snapshotTime)
      continue

    const previousStartTime = startTimeByCustomer.get(row.customer_id)
    if (previousStartTime === undefined || startTime < previousStartTime)
      startTimeByCustomer.set(row.customer_id, startTime)
  }

  return startTimeByCustomer
}

function calculatePastDueOrgStats(rows: PastDueOrgRow[], snapshotAt: Date): PastDueOrgStats {
  const startTimeByCustomer = getPastDueStartTimesByCustomer(rows, snapshotAt)
  return {
    past_due_orgs: startTimeByCustomer.size,
    past_due_orgs_average_days: calculateAveragePastDueDays(rows, snapshotAt),
  }
}

function getEmptySubscriptionAccessSnapshotCounts(): SubscriptionAccessSnapshotCounts {
  return {
    active_canceled_orgs: 0,
    active_past_due_orgs: 0,
  }
}

function normalizeSubscriptionAccessSnapshotCounts(
  row: SubscriptionAccessSnapshotSqlRow | null | undefined,
): SubscriptionAccessSnapshotCounts {
  return {
    active_canceled_orgs: Number(row?.active_canceled_orgs) || 0,
    active_past_due_orgs: Number(row?.active_past_due_orgs) || 0,
  }
}

function isActiveCanceledAtSnapshot(row: SubscriptionAccessRow, snapshotExclusiveEnd: Date): boolean {
  if (!row.customer_id || row.is_good_plan !== true)
    return false

  if (!row.paid_at || new Date(row.paid_at).getTime() >= snapshotExclusiveEnd.getTime())
    return false

  if (!row.canceled_at || new Date(row.canceled_at).getTime() >= snapshotExclusiveEnd.getTime())
    return false

  if (!row.subscription_anchor_end || new Date(row.subscription_anchor_end).getTime() <= snapshotExclusiveEnd.getTime())
    return false

  if (row.created_at && new Date(row.created_at).getTime() >= snapshotExclusiveEnd.getTime())
    return false

  return true
}

function isActivePastDueAtSnapshot(row: SubscriptionAccessRow, snapshotExclusiveEnd: Date): boolean {
  if (!row.customer_id || row.is_good_plan !== true)
    return false

  if (!row.paid_at || new Date(row.paid_at).getTime() >= snapshotExclusiveEnd.getTime())
    return false

  if (!row.past_due_at || new Date(row.past_due_at).getTime() >= snapshotExclusiveEnd.getTime())
    return false

  if (!row.subscription_anchor_end || new Date(row.subscription_anchor_end).getTime() <= snapshotExclusiveEnd.getTime())
    return false

  if (row.canceled_at && new Date(row.canceled_at).getTime() < snapshotExclusiveEnd.getTime())
    return false

  if (row.status !== 'succeeded')
    return false

  if (row.created_at && new Date(row.created_at).getTime() >= snapshotExclusiveEnd.getTime())
    return false

  return true
}

function calculateSubscriptionAccessSnapshotCounts(
  rows: SubscriptionAccessRow[],
  snapshotExclusiveEnd: Date,
): SubscriptionAccessSnapshotCounts {
  const activeCanceled = new Set<string>()
  const activePastDue = new Set<string>()

  for (const row of rows) {
    if (isActiveCanceledAtSnapshot(row, snapshotExclusiveEnd))
      activeCanceled.add(row.customer_id)
    if (isActivePastDueAtSnapshot(row, snapshotExclusiveEnd))
      activePastDue.add(row.customer_id)
  }

  return {
    active_canceled_orgs: activeCanceled.size,
    active_past_due_orgs: activePastDue.size,
  }
}

type MutableSubscriptionHealthSnapshot = Pick<
  GlobalStatsSnapshotRow,
  'past_due_orgs' | 'past_due_orgs_average_days' | 'active_canceled_orgs' | 'active_past_due_orgs'
>

function hasPersistedPastDueStats(snapshot: MutableSubscriptionHealthSnapshot | null | undefined): boolean {
  return (Number(snapshot?.past_due_orgs) || 0) > 0
    || (Number(snapshot?.past_due_orgs_average_days) || 0) > 0
    || (Number(snapshot?.active_canceled_orgs) || 0) > 0
    || (Number(snapshot?.active_past_due_orgs) || 0) > 0
}

function shouldRefreshMutablePastDueStats(
  window: DailyWindow,
  referenceDate = new Date(),
  snapshot?: MutableSubscriptionHealthSnapshot | null,
) {
  if (window.prevDayDateId === getDailyWindow(referenceDate).prevDayDateId)
    return true

  if (snapshot === undefined)
    return false

  return !hasPersistedPastDueStats(snapshot)
}

function isMissingSchemaColumnError(error: unknown, columnHints: string[]): boolean {
  const errorCode = String((error as any)?.code ?? '').toUpperCase()
  const message = String((error as any)?.message ?? '').toLowerCase()
  return errorCode === 'PGRST204'
    || errorCode === '42703'
    || columnHints.some(hint => message.includes(hint.toLowerCase()))
}

function isMissingBuildMetricColumnError(error: unknown): boolean {
  return isMissingSchemaColumnError(error, [
    'build_total_seconds_day',
    'build_avg_seconds_day',
    'build_count_day',
  ])
}

function isMissingAppsWithPreviewColumnError(error: unknown): boolean {
  return isMissingSchemaColumnError(error, ['apps_with_preview'])
}

async function calculateRevenue(c: Context, referenceDate?: Date): Promise<PlanRevenue> {
  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)

  try {
    // Load rows via SQL (no PostgREST ~1000-row truncation), then classify with the
    // shared JS helpers so unit tests exercise the same billing/MRR rules as prod.
    const snapshotExclusiveEnd = referenceDate ?? new Date()
    const snapshotExclusiveEndIso = snapshotExclusiveEnd.toISOString()
    const result = await drizzleClient.execute<{
      plan_key: string | null
      price_id: string | null
      price_m_id: string | null
      price_y_id: string | null
      price_m: number | string | null
      price_y: number | string | null
      subscription_anchor_start: string | Date | null
      subscription_anchor_end: string | Date | null
    }>(sql`
      SELECT
        lower(p.name) AS plan_key,
        si.price_id,
        p.price_m_id,
        p.price_y_id,
        p.price_m,
        p.price_y,
        si.subscription_anchor_start,
        si.subscription_anchor_end
      FROM public.stripe_info si
      INNER JOIN public.plans p ON p.stripe_id = si.product_id
      WHERE si.is_good_plan = true
        AND p.name IN ('Solo', 'Maker', 'Team', 'Enterprise')
        AND si.paid_at IS NOT NULL
        AND si.paid_at < ${snapshotExclusiveEndIso}::timestamptz
        AND si.trial_at <= ${snapshotExclusiveEndIso}::timestamptz
        AND (
          ${referenceDate ? sql`
            si.created_at < ${snapshotExclusiveEndIso}::timestamptz
            AND si.status IN (
              'succeeded'::public.stripe_status,
              'canceled'::public.stripe_status,
              'deleted'::public.stripe_status
            )
            AND (si.canceled_at IS NULL OR si.canceled_at >= ${snapshotExclusiveEndIso}::timestamptz)
            AND si.subscription_anchor_end > ${snapshotExclusiveEndIso}::timestamptz
          ` : sql`
            si.status = 'succeeded'::public.stripe_status
          `}
        )
    `)

    const revenue = getEmptyPlanRevenue()
    for (const row of result.rows) {
      const planKey = String(row.plan_key || '')
      if (!planKey)
        continue

      const billing = resolvePlanBillingInterval({
        priceId: row.price_id,
        priceMId: row.price_m_id,
        priceYId: row.price_y_id,
        anchorStart: row.subscription_anchor_start,
        anchorEnd: row.subscription_anchor_end,
      })
      const mrr = resolvePlanMrrDollars({
        billing,
        priceId: row.price_id,
        priceMId: row.price_m_id,
        priceYId: row.price_y_id,
        priceM: Number(row.price_m) || 0,
        priceY: Number(row.price_y) || 0,
      })
      applySubscriptionRevenue(revenue, planKey, billing, mrr)
    }

    revenue.mrr = roundRevenueMoney(revenue.mrr)
    revenue.total_revenue = roundRevenueMoney(revenue.mrr * 12)
    revenue.revenue_solo = roundRevenueMoney(revenue.revenue_solo)
    revenue.revenue_maker = roundRevenueMoney(revenue.revenue_maker)
    revenue.revenue_team = roundRevenueMoney(revenue.revenue_team)
    revenue.revenue_enterprise = roundRevenueMoney(revenue.revenue_enterprise)

    cloudlog({
      requestId: c.get('requestId'),
      message: 'Revenue calculation',
      referenceDate: referenceDate ? snapshotExclusiveEndIso : null,
      mrr: revenue.mrr,
      total_revenue: revenue.total_revenue,
      solo: { monthly: revenue.plan_solo_monthly, yearly: revenue.plan_solo_yearly, arr: revenue.revenue_solo },
      maker: { monthly: revenue.plan_maker_monthly, yearly: revenue.plan_maker_yearly, arr: revenue.revenue_maker },
      team: { monthly: revenue.plan_team_monthly, yearly: revenue.plan_team_yearly, arr: revenue.revenue_team },
      enterprise: { monthly: revenue.plan_enterprise_monthly, yearly: revenue.plan_enterprise_yearly, arr: revenue.revenue_enterprise },
    })

    return revenue
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'calculateRevenue error', error: e })
    return getEmptyPlanRevenue()
  }
  finally {
    closeClient(c, pgClient)
  }
}

async function getGithubStars(): Promise<number> {
  try {
    const response = await fetch('https://api.github.com/repos/Cap-go/capacitor-updater', {
      headers: {
        'User-Agent': 'capgo-app', // GitHub API rate limit
      },
    })

    if (!response.ok) {
      throw new Error(`GitHub API error: HTTP ${response.status}`)
    }

    const json = await response.json() as { stargazers_count: number }
    return json.stargazers_count
  }
  catch (e) {
    throw new Error(`getGithubStars error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function getBuildStats(c: Context, window?: DailyWindow): Promise<BuildStats> {
  const supabase = supabaseAdmin(c)
  const { prevDayStart, prevDayEnd } = window ?? getDailyWindow()
  const last30daysStart = new Date(prevDayEnd.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const last30daysEnd = prevDayEnd.toISOString()

  try {
    // Run all count queries in parallel for better performance
    const [
      totalResult,
      iosResult,
      androidResult,
      lastMonthTotalResult,
      lastMonthIosResult,
      lastMonthAndroidResult,
      successTotalResult,
      successIosResult,
      successAndroidResult,
      dailyBuildStats,
    ] = await Promise.all([
      // Count total builds up to the snapshot end
      supabase.from('build_logs').select('*', { count: 'exact', head: true }).lt('created_at', last30daysEnd),
      // Count iOS builds up to the snapshot end
      supabase.from('build_logs').select('*', { count: 'exact', head: true }).eq('platform', 'ios').lt('created_at', last30daysEnd),
      // Count Android builds up to the snapshot end
      supabase.from('build_logs').select('*', { count: 'exact', head: true }).eq('platform', 'android').lt('created_at', last30daysEnd),
      // Count total builds (last 30 days)
      supabase.from('build_logs').select('*', { count: 'exact', head: true }).gte('created_at', last30daysStart).lt('created_at', last30daysEnd),
      // Count iOS builds (last 30 days)
      supabase.from('build_logs').select('*', { count: 'exact', head: true }).eq('platform', 'ios').gte('created_at', last30daysStart).lt('created_at', last30daysEnd),
      // Count Android builds (last 30 days)
      supabase.from('build_logs').select('*', { count: 'exact', head: true }).eq('platform', 'android').gte('created_at', last30daysStart).lt('created_at', last30daysEnd),
      // Count successful builds up to the snapshot end
      supabase.from('build_requests').select('*', { count: 'exact', head: true }).eq('status', 'succeeded').lt('created_at', last30daysEnd),
      // Count successful iOS builds up to the snapshot end
      supabase.from('build_requests').select('*', { count: 'exact', head: true }).eq('platform', 'ios').eq('status', 'succeeded').lt('created_at', last30daysEnd),
      // Count successful Android builds up to the snapshot end
      supabase.from('build_requests').select('*', { count: 'exact', head: true }).eq('platform', 'android').eq('status', 'succeeded').lt('created_at', last30daysEnd),
      aggregateDailyBuildStats(c, prevDayStart, prevDayEnd),
    ])

    // Log any errors
    if (totalResult.error)
      cloudlogErr({ requestId: c.get('requestId'), message: 'getBuildStats total error', error: totalResult.error })
    if (iosResult.error)
      cloudlogErr({ requestId: c.get('requestId'), message: 'getBuildStats iOS error', error: iosResult.error })
    if (androidResult.error)
      cloudlogErr({ requestId: c.get('requestId'), message: 'getBuildStats Android error', error: androidResult.error })
    if (lastMonthTotalResult.error)
      cloudlogErr({ requestId: c.get('requestId'), message: 'getBuildStats lastMonthTotal error', error: lastMonthTotalResult.error })
    if (lastMonthIosResult.error)
      cloudlogErr({ requestId: c.get('requestId'), message: 'getBuildStats lastMonthIos error', error: lastMonthIosResult.error })
    if (lastMonthAndroidResult.error)
      cloudlogErr({ requestId: c.get('requestId'), message: 'getBuildStats lastMonthAndroid error', error: lastMonthAndroidResult.error })
    if (successTotalResult.error)
      cloudlogErr({ requestId: c.get('requestId'), message: 'getBuildStats successTotal error', error: successTotalResult.error })
    if (successIosResult.error)
      cloudlogErr({ requestId: c.get('requestId'), message: 'getBuildStats successIos error', error: successIosResult.error })
    if (successAndroidResult.error)
      cloudlogErr({ requestId: c.get('requestId'), message: 'getBuildStats successAndroid error', error: successAndroidResult.error })

    return {
      total: totalResult.count ?? 0,
      ios: iosResult.count ?? 0,
      android: androidResult.count ?? 0,
      last_month: lastMonthTotalResult.count ?? 0,
      last_month_ios: lastMonthIosResult.count ?? 0,
      last_month_android: lastMonthAndroidResult.count ?? 0,
      success_total: successTotalResult.count ?? 0,
      success_ios: successIosResult.count ?? 0,
      success_android: successAndroidResult.count ?? 0,
      total_seconds_day_ios: dailyBuildStats?.totalSeconds.ios ?? 0,
      total_seconds_day_android: dailyBuildStats?.totalSeconds.android ?? 0,
      avg_seconds_day_ios: dailyBuildStats?.avgSeconds.ios ?? 0,
      avg_seconds_day_android: dailyBuildStats?.avgSeconds.android ?? 0,
      build_count_day_ios: dailyBuildStats?.counts.ios ?? 0,
      build_count_day_android: dailyBuildStats?.counts.android ?? 0,
      daily_metrics_available: dailyBuildStats !== null,
    }
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getBuildStats error', error: e })
    return {
      total: 0,
      ios: 0,
      android: 0,
      last_month: 0,
      last_month_ios: 0,
      last_month_android: 0,
      success_total: 0,
      success_ios: 0,
      success_android: 0,
      total_seconds_day_ios: 0,
      total_seconds_day_android: 0,
      avg_seconds_day_ios: 0,
      avg_seconds_day_android: 0,
      build_count_day_ios: 0,
      build_count_day_android: 0,
      daily_metrics_available: false,
    }
  }
}

async function getPaidProductActivityStats(c: Context, window: CurrentDayWindow): Promise<PaidProductActivityStats> {
  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)
  const dayStart = window.dayStart
  const nextDayStart = window.nextDayStart
  const snapshotEndIso = nextDayStart.toISOString()
  const lookbackStart = new Date(dayStart.getTime() - 59 * 24 * 60 * 60 * 1000)
  const dayDateId = getDateId(dayStart)
  const lookbackDateId = getDateId(lookbackStart)

  try {
    const result = await drizzleClient.execute(sql`
      WITH paying_orgs AS (
        SELECT DISTINCT
          o.id AS org_id,
          o.customer_id
        FROM public.orgs o
        INNER JOIN public.stripe_info si ON si.customer_id = o.customer_id
        WHERE o.customer_id IS NOT NULL
          AND si.is_good_plan = true
          AND COALESCE(si.paid_at, si.subscription_anchor_start, si.created_at, o.created_at) < ${snapshotEndIso}::timestamptz
          AND si.status IN (
            'succeeded'::public.stripe_status,
            'canceled'::public.stripe_status,
            'deleted'::public.stripe_status
          )
          AND (si.canceled_at IS NULL OR si.canceled_at >= ${snapshotEndIso}::timestamptz)
          AND si.subscription_anchor_end > ${snapshotEndIso}::timestamptz
      ),
      builder_clients AS (
        SELECT DISTINCT po.customer_id
        FROM paying_orgs po
        INNER JOIN public.apps a ON a.owner_org = po.org_id
        INNER JOIN public.daily_build_time dbt ON dbt.app_id = a.app_id
        WHERE dbt.date >= ${lookbackDateId}::date
          AND dbt.date <= ${dayDateId}::date
          AND dbt.build_count > 0
      ),
      live_updates_clients AS (
        SELECT DISTINCT po.customer_id
        FROM paying_orgs po
        INNER JOIN public.apps a ON a.owner_org = po.org_id
        INNER JOIN public.daily_version dv ON dv.app_id = a.app_id
        WHERE dv.date >= ${lookbackDateId}::date
          AND dv.date <= ${dayDateId}::date
          AND (
            COALESCE(dv.get, 0) > 0
            OR COALESCE(dv.install, 0) > 0
            OR COALESCE(dv.fail, 0) > 0
            OR COALESCE(dv.uninstall, 0) > 0
          )
      )
      SELECT
        (SELECT COUNT(*) FROM builder_clients)::int AS builder_active_paying_clients_60d,
        (SELECT COUNT(*) FROM live_updates_clients)::int AS live_updates_active_paying_clients_60d
    `)

    const row = result.rows[0] as Partial<PaidProductActivityStats> | undefined
    return {
      builder_active_paying_clients_60d: Number(row?.builder_active_paying_clients_60d) || 0,
      live_updates_active_paying_clients_60d: Number(row?.live_updates_active_paying_clients_60d) || 0,
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getPaidProductActivityStats error', error })
    return {
      builder_active_paying_clients_60d: 0,
      live_updates_active_paying_clients_60d: 0,
    }
  }
  finally {
    closeClient(c, pgClient)
  }
}

async function getLtvStats(c: Context, window: CurrentDayWindow): Promise<LtvStats> {
  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)
  const snapshotExclusiveEnd = window.nextDayStart.toISOString()
  const monthSeconds = (365.2425 / 12) * 24 * 60 * 60

  try {
    const result = await drizzleClient.execute(sql`
      WITH source AS (
        SELECT
          CASE
            WHEN si.price_id = p.price_y_id THEN p.price_y::double precision
            WHEN si.price_id = p.price_m_id THEN p.price_m::double precision
            ELSE 0::double precision
          END AS amount,
          CASE
            WHEN si.price_id = p.price_y_id THEN 12::double precision
            WHEN si.price_id = p.price_m_id THEN 1::double precision
            ELSE NULL::double precision
          END AS period_months,
          si.paid_at AS paid_start,
          COALESCE(
            si.canceled_at,
            CASE
              WHEN si.status IN ('canceled', 'deleted') THEN si.subscription_anchor_end
              ELSE NULL
            END
          ) AS known_end
        FROM public.stripe_info si
        INNER JOIN public.plans p ON p.stripe_id = si.product_id
        WHERE si.is_good_plan = true
          AND si.paid_at IS NOT NULL
      ),
      ltv_values AS (
        SELECT
          amount
            * GREATEST(
              1::double precision,
              CEIL(
                (
                  EXTRACT(EPOCH FROM (
                    LEAST(COALESCE(known_end, ${snapshotExclusiveEnd}::timestamptz), ${snapshotExclusiveEnd}::timestamptz)
                    - paid_start
                  ))
                  / (${monthSeconds}::double precision * period_months)
                ) - 0.000000001
              )
            ) AS ltv
        FROM source
        WHERE amount > 0
          AND period_months IS NOT NULL
          AND paid_start < ${snapshotExclusiveEnd}::timestamptz
          AND LEAST(COALESCE(known_end, ${snapshotExclusiveEnd}::timestamptz), ${snapshotExclusiveEnd}::timestamptz) > paid_start
      )
      SELECT
        COALESCE(ROUND(AVG(ltv)::numeric, 2), 0)::double precision AS average_ltv,
        COALESCE(ROUND(MIN(ltv)::numeric, 2), 0)::double precision AS shortest_ltv,
        COALESCE(ROUND(MAX(ltv)::numeric, 2), 0)::double precision AS longest_ltv
      FROM ltv_values
    `)

    const row = result.rows[0] as Partial<LtvStats> | undefined
    return {
      average_ltv: Number(row?.average_ltv) || 0,
      shortest_ltv: Number(row?.shortest_ltv) || 0,
      longest_ltv: Number(row?.longest_ltv) || 0,
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'ltv stats error', error })
    return {
      average_ltv: 0,
      shortest_ltv: 0,
      longest_ltv: 0,
    }
  }
  finally {
    closeClient(c, pgClient)
  }
}

async function getRevenueRetentionMetrics(c: Context, dateId: string): Promise<RevenueRetentionMetrics> {
  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)
  const previousDateId = getPreviousDateId(dateId)

  try {
    const result = await drizzleClient.execute<{
      retained_churn_mrr: number
      retained_contraction_mrr: number
      retained_expansion_mrr: number
      total_churn_mrr: number
      total_contraction_mrr: number
      churn_revenue_solo: number
      churn_revenue_maker: number
      churn_revenue_team: number
      churn_revenue_enterprise: number
      previous_mrr: number
    }>(sql`
      WITH daily AS (
        SELECT
          COALESCE(SUM(CASE WHEN opening_mrr > 0 THEN churn_mrr ELSE 0 END), 0)::float AS retained_churn_mrr,
          COALESCE(SUM(CASE WHEN opening_mrr > 0 THEN contraction_mrr ELSE 0 END), 0)::float AS retained_contraction_mrr,
          COALESCE(SUM(CASE WHEN opening_mrr > 0 THEN expansion_mrr ELSE 0 END), 0)::float AS retained_expansion_mrr,
          COALESCE(SUM(churn_mrr), 0)::float AS total_churn_mrr,
          COALESCE(SUM(contraction_mrr), 0)::float AS total_contraction_mrr,
          COALESCE(SUM(
            COALESCE(NULLIF(to_jsonb(drm) ->> 'churn_mrr_solo', '')::float, 0)
            + COALESCE(NULLIF(to_jsonb(drm) ->> 'contraction_mrr_solo', '')::float, 0)
          ), 0)::float AS churn_revenue_solo,
          COALESCE(SUM(
            COALESCE(NULLIF(to_jsonb(drm) ->> 'churn_mrr_maker', '')::float, 0)
            + COALESCE(NULLIF(to_jsonb(drm) ->> 'contraction_mrr_maker', '')::float, 0)
          ), 0)::float AS churn_revenue_maker,
          COALESCE(SUM(
            COALESCE(NULLIF(to_jsonb(drm) ->> 'churn_mrr_team', '')::float, 0)
            + COALESCE(NULLIF(to_jsonb(drm) ->> 'contraction_mrr_team', '')::float, 0)
          ), 0)::float AS churn_revenue_team,
          COALESCE(SUM(
            COALESCE(NULLIF(to_jsonb(drm) ->> 'churn_mrr_enterprise', '')::float, 0)
            + COALESCE(NULLIF(to_jsonb(drm) ->> 'contraction_mrr_enterprise', '')::float, 0)
          ), 0)::float AS churn_revenue_enterprise
        FROM public.daily_revenue_metrics drm
        WHERE date_id = ${dateId}
      ),
      previous_snapshot AS (
        SELECT COALESCE(mrr, 0)::float AS previous_mrr
        FROM public.global_stats
        WHERE date_id = ${previousDateId}
        LIMIT 1
      )
      SELECT
        daily.retained_churn_mrr,
        daily.retained_contraction_mrr,
        daily.retained_expansion_mrr,
        daily.total_churn_mrr,
        daily.total_contraction_mrr,
        daily.churn_revenue_solo,
        daily.churn_revenue_maker,
        daily.churn_revenue_team,
        daily.churn_revenue_enterprise,
        COALESCE(previous_snapshot.previous_mrr, 0)::float AS previous_mrr
      FROM daily
      LEFT JOIN previous_snapshot ON true
    `)

    const row = result.rows[0]
    const retainedChanges = {
      churnMrr: Number(row?.retained_churn_mrr) || 0,
      contractionMrr: Number(row?.retained_contraction_mrr) || 0,
      expansionMrr: Number(row?.retained_expansion_mrr) || 0,
    }
    const totalLostRevenue = {
      churnMrr: Number(row?.total_churn_mrr) || 0,
      contractionMrr: Number(row?.total_contraction_mrr) || 0,
      expansionMrr: 0,
    }
    const previousMrr = Number(row?.previous_mrr) || 0

    return {
      churnRevenue: calculateChurnRevenue(totalLostRevenue),
      churnRevenueSolo: Number((Number(row?.churn_revenue_solo) || 0).toFixed(2)),
      churnRevenueMaker: Number((Number(row?.churn_revenue_maker) || 0).toFixed(2)),
      churnRevenueTeam: Number((Number(row?.churn_revenue_team) || 0).toFixed(2)),
      churnRevenueEnterprise: Number((Number(row?.churn_revenue_enterprise) || 0).toFixed(2)),
      nrr: calculateNrr(previousMrr, retainedChanges),
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getRevenueRetentionMetrics error', error })
    throw error
  }
  finally {
    closeClient(c, pgClient)
  }
}

async function aggregateDailyBuildStats(
  c: Context,
  start: Date,
  end: Date,
): Promise<{
  totalSeconds: Record<'ios' | 'android', number>
  avgSeconds: Record<'ios' | 'android', number>
  counts: Record<'ios' | 'android', number>
} | null> {
  // Read from primary so the daily rollup is not permanently undercounted by replica lag.
  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)
  const totalSecondsByPlatform: Record<'ios' | 'android', number> = { ios: 0, android: 0 }
  const avgSecondsByPlatform: Record<'ios' | 'android', number> = { ios: 0, android: 0 }
  const countsByPlatform: Record<'ios' | 'android', number> = { ios: 0, android: 0 }

  try {
    const query = sql`
      SELECT
        platform,
        SUM(billable_seconds)::bigint AS total_seconds,
        COALESCE(ROUND(AVG(billable_seconds)::numeric, 1), 0)::float AS avg_seconds,
        COUNT(*)::int AS total_builds
      FROM build_logs
      WHERE created_at >= ${start}
        AND created_at < ${end}
        AND platform IN ('ios', 'android')
      GROUP BY platform
    `
    const result = await drizzleClient.execute<{ platform: string, total_seconds: number, avg_seconds: number, total_builds: number }>(query)
    for (const row of result.rows ?? []) {
      if (row.platform === 'ios' || row.platform === 'android') {
        totalSecondsByPlatform[row.platform] = Number(row.total_seconds) || 0
        avgSecondsByPlatform[row.platform] = Number(row.avg_seconds) || 0
        countsByPlatform[row.platform] = Number(row.total_builds) || 0
      }
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'aggregateDailyBuildStats error', error })
    return null
  }
  finally {
    closeClient(c, pgClient)
  }

  return { totalSeconds: totalSecondsByPlatform, avgSeconds: avgSecondsByPlatform, counts: countsByPlatform }
}

function getCompletedAppBuildOnboardingWindow(window: DailyWindow): DailyWindow {
  const prevDayStart = new Date(window.prevDayStart.getTime() - DAY_IN_MS)
  const prevDayEnd = new Date(window.prevDayStart)
  return {
    prevDayStart,
    prevDayEnd,
    prevDayDateId: getDateId(prevDayStart),
  }
}

async function getAppBuildOnboardingMetrics(c: Context, window: DailyWindow): Promise<AppBuildOnboardingMetrics> {
  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)
  const dayStartIso = window.prevDayStart.toISOString()
  const dayEndIso = window.prevDayEnd.toISOString()

  try {
    const result = await drizzleClient.execute<AppBuildOnboardingMetricRow>(sql`
      WITH created_apps AS (
        SELECT app_id, created_at, created_from_onboarding, onboarding_completed_at
        FROM public.apps
        WHERE created_at >= ${dayStartIso}::timestamptz
          AND created_at < ${dayEndIso}::timestamptz
      )
      SELECT
        ca.created_at,
        ca.created_from_onboarding,
        ca.onboarding_completed_at,
        COUNT(br.id)::int AS build_count
      FROM created_apps ca
      LEFT JOIN public.build_requests br
        ON br.app_id = ca.app_id
        AND br.created_at >= ca.created_at
        AND br.created_at < ca.created_at + INTERVAL '24 hours'
        AND br.status = 'succeeded'
      GROUP BY ca.app_id, ca.created_at, ca.created_from_onboarding, ca.onboarding_completed_at
    `)

    return summarizeAppBuildOnboardingRows(result.rows)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getAppBuildOnboardingMetrics error', dateId: window.prevDayDateId, error })
    return {
      apps_created: 0,
      apps_with_cli_onboarding_builds_24h: 0,
      apps_with_manual_builds_24h: 0,
    }
  }
  finally {
    closeClient(c, pgClient)
  }
}

async function countDemoSeededApps(c: Context, createdAfterIso: string, createdBeforeIso: string): Promise<number> {
  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)

  try {
    const result = await drizzleClient.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM public.apps AS apps
      WHERE apps.created_at >= ${new Date(createdAfterIso)}
        AND apps.created_at < ${new Date(createdBeforeIso)}
        AND EXISTS (
          SELECT 1
          FROM public.app_versions AS app_versions
          INNER JOIN public.manifest AS manifest
            ON manifest.app_version_id = app_versions.id
          WHERE app_versions.app_id = apps.app_id
            AND app_versions.owner_org = apps.owner_org
            AND manifest.s3_path LIKE ('demo/' || apps.app_id || '/%')
        )
    `)

    return Number(result.rows[0]?.count) || 0
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'countDemoSeededApps error', error })
    return 0
  }
  finally {
    closeClient(c, pgClient)
  }
}

async function countAppsWithPreview(c: Context, snapshotEnd: Date): Promise<number> {
  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)

  try {
    const result = await drizzleClient.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM public.apps AS apps
      WHERE apps.allow_preview = true
        AND apps.created_at < ${snapshotEnd}
    `)

    return Number(result.rows[0]?.count) || 0
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'countAppsWithPreview error', error })
    return 0
  }
  finally {
    closeClient(c, pgClient)
  }
}

async function getTrialExtensionStats(c: Context, window: CurrentDayWindow): Promise<TrialExtensionStats> {
  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)
  const dayStartIso = window.dayStart.toISOString()
  const nextDayStartIso = window.nextDayStart.toISOString()

  try {
    const result = await drizzleClient.execute<TrialExtensionStats>(sql`
      WITH extension_events AS (
        SELECT DISTINCT tee.org_id
        FROM public.trial_extension_events tee
        WHERE tee.created_at >= ${dayStartIso}::timestamptz
          AND tee.created_at < ${nextDayStartIso}::timestamptz
      ),
      subscribed_extended AS (
        SELECT DISTINCT o.id AS org_id
        FROM public.orgs o
        INNER JOIN public.stripe_info si ON si.customer_id = o.customer_id
        WHERE si.paid_at IS NOT NULL
          AND si.paid_at >= ${dayStartIso}::timestamptz
          AND si.paid_at < ${nextDayStartIso}::timestamptz
          AND EXISTS (
            SELECT 1
            FROM public.trial_extension_events tee
            WHERE tee.org_id = o.id
              AND tee.created_at <= si.paid_at
          )
      )
      SELECT
        (SELECT COUNT(*) FROM extension_events)::int AS trial_extended_orgs,
        (SELECT COUNT(*) FROM subscribed_extended)::int AS trial_extended_subscribed_orgs
    `)

    const row = result.rows[0]
    return {
      trial_extended_orgs: Number(row?.trial_extended_orgs) || 0,
      trial_extended_subscribed_orgs: Number(row?.trial_extended_subscribed_orgs) || 0,
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'trial extension stats unavailable', error })
    return {
      trial_extended_orgs: 0,
      trial_extended_subscribed_orgs: 0,
    }
  }
  finally {
    closeClient(c, pgClient)
  }
}

async function ensureGlobalStatsSnapshotRow(c: Context, dateId: string): Promise<void> {
  await ensureGlobalStatsSnapshotRows(c, [dateId])
}

async function ensureGlobalStatsSnapshotRows(c: Context, dateIds: readonly string[]): Promise<void> {
  if (dateIds.length === 0)
    return

  const db = getPgClient(c)

  try {
    await db.query(
      `INSERT INTO public.global_stats (date_id, apps, updates, stars)
      SELECT DISTINCT date_id, 0, 0, 0
      FROM unnest($1::text[]) AS input(date_id)
      ON CONFLICT (date_id) DO NOTHING`,
      [dateIds],
    )
  }
  finally {
    await closeClient(c, db)
  }
}

async function updateGlobalStatsSnapshot(c: Context, dateId: string, patch: GlobalStatsSnapshotPatch): Promise<void> {
  await ensureGlobalStatsSnapshotRow(c, dateId)

  const { orgs, apps_with_preview, ...globalStatsPatch } = patch
  const updatePayload = {
    ...globalStatsPatch,
    ...(apps_with_preview === undefined ? {} : { apps_with_preview }),
  } as GlobalStatsUpdate
  const { error } = await supabaseAdmin(c)
    .from('global_stats')
    .update(updatePayload)
    .eq('date_id', dateId)

  if (error) {
    if (apps_with_preview !== undefined && isMissingAppsWithPreviewColumnError(error)) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'global_stats.apps_with_preview missing; retrying snapshot update without it',
        dateId,
        error,
      })
      const { error: legacyError } = await supabaseAdmin(c)
        .from('global_stats')
        .update(globalStatsPatch as GlobalStatsUpdate)
        .eq('date_id', dateId)
      if (legacyError)
        throw legacyError
    }
    else {
      throw error
    }
  }

  if (orgs !== undefined)
    await updateGlobalStatsSnapshotOrgCount(c, dateId, orgs)
}

async function updateGlobalStatsSnapshotOrgCount(c: Context, dateId: string, orgs: number): Promise<void> {
  const db = getPgClient(c)

  try {
    const result = await db.query(
      `UPDATE public.global_stats
      SET orgs = $2
      WHERE date_id = $1`,
      [dateId, orgs],
    )
    if (result.rowCount !== 1)
      throw new Error(`Expected one global_stats row for ${dateId}, updated orgs on ${result.rowCount ?? 0}`)
  }
  finally {
    await closeClient(c, db)
  }
}

function normalizeCompletedGlobalStatsShards(value: unknown): Set<GlobalStatsCompletionMarker> {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    }
    catch {
      parsed = []
    }
  }

  if (!Array.isArray(parsed))
    return new Set()

  return new Set(parsed.filter((shard): shard is GlobalStatsCompletionMarker => typeof shard === 'string' && GLOBAL_STATS_COMPLETION_MARKER_SET.has(shard)))
}

function getEmptyBuildShardStats(): BuildShardStats {
  return {
    totalSeconds: { ios: 0, android: 0 },
    avgSeconds: { ios: 0, android: 0 },
    counts: { ios: 0, android: 0 },
  }
}

function normalizeGlobalStatsRepairNumber(value: number | string | null): number {
  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? numericValue : 0
}

function normalizeGlobalStatsRepairRow(row: GlobalStatsRepairSqlRow): GlobalStatsRepairRow {
  return {
    dateId: row.date_id,
    completedShards: normalizeCompletedGlobalStatsShards(row.completed_shards),
    orgs: normalizeGlobalStatsRepairNumber(row.orgs),
    bundleStorageGb: normalizeGlobalStatsRepairNumber(row.bundle_storage_gb),
    buildTotalSecondsDayIos: normalizeGlobalStatsRepairNumber(row.build_total_seconds_day_ios),
    buildTotalSecondsDayAndroid: normalizeGlobalStatsRepairNumber(row.build_total_seconds_day_android),
    buildAvgSecondsDayIos: normalizeGlobalStatsRepairNumber(row.build_avg_seconds_day_ios),
    buildAvgSecondsDayAndroid: normalizeGlobalStatsRepairNumber(row.build_avg_seconds_day_android),
    buildCountDayIos: normalizeGlobalStatsRepairNumber(row.build_count_day_ios),
    buildCountDayAndroid: normalizeGlobalStatsRepairNumber(row.build_count_day_android),
  }
}

function areGlobalStatsNumbersDifferent(actual: number, expected: number, epsilon = 0): boolean {
  return Math.abs(actual - expected) > epsilon
}

function isGlobalStatsBuildShardStale(row: GlobalStatsRepairRow, expectedStats: BuildShardStats): boolean {
  return areGlobalStatsNumbersDifferent(row.buildTotalSecondsDayIos, expectedStats.totalSeconds.ios)
    || areGlobalStatsNumbersDifferent(row.buildTotalSecondsDayAndroid, expectedStats.totalSeconds.android)
    || areGlobalStatsNumbersDifferent(row.buildAvgSecondsDayIos, expectedStats.avgSeconds.ios, GLOBAL_STATS_BUILD_AVG_EPSILON)
    || areGlobalStatsNumbersDifferent(row.buildAvgSecondsDayAndroid, expectedStats.avgSeconds.android, GLOBAL_STATS_BUILD_AVG_EPSILON)
    || areGlobalStatsNumbersDifferent(row.buildCountDayIos, expectedStats.counts.ios)
    || areGlobalStatsNumbersDifferent(row.buildCountDayAndroid, expectedStats.counts.android)
}

function getGlobalStatsStaleRepairShards(row: GlobalStatsRepairRow, expectedBuildStats: BuildShardStats = getEmptyBuildShardStats()): GlobalStatsShard[] {
  const staleShards: GlobalStatsShard[] = []

  if (row.completedShards.has('core') && row.orgs <= 0)
    staleShards.push('core')
  if (row.completedShards.has('usage_storage') && row.bundleStorageGb <= 0)
    staleShards.push('usage_storage')
  if (row.completedShards.has('builds') && isGlobalStatsBuildShardStale(row, expectedBuildStats))
    staleShards.push('builds')

  return staleShards
}

function uniqueGlobalStatsShards(shards: readonly GlobalStatsShard[]): GlobalStatsShard[] {
  return GLOBAL_STATS_SHARDS.filter(shard => shards.includes(shard))
}

function filterCandidateGlobalStatsShards(shards: readonly GlobalStatsShard[], candidateShards?: readonly GlobalStatsShard[]): GlobalStatsShard[] {
  if (!candidateShards)
    return uniqueGlobalStatsShards(shards)

  const candidateShardSet = new Set(candidateShards)
  return uniqueGlobalStatsShards(shards.filter(shard => candidateShardSet.has(shard)))
}

function getGlobalStatsRepairShardQueueCandidates(
  completedShards: ReadonlySet<GlobalStatsCompletionMarker>,
  staleShards: readonly GlobalStatsShard[] = [],
  candidateShards?: readonly GlobalStatsShard[],
): GlobalStatsShard[] {
  const missingRequiredShards = filterCandidateGlobalStatsShards(getMissingGlobalStatsRequiredShards(completedShards), candidateShards)
  const staleRequiredShards = filterCandidateGlobalStatsShards(staleShards, candidateShards)
  if (missingRequiredShards.length > 0 || staleRequiredShards.length > 0)
    return uniqueGlobalStatsShards([...missingRequiredShards, ...staleRequiredShards])

  const missingShards = candidateShards ? candidateShards.filter(shard => !completedShards.has(shard)) : getMissingGlobalStatsShards(completedShards)
  return filterCandidateGlobalStatsShards(missingShards, candidateShards)
}

function getMissingGlobalStatsRequiredShards(completedShards: ReadonlySet<GlobalStatsCompletionMarker>): RequiredGlobalStatsShard[] {
  return REQUIRED_GLOBAL_STATS_SHARDS.filter(shard => !completedShards.has(shard))
}

function getMissingGlobalStatsShards(completedShards: ReadonlySet<GlobalStatsCompletionMarker>): GlobalStatsShard[] {
  return GLOBAL_STATS_SHARDS.filter(shard => !completedShards.has(shard))
}

function getGlobalStatsShardQueueCandidates(completedShards: ReadonlySet<GlobalStatsCompletionMarker>): GlobalStatsShard[] {
  const missingRequiredShards = getMissingGlobalStatsRequiredShards(completedShards)
  return missingRequiredShards.length > 0 ? missingRequiredShards : getMissingGlobalStatsShards(completedShards)
}

function hasCompletedGlobalStatsNotifications(completedShards: ReadonlySet<GlobalStatsCompletionMarker>): boolean {
  return completedShards.has('notifications')
}

function shouldSkipCompletedGlobalStatsShardRetry(
  completedShards: ReadonlySet<GlobalStatsCompletionMarker>,
  shard: GlobalStatsShard,
): boolean {
  return shard !== 'notifications' && completedShards.has(shard)
}

async function shouldSkipGlobalStatsShardUpdate(
  c: Context,
  dateId: string,
  completedShards: ReadonlySet<GlobalStatsCompletionMarker>,
  shard: GlobalStatsShard,
): Promise<boolean> {
  if (!shouldSkipCompletedGlobalStatsShardRetry(completedShards, shard))
    return false

  if (await readCompletedGlobalStatsRepairShardStale(c, dateId, shard))
    return false

  return true
}

function getGlobalStatsNotificationStepAction(
  completedShards: ReadonlySet<GlobalStatsCompletionMarker>,
  sentMarker: GlobalStatsCompletionMarker,
  claimMarker: GlobalStatsCompletionMarker,
): GlobalStatsNotificationStepAction {
  if (completedShards.has(sentMarker))
    return 'skip'
  if (completedShards.has(claimMarker))
    return 'complete_claimed'
  return 'send'
}

async function readCompletedGlobalStatsShards(c: Context, dateId: string): Promise<Set<GlobalStatsCompletionMarker>> {
  const db = getPgClient(c)

  try {
    const result = await db.query<{ completed_shards: unknown }>(
      'SELECT completed_shards FROM public.global_stats WHERE date_id = $1',
      [dateId],
    )
    const completedShards = result.rows[0]?.completed_shards
    return normalizeCompletedGlobalStatsShards(completedShards)
  }
  catch (error) {
    quickError(503, 'global_stats_snapshot_not_ready', 'Global stats snapshot shard state is not ready', { dateId }, error, { alert: false })
  }
  finally {
    await closeClient(c, db)
  }
}

async function claimGlobalStatsNotificationDelivery(c: Context, dateId: string): Promise<ReturnType<typeof getPgClient> | null> {
  const db = getPgClient(c)

  try {
    const result = await db.query<{ claimed: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS claimed',
      [GLOBAL_STATS_NOTIFICATION_LOCK_NAMESPACE, dateId],
    )
    if (result.rows[0]?.claimed === true)
      return db

    await closeClient(c, db)
    return null
  }
  catch (error) {
    await closeClient(c, db)
    quickError(503, 'global_stats_notification_claim_failed', 'Global stats notification delivery claim failed', { dateId }, error, { alert: false })
  }
}

async function releaseGlobalStatsNotificationDeliveryClaim(c: Context, db: ReturnType<typeof getPgClient>, dateId: string): Promise<void> {
  try {
    await db.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [GLOBAL_STATS_NOTIFICATION_LOCK_NAMESPACE, dateId])
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to release global stats notification claim', dateId, error })
  }
  finally {
    await closeClient(c, db)
  }
}

async function shouldSkipCompletedGlobalStatsRetryDispatch(c: Context, dateId: string, retryCount: number): Promise<boolean> {
  if (retryCount <= 0)
    return false

  const completedShards = await readCompletedGlobalStatsShards(c, dateId)
  const missingRequiredShards = getMissingGlobalStatsRequiredShards(completedShards)
  if (missingRequiredShards.length > 0)
    return false

  if (!completedShards.has('notifications')) {
    const queued = await queueGlobalStatsShard(c, 'notifications', dateId)
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Queued missing global stats notification shard for completed retry',
      dateId,
      retryCount,
      queued,
      completedShards: Array.from(completedShards).sort((a, b) => a.localeCompare(b)),
    })
    return true
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Skipping completed global stats retry dispatch',
    dateId,
    retryCount,
    completedShards: Array.from(completedShards).sort((a, b) => a.localeCompare(b)),
  })
  return true
}

async function markGlobalStatsShardComplete(c: Context, dateId: string, shard: GlobalStatsCompletionMarker): Promise<void> {
  const db = getPgClient(c)

  try {
    const result = await db.query(
      `UPDATE public.global_stats
      SET completed_shards = (
        SELECT COALESCE(jsonb_agg(shard_name ORDER BY shard_name), '[]'::jsonb)
        FROM (
          SELECT DISTINCT shard_name
          FROM (
            SELECT jsonb_array_elements_text(completed_shards) AS shard_name
            UNION ALL
            SELECT $2::text AS shard_name
          ) shards
        ) deduped
      )
      WHERE date_id = $1`,
      [dateId, shard],
    )
    if (result.rowCount !== 1)
      throw new Error(`Expected one global_stats row for ${dateId}, updated ${result.rowCount ?? 0}`)
  }
  finally {
    await closeClient(c, db)
  }
}

async function removeGlobalStatsShardMarker(c: Context, dateId: string, shard: GlobalStatsCompletionMarker): Promise<void> {
  const db = getPgClient(c)

  try {
    const result = await db.query(
      `UPDATE public.global_stats
      SET completed_shards = (
        SELECT COALESCE(jsonb_agg(shard_name ORDER BY shard_name), '[]'::jsonb)
        FROM (
          SELECT DISTINCT shard_name
          FROM jsonb_array_elements_text(completed_shards) AS shards(shard_name)
          WHERE shard_name <> $2::text
        ) deduped
      )
      WHERE date_id = $1`,
      [dateId, shard],
    )
    if (result.rowCount !== 1)
      throw new Error(`Expected one global_stats row for ${dateId}, updated ${result.rowCount ?? 0}`)
  }
  finally {
    await closeClient(c, db)
  }
}

async function runGlobalStatsNotificationProviderStep(
  c: Context,
  dateId: string,
  provider: string,
  completedShards: Set<GlobalStatsCompletionMarker>,
  sentMarker: GlobalStatsCompletionMarker,
  claimMarker: GlobalStatsCompletionMarker,
  send: () => Promise<void>,
): Promise<void> {
  const action = getGlobalStatsNotificationStepAction(completedShards, sentMarker, claimMarker)
  if (action === 'skip')
    return

  if (action === 'complete_claimed') {
    await markGlobalStatsShardComplete(c, dateId, sentMarker)
    completedShards.add(sentMarker)
    cloudlog({ requestId: c.get('requestId'), message: 'Completed claimed global stats notification step', dateId, provider })
    return
  }

  // This persistent claim prevents replay if the provider send succeeds but the sent-marker write fails.
  await markGlobalStatsShardComplete(c, dateId, claimMarker)
  completedShards.add(claimMarker)

  try {
    await send()
  }
  catch (error) {
    completedShards.delete(claimMarker)
    try {
      await removeGlobalStatsShardMarker(c, dateId, claimMarker)
    }
    catch (cleanupError) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to clear global stats notification claim', dateId, provider, cleanupError })
    }
    throw error
  }

  await markGlobalStatsShardComplete(c, dateId, sentMarker)
  completedShards.add(sentMarker)
}

function getGlobalStatsShardDelaySeconds(shard: GlobalStatsShard): number {
  return shard === 'notifications' ? GLOBAL_STATS_NOTIFICATION_DELAY_SECONDS : 0
}

async function queueGlobalStatsMessage(
  db: ReturnType<typeof getPgClient>,
  message: ReturnType<typeof buildGlobalStatsRetryMessage> | ReturnType<typeof buildGlobalStatsShardMessage>,
  delaySeconds: number,
): Promise<number> {
  const result = await db.query<{ msg_id: number | string }>('SELECT pgmq.send($1::text, $2::jsonb, $3::integer) AS msg_id', [
    GLOBAL_STATS_QUEUE_NAME,
    JSON.stringify(message),
    delaySeconds,
  ])
  const msgId = Number(result.rows[0]?.msg_id)
  if (!Number.isSafeInteger(msgId))
    throw new Error('pgmq.send did not return a message id')
  return msgId
}

async function queueGlobalStatsShard(c: Context, shard: GlobalStatsShard, dateId: string): Promise<{ shard: GlobalStatsShard, msgId: number, delaySeconds: number }> {
  const db = getPgClient(c)

  try {
    const delaySeconds = getGlobalStatsShardDelaySeconds(shard)
    const msgId = await queueGlobalStatsMessage(db, buildGlobalStatsShardMessage(shard, dateId), delaySeconds)
    return { shard, msgId, delaySeconds }
  }
  finally {
    await closeClient(c, db)
  }
}

async function queueGlobalStatsShards(
  c: Context,
  dateId: string,
  shards: readonly GlobalStatsShard[],
): Promise<Array<{ shard: GlobalStatsShard, msgId: number, delaySeconds: number }>> {
  if (shards.length === 0)
    return []

  const db = getPgClient(c)
  const queued: Array<{ shard: GlobalStatsShard, msgId: number, delaySeconds: number }> = []

  try {
    for (const shard of shards) {
      const delaySeconds = getGlobalStatsShardDelaySeconds(shard)
      const msgId = await queueGlobalStatsMessage(db, buildGlobalStatsShardMessage(shard, dateId), delaySeconds)
      queued.push({ shard, msgId, delaySeconds })
    }
  }
  finally {
    await closeClient(c, db)
  }

  return queued
}

async function queueMissingGlobalStatsShards(
  c: Context,
  dateId: string,
  completedShards: ReadonlySet<GlobalStatsCompletionMarker>,
  candidateShards?: readonly GlobalStatsShard[],
  staleShards: readonly GlobalStatsShard[] = [],
): Promise<Array<{ shard: GlobalStatsShard, msgId: number, delaySeconds: number }>> {
  const shardsToQueue = getGlobalStatsRepairShardQueueCandidates(completedShards, staleShards, candidateShards)
  return queueGlobalStatsShards(c, dateId, shardsToQueue)
}

function getGlobalStatsShardQueueKey(shard: GlobalStatsShard, dateId: string): string {
  return `${dateId}:${getGlobalStatsShardFunctionName(shard)}`
}

async function readQueuedGlobalStatsShardKeys(c: Context, dateIds: readonly string[]): Promise<Set<string>> {
  if (dateIds.length === 0)
    return new Set()

  const db = getPgClient(c)
  const functionNames = GLOBAL_STATS_SHARDS.map(shard => getGlobalStatsShardFunctionName(shard))

  try {
    const result = await db.query<{ function_name: string | null, date_id: string | null }>(
      `SELECT
        message->>'function_name' AS function_name,
        message->'payload'->>'date_id' AS date_id
      FROM pgmq.q_admin_stats
      WHERE message->>'function_name' = ANY($1::text[])
        AND message->'payload'->>'date_id' = ANY($2::text[])`,
      [functionNames, dateIds],
    )

    return new Set(result.rows.flatMap((row) => {
      if (!row.function_name || !row.date_id)
        return []
      return [`${row.date_id}:${row.function_name}`]
    }))
  }
  finally {
    await closeClient(c, db)
  }
}

async function readGlobalStatsRepairRows(c: Context, dateIds: readonly string[]): Promise<Map<string, GlobalStatsRepairRow>> {
  if (dateIds.length === 0)
    return new Map()

  const db = getPgClient(c)

  try {
    const result = await db.query<GlobalStatsRepairSqlRow>(
      `SELECT
        date_id,
        completed_shards,
        orgs,
        bundle_storage_gb,
        build_total_seconds_day_ios,
        build_total_seconds_day_android,
        build_avg_seconds_day_ios,
        build_avg_seconds_day_android,
        build_count_day_ios,
        build_count_day_android
      FROM public.global_stats
      WHERE date_id = ANY($1::text[])`,
      [dateIds],
    )

    return new Map(result.rows.map((row) => {
      const repairRow = normalizeGlobalStatsRepairRow(row)
      return [repairRow.dateId, repairRow]
    }))
  }
  finally {
    await closeClient(c, db)
  }
}

async function readDailyBuildStatsByDate(c: Context, dateIds: readonly string[]): Promise<Map<string, BuildShardStats>> {
  const uniqueDateIds = Array.from(new Set(dateIds)).sort((a, b) => a.localeCompare(b))
  if (uniqueDateIds.length === 0)
    return new Map()

  const start = new Date(`${uniqueDateIds[0]}T00:00:00.000Z`)
  const end = new Date(`${uniqueDateIds.at(-1)}T00:00:00.000Z`)
  end.setUTCDate(end.getUTCDate() + 1)

  const db = getPgClient(c, false)

  try {
    const result = await db.query<{ date_id: string, platform: string, total_seconds: number | string | null, avg_seconds: number | string | null, total_builds: number | string | null }>(
      `SELECT
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date_id,
        platform,
        COALESCE(SUM(billable_seconds), 0)::bigint AS total_seconds,
        COALESCE(ROUND(AVG(billable_seconds)::numeric, 1), 0)::float AS avg_seconds,
        COUNT(*)::int AS total_builds
      FROM public.build_logs
      WHERE created_at >= $1
        AND created_at < $2
        AND platform IN ('ios', 'android')
      GROUP BY date_id, platform`,
      [start, end],
    )

    const statsByDate = new Map(uniqueDateIds.map(dateId => [dateId, getEmptyBuildShardStats()]))
    for (const row of result.rows) {
      if (row.platform !== 'ios' && row.platform !== 'android')
        continue

      const stats = statsByDate.get(row.date_id) ?? getEmptyBuildShardStats()
      stats.totalSeconds[row.platform] = normalizeGlobalStatsRepairNumber(row.total_seconds)
      stats.avgSeconds[row.platform] = normalizeGlobalStatsRepairNumber(row.avg_seconds)
      stats.counts[row.platform] = normalizeGlobalStatsRepairNumber(row.total_builds)
      statsByDate.set(row.date_id, stats)
    }

    return statsByDate
  }
  finally {
    await closeClient(c, db)
  }
}

async function readCompletedGlobalStatsRepairShardStale(c: Context, dateId: string, shard: GlobalStatsShard): Promise<boolean> {
  if (shard !== 'core' && shard !== 'usage_storage' && shard !== 'builds')
    return false

  const repairRow = (await readGlobalStatsRepairRows(c, [dateId])).get(dateId)
  if (!repairRow?.completedShards.has(shard))
    return false

  const buildStats = shard === 'builds'
    ? (await readDailyBuildStatsByDate(c, [dateId])).get(dateId) ?? getEmptyBuildShardStats()
    : getEmptyBuildShardStats()

  return getGlobalStatsStaleRepairShards(repairRow, buildStats).includes(shard)
}

async function repairRecentMissingGlobalStatsSnapshots(c: Context, anchorDateId: string): Promise<void> {
  const dateIds = buildRecentGlobalStatsRepairDateIds(anchorDateId).filter(dateId => dateId !== anchorDateId)
  if (dateIds.length === 0)
    return

  const [repairRows, queuedShardKeys] = await Promise.all([
    readGlobalStatsRepairRows(c, dateIds),
    readQueuedGlobalStatsShardKeys(c, dateIds),
  ])
  const missingDateIds = dateIds.filter(dateId => !repairRows.has(dateId))
  await ensureGlobalStatsSnapshotRows(c, missingDateIds)

  const buildStatsByDate = await readDailyBuildStatsByDate(c, Array.from(repairRows.values()).flatMap((row) => {
    if (!row.completedShards.has('builds'))
      return []
    return [row.dateId]
  }))

  const queuedByDate: Array<{ dateId: string, staleShards: GlobalStatsShard[], queued: Array<{ shard: GlobalStatsShard, msgId: number, delaySeconds: number }> }> = []
  for (const dateId of dateIds) {
    const repairRow = repairRows.get(dateId)
    const completedShards = repairRow?.completedShards ?? new Set<GlobalStatsCompletionMarker>()
    const staleShards = repairRow ? getGlobalStatsStaleRepairShards(repairRow, buildStatsByDate.get(dateId) ?? getEmptyBuildShardStats()) : []
    const shardsToQueue = getGlobalStatsRepairShardQueueCandidates(completedShards, staleShards)
      .filter(shard => !queuedShardKeys.has(getGlobalStatsShardQueueKey(shard, dateId)))

    const queued = await queueGlobalStatsShards(c, dateId, shardsToQueue)
    if (queued.length > 0)
      queuedByDate.push({ dateId, staleShards, queued })
  }

  if (missingDateIds.length > 0 || queuedByDate.length > 0) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Repaired recent missing or stale global stats snapshots',
      anchorDateId,
      missingDateIds,
      queuedByDate,
    })
  }
}

async function dispatchMissingGlobalStatsShardsFor(
  c: Context,
  dateId: string,
  candidateShards: readonly GlobalStatsShard[] | undefined,
  noMissingMessage: string,
  queuedMessage: string,
): Promise<void> {
  await ensureGlobalStatsSnapshotRow(c, dateId)
  const repairRow = (await readGlobalStatsRepairRows(c, [dateId])).get(dateId)
  const completedShards = repairRow?.completedShards ?? new Set<GlobalStatsCompletionMarker>()
  const buildStats = repairRow?.completedShards.has('builds')
    ? (await readDailyBuildStatsByDate(c, [dateId])).get(dateId) ?? getEmptyBuildShardStats()
    : getEmptyBuildShardStats()
  const staleShards = repairRow ? getGlobalStatsStaleRepairShards(repairRow, buildStats) : []
  const queued = await queueMissingGlobalStatsShards(c, dateId, completedShards, candidateShards, staleShards)
  const completedShardNames = Array.from(completedShards).sort((a, b) => a.localeCompare(b))

  if (queued.length === 0) {
    cloudlog({
      requestId: c.get('requestId'),
      message: noMissingMessage,
      dateId,
      completedShards: completedShardNames,
      staleShards,
    })
    return
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: queuedMessage,
    dateId,
    queued,
    completedShards: completedShardNames,
    staleShards,
  })
}

async function dispatchMissingGlobalStatsShards(c: Context, dateId: string): Promise<void> {
  await dispatchMissingGlobalStatsShardsFor(
    c,
    dateId,
    undefined,
    'No missing global stats shards to queue',
    'Queued missing global stats shards',
  )
}

async function dispatchMissingGlobalStatsUsageShards(c: Context, dateId: string): Promise<void> {
  await dispatchMissingGlobalStatsShardsFor(
    c,
    dateId,
    USAGE_GLOBAL_STATS_SHARDS,
    'No missing global stats usage shards to queue',
    'Queued missing global stats usage shards',
  )
}

async function dispatchGlobalStatsShards(c: Context, dateId: string): Promise<void> {
  await ensureGlobalStatsSnapshotRow(c, dateId)
  const completedShards = await readCompletedGlobalStatsShards(c, dateId)
  const queued = await queueMissingGlobalStatsShards(c, dateId, completedShards)

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Queued global stats shards',
    dateId,
    queued,
    completedShards: Array.from(completedShards).sort((a, b) => a.localeCompare(b)),
  })
}

function remainingCreditsAtSnapshotSql(snapshotExclusiveEndIso: string) {
  // Grant alias must stay `g` in every caller. Shared so Credits and
  // above-plan-with-credits use the same snapshot boundary.
  return sql`
    g.granted_at < ${snapshotExclusiveEndIso}::timestamptz
      AND g.expires_at >= ${snapshotExclusiveEndIso}::timestamptz
      AND g.credits_total > COALESCE((
        SELECT SUM(c.credits_used)
        FROM public.usage_credit_consumptions c
        WHERE c.grant_id = g.id
          AND c.applied_at < ${snapshotExclusiveEndIso}::timestamptz
      ), 0)
  `
}

async function getBillingSnapshotCounts(c: Context, snapshotExclusiveEnd: Date): Promise<BillingSnapshotCounts> {
  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)
  const snapshotExclusiveEndIso = snapshotExclusiveEnd.toISOString()

  try {
    // stripe_info stores current rows, so historical replays derive snapshot state from lifecycle timestamps.
    const result = await drizzleClient.execute<BillingSnapshotRow>(sql`
      WITH active_subscriptions AS (
        SELECT DISTINCT ON (si.customer_id)
          si.customer_id,
          si.price_id,
          p.name::character varying AS plan_name
        FROM public.stripe_info si
        INNER JOIN public.plans p ON p.stripe_id = si.product_id
        WHERE si.is_good_plan = true
          AND si.created_at < ${snapshotExclusiveEndIso}::timestamptz
          AND si.paid_at IS NOT NULL
          AND si.paid_at < ${snapshotExclusiveEndIso}::timestamptz
          AND si.trial_at <= ${snapshotExclusiveEndIso}::timestamptz
          AND si.status IN (
            'succeeded'::public.stripe_status,
            'canceled'::public.stripe_status,
            'deleted'::public.stripe_status
          )
          AND (si.canceled_at IS NULL OR si.canceled_at >= ${snapshotExclusiveEndIso}::timestamptz)
          AND si.subscription_anchor_end > ${snapshotExclusiveEndIso}::timestamptz
        ORDER BY si.customer_id, si.created_at DESC
      ),
      trial_users AS (
        SELECT DISTINCT ON (si.customer_id)
          'Trial'::character varying AS plan_name,
          si.customer_id
        FROM public.stripe_info si
        WHERE si.created_at < ${snapshotExclusiveEndIso}::timestamptz
          AND si.trial_at > ${snapshotExclusiveEndIso}::timestamptz
          AND (si.paid_at IS NULL OR si.paid_at >= ${snapshotExclusiveEndIso}::timestamptz)
          AND (si.canceled_at IS NULL OR si.canceled_at >= ${snapshotExclusiveEndIso}::timestamptz)
          AND NOT EXISTS (
            SELECT 1
            FROM active_subscriptions a
            WHERE a.customer_id = si.customer_id
          )
        ORDER BY si.customer_id, si.created_at DESC
      ),
      credit_only_orgs AS (
        SELECT DISTINCT g.org_id
        FROM public.usage_credit_grants g
        INNER JOIN public.orgs o ON o.id = g.org_id
        WHERE o.created_at < ${snapshotExclusiveEndIso}::timestamptz
          AND ${remainingCreditsAtSnapshotSql(snapshotExclusiveEndIso)}
          AND NOT EXISTS (
            SELECT 1
            FROM active_subscriptions a
            WHERE a.customer_id = o.customer_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM trial_users t
            WHERE t.customer_id = o.customer_id
          )
      ),
      plan_counts AS (
        SELECT plan_name, COUNT(*)::int AS plan_count
        FROM active_subscriptions
        GROUP BY plan_name
        UNION ALL
        SELECT 'Trial'::character varying AS plan_name, COUNT(*)::int AS plan_count
        FROM trial_users
        UNION ALL
        SELECT 'Credits'::character varying AS plan_name, COUNT(*)::int AS plan_count
        FROM credit_only_orgs
      ),
      customer_counts AS (
        SELECT
          COUNT(CASE WHEN price_id IN (SELECT price_y_id FROM public.plans WHERE price_y_id IS NOT NULL) THEN 1 END)::int AS yearly,
          COUNT(CASE WHEN price_id IN (SELECT price_m_id FROM public.plans WHERE price_m_id IS NOT NULL) THEN 1 END)::int AS monthly,
          COUNT(*)::int AS total
        FROM active_subscriptions
      ),
      paying_org_counts AS (
        SELECT COUNT(DISTINCT o.id)::int AS paying_orgs_for_conversion
        FROM public.orgs o
        INNER JOIN active_subscriptions a ON a.customer_id = o.customer_id
      )
      SELECT
        cc.yearly,
        cc.monthly,
        cc.total,
        poc.paying_orgs_for_conversion,
        pc.plan_name,
        pc.plan_count
      FROM customer_counts cc
      CROSS JOIN paying_org_counts poc
      LEFT JOIN plan_counts pc ON true
    `)

    return normalizeBillingSnapshotCounts(result.rows)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'billing snapshot counts error', error })
    return getEmptyBillingSnapshotCounts()
  }
  finally {
    await closeClient(c, pgClient)
  }
}

async function getSubscriptionAccessSnapshotCounts(c: Context, snapshotExclusiveEnd: Date): Promise<SubscriptionAccessSnapshotCounts> {
  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)
  const snapshotExclusiveEndIso = snapshotExclusiveEnd.toISOString()

  try {
    const result = await drizzleClient.execute<SubscriptionAccessSnapshotSqlRow>(sql`
      WITH active_canceled AS (
        SELECT DISTINCT ON (si.customer_id)
          si.customer_id
        FROM public.stripe_info si
        WHERE si.is_good_plan = true
          AND si.created_at < ${snapshotExclusiveEndIso}::timestamptz
          AND si.paid_at IS NOT NULL
          AND si.paid_at < ${snapshotExclusiveEndIso}::timestamptz
          AND si.canceled_at IS NOT NULL
          AND si.canceled_at < ${snapshotExclusiveEndIso}::timestamptz
          AND si.subscription_anchor_end > ${snapshotExclusiveEndIso}::timestamptz
        ORDER BY si.customer_id, si.created_at DESC
      ),
      active_past_due AS (
        SELECT DISTINCT ON (si.customer_id)
          si.customer_id
        FROM public.stripe_info si
        WHERE si.is_good_plan = true
          AND si.created_at < ${snapshotExclusiveEndIso}::timestamptz
          AND si.paid_at IS NOT NULL
          AND si.paid_at < ${snapshotExclusiveEndIso}::timestamptz
          AND si.past_due_at IS NOT NULL
          AND si.past_due_at < ${snapshotExclusiveEndIso}::timestamptz
          AND si.subscription_anchor_end > ${snapshotExclusiveEndIso}::timestamptz
          AND (si.canceled_at IS NULL OR si.canceled_at >= ${snapshotExclusiveEndIso}::timestamptz)
          AND si.status = 'succeeded'::public.stripe_status
        ORDER BY si.customer_id, si.created_at DESC
      )
      SELECT
        (SELECT COUNT(*)::int FROM active_canceled) AS active_canceled_orgs,
        (SELECT COUNT(*)::int FROM active_past_due) AS active_past_due_orgs
    `)

    return normalizeSubscriptionAccessSnapshotCounts(result.rows[0])
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'subscription access snapshot counts error', error })
    return getEmptySubscriptionAccessSnapshotCounts()
  }
  finally {
    await closeClient(c, pgClient)
  }
}
async function getCoreSnapshotCounts(c: Context, snapshotExclusiveEnd: Date): Promise<CoreSnapshotCounts> {
  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)
  const snapshotExclusiveEndIso = snapshotExclusiveEnd.toISOString()

  // stripe_info stores current plan-state flags; plan_calculated_at bounds dated replays against later recalculations.
  try {
    const result = await drizzleClient.execute<CoreSnapshotRow>(sql`
      WITH active_need_upgrade AS (
        SELECT DISTINCT ON (si.customer_id)
          si.customer_id
        FROM public.stripe_info si
        WHERE si.is_good_plan = false
          AND si.created_at < ${snapshotExclusiveEndIso}::timestamptz
          AND (si.plan_calculated_at IS NULL OR si.plan_calculated_at < ${snapshotExclusiveEndIso}::timestamptz)
          AND (si.paid_at < ${snapshotExclusiveEndIso}::timestamptz OR si.paid_at IS NULL)
          AND si.status IN (
            'succeeded'::public.stripe_status,
            'canceled'::public.stripe_status,
            'deleted'::public.stripe_status
          )
          AND (si.canceled_at IS NULL OR si.canceled_at >= ${snapshotExclusiveEndIso}::timestamptz)
          AND si.subscription_anchor_end > ${snapshotExclusiveEndIso}::timestamptz
        ORDER BY si.customer_id, si.created_at DESC
      ),
      active_above_plan AS (
        SELECT DISTINCT ON (si.customer_id)
          si.customer_id,
          EXISTS (
            SELECT 1
            FROM public.usage_credit_grants g
            WHERE g.org_id = o.id
              AND ${remainingCreditsAtSnapshotSql(snapshotExclusiveEndIso)}
          ) AS has_usage_credits
        FROM public.stripe_info si
        INNER JOIN public.orgs o
          ON o.customer_id = si.customer_id
        INNER JOIN public.plans p
          ON p.stripe_id = si.product_id
        WHERE si.is_above_plan = true
          AND p.name <> 'Enterprise'
          AND si.created_at < ${snapshotExclusiveEndIso}::timestamptz
          AND (si.plan_calculated_at IS NULL OR si.plan_calculated_at < ${snapshotExclusiveEndIso}::timestamptz)
          AND (si.paid_at < ${snapshotExclusiveEndIso}::timestamptz OR si.paid_at IS NULL)
          AND si.status IN (
            'succeeded'::public.stripe_status,
            'canceled'::public.stripe_status,
            'deleted'::public.stripe_status
          )
          AND (si.canceled_at IS NULL OR si.canceled_at >= ${snapshotExclusiveEndIso}::timestamptz)
          AND si.subscription_anchor_end > ${snapshotExclusiveEndIso}::timestamptz
        ORDER BY si.customer_id, si.created_at DESC
      ),
      current_onboarded_owner_orgs AS (
        SELECT COALESCE(
          (
            SELECT (transfer_entry.entry->>'transferred_from')::uuid
            FROM unnest(COALESCE(apps.transfer_history, '{}'::jsonb[])) AS transfer_entry(entry)
            WHERE (transfer_entry.entry->>'transferred_at')::timestamptz >= ${snapshotExclusiveEndIso}::timestamptz
            ORDER BY (transfer_entry.entry->>'transferred_at')::timestamptz ASC
            LIMIT 1
          ),
          apps.owner_org
        ) AS owner_org
        FROM public.apps apps
        WHERE apps.created_at < ${snapshotExclusiveEndIso}::timestamptz
      ),
      deleted_onboarded_owner_orgs AS (
        SELECT COALESCE(
          (
            SELECT (transfer_entry.entry->>'transferred_from')::uuid
            FROM unnest(COALESCE(deleted_apps.transfer_history, '{}'::jsonb[])) AS transfer_entry(entry)
            WHERE (transfer_entry.entry->>'transferred_at')::timestamptz >= ${snapshotExclusiveEndIso}::timestamptz
            ORDER BY (transfer_entry.entry->>'transferred_at')::timestamptz ASC
            LIMIT 1
          ),
          deleted_apps.owner_org
        ) AS owner_org
        FROM public.deleted_apps deleted_apps
        WHERE (
          deleted_apps.created_at < ${snapshotExclusiveEndIso}::timestamptz
          -- Legacy deleted_apps rows used created_at=deleted_at before the trigger copied the original app timestamp.
          OR deleted_apps.created_at = deleted_apps.deleted_at
        )
          AND deleted_apps.deleted_at >= ${snapshotExclusiveEndIso}::timestamptz
      )
      SELECT
        (
          SELECT COUNT(DISTINCT owner_org)::int
          FROM (
            SELECT owner_org FROM current_onboarded_owner_orgs
            UNION
            SELECT owner_org FROM deleted_onboarded_owner_orgs
          ) onboarded_owner_orgs
        ) AS onboarded,
        (
          SELECT COUNT(*)::int
          FROM active_need_upgrade
        ) AS need_upgrade,
        (
          SELECT COUNT(*)::int
          FROM active_above_plan
          WHERE has_usage_credits
        ) AS above_plan_with_credits,
        (
          SELECT COUNT(*)::int
          FROM active_above_plan
          WHERE NOT has_usage_credits
        ) AS above_plan_without_credits
    `)

    return normalizeCoreSnapshotCounts(result.rows[0])
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'core snapshot counts error', error })
    return normalizeCoreSnapshotCounts(null)
  }
  finally {
    await closeClient(c, pgClient)
  }
}

async function countRegisteredUsersForSnapshot(c: Context, snapshotExclusiveEnd: Date): Promise<number> {
  const db = getPgClient(c, false)
  const snapshotExclusiveEndIso = snapshotExclusiveEnd.toISOString()

  try {
    const result = await db.query<{ count: number | string | null }>(`
      SELECT COUNT(*)::int AS count
      FROM public.users u
      WHERE u.created_at < $1::timestamptz
        AND u.created_via_invite = false
    `, [snapshotExclusiveEndIso])

    return Number(result.rows[0]?.count) || 0
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'count registered users for snapshot error', error })
    return 0
  }
  finally {
    await closeClient(c, db)
  }
}

async function countActiveUsersForSnapshot(c: Context, appIds: string[], window: DailyWindow): Promise<number> {
  if (appIds.length === 0)
    return 0

  const db = getPgClient(c, false)
  const activeWindowStartIso = getLastMonthAnalyticsWindowStart(window.prevDayEnd).toISOString()

  try {
    const result = await db.query<{ count: number | string | null }>(`
      WITH active_app_ids AS (
        SELECT DISTINCT unnest($1::varchar[]) AS app_id
      ),
      current_active_owner_orgs AS (
        SELECT COALESCE(
          (
            SELECT (transfer_entry.entry->>'transferred_from')::uuid
            FROM unnest(COALESCE(apps.transfer_history, '{}'::jsonb[])) AS transfer_entry(entry)
            WHERE (transfer_entry.entry->>'transferred_at')::timestamptz >= $2::timestamptz
            ORDER BY (transfer_entry.entry->>'transferred_at')::timestamptz ASC
            LIMIT 1
          ),
          apps.owner_org
        ) AS owner_org
        FROM public.apps apps
        INNER JOIN active_app_ids active ON active.app_id = apps.app_id
        WHERE apps.created_at < $2::timestamptz
      ),
      deleted_active_owner_orgs AS (
        SELECT COALESCE(
          (
            SELECT (transfer_entry.entry->>'transferred_from')::uuid
            FROM unnest(COALESCE(deleted_apps.transfer_history, '{}'::jsonb[])) AS transfer_entry(entry)
            WHERE (transfer_entry.entry->>'transferred_at')::timestamptz >= $2::timestamptz
            ORDER BY (transfer_entry.entry->>'transferred_at')::timestamptz ASC
            LIMIT 1
          ),
          deleted_apps.owner_org
        ) AS owner_org
        FROM public.deleted_apps deleted_apps
        INNER JOIN active_app_ids active ON active.app_id = deleted_apps.app_id
        WHERE (
          deleted_apps.created_at < $2::timestamptz
          -- Legacy deleted_apps rows used created_at=deleted_at before the trigger copied the original app timestamp.
          OR deleted_apps.created_at = deleted_apps.deleted_at
        )
          AND deleted_apps.deleted_at >= $3::timestamptz
      )
      SELECT COUNT(DISTINCT orgs.created_by)::int AS count
      FROM (
        SELECT owner_org FROM current_active_owner_orgs
        UNION
        SELECT owner_org FROM deleted_active_owner_orgs
      ) active_owner_orgs
      INNER JOIN public.orgs orgs ON orgs.id = active_owner_orgs.owner_org
      WHERE orgs.created_at < $2::timestamptz
    `, [appIds, window.prevDayEnd.toISOString(), activeWindowStartIso])

    return Number(result.rows[0]?.count) || 0
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'count active users for snapshot error', error })
    return 0
  }
  finally {
    await closeClient(c, db)
  }
}

async function runCoreGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  const supabase = supabaseAdmin(c)
  const snapshotEndIso = window.prevDayEnd.toISOString()
  const finalizedAppBuildOnboardingWindow = getCompletedAppBuildOnboardingWindow(window)
  const [
    apps,
    apps_with_preview,
    updates,
    updates_external,
    users,
    orgs,
    stars,
    billingSnapshot,
    coreSnapshot,
    actives,
    finalizedAppBuildOnboardingMetrics,
  ] = await Promise.all([
    countAllApps(c, window.prevDayEnd),
    countAppsWithPreview(c, window.prevDayEnd),
    countAllUpdates(c, window.prevDayEnd),
    countAllUpdatesExternal(c, window.prevDayEnd),
    countRegisteredUsersForSnapshot(c, window.prevDayEnd),
    supabase
      .from('orgs')
      .select('id', { count: 'exact', head: true })
      .lt('created_at', snapshotEndIso)
      .then(res => res.count ?? 0),
    getGithubStars(),
    getBillingSnapshotCounts(c, window.prevDayEnd),
    getCoreSnapshotCounts(c, window.prevDayEnd),
    readActiveAppsCF(c, window.prevDayEnd).then(async appIds => ({
      apps: appIds.length,
      users: await countActiveUsersForSnapshot(c, appIds, window),
    })),
    getAppBuildOnboardingMetrics(c, finalizedAppBuildOnboardingWindow),
  ])

  const { customers, payingOrgsForConversion, plans } = billingSnapshot
  const {
    onboarded,
    needUpgrade: need_upgrade,
    abovePlanWithCredits: above_plan_with_credits,
    abovePlanWithoutCredits: above_plan_without_credits,
  } = coreSnapshot
  const not_paying = users - customers.total - plans.Trial
  const org_conversion_rate = calculateConversionRate(payingOrgsForConversion, orgs)
  // Plan upgrade/mix rates use paying orgs as denominator (not total users/orgs).
  const planConversionRates = getPlanConversionRates(plans, customers.total)

  // apps_created is event-sourced via the global_stats_creates queue so deleted
  // apps still count for the UTC day. Do not overwrite it from surviving rows.
  await updateGlobalStatsSnapshot(c, finalizedAppBuildOnboardingWindow.prevDayDateId, {
    apps_with_cli_onboarding_builds_24h: finalizedAppBuildOnboardingMetrics.apps_with_cli_onboarding_builds_24h,
    apps_with_manual_builds_24h: finalizedAppBuildOnboardingMetrics.apps_with_manual_builds_24h,
  })

  await updateGlobalStatsSnapshot(c, window.prevDayDateId, {
    apps,
    apps_active: actives.apps,
    apps_with_preview,
    above_plan_with_credits,
    above_plan_without_credits,
    need_upgrade,
    not_paying,
    onboarded,
    orgs,
    org_conversion_rate,
    paying: customers.total,
    paying_monthly: customers.monthly,
    paying_yearly: customers.yearly,
    plan_credits: plans.Credits || 0,
    plan_enterprise: plans.Enterprise || 0,
    plan_enterprise_conversion_rate: planConversionRates.enterprise,
    plan_maker: plans.Maker,
    plan_maker_conversion_rate: planConversionRates.maker,
    plan_solo: plans.Solo,
    plan_solo_conversion_rate: planConversionRates.solo,
    plan_team: plans.Team,
    plan_team_conversion_rate: planConversionRates.team,
    plan_total_conversion_rate: planConversionRates.total,
    stars,
    trial: plans.Trial,
    updates,
    updates_external,
    users,
    users_active: actives.users,
  })

  cloudlog({ requestId: c.get('requestId'), message: 'Updated global stats core shard', dateId: window.prevDayDateId, finalizedAppBuildOnboardingDateId: finalizedAppBuildOnboardingWindow.prevDayDateId, apps, apps_with_preview, updates, users, orgs })
}

async function getRegistersToday(c: Context, createdAfterIso: string, createdBeforeIso: string): Promise<number> {
  const supabase = supabaseAdmin(c)
  const filtered = await supabase
    .from('users')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', createdAfterIso)
    .lt('created_at', createdBeforeIso)
    .eq('created_via_invite', false)

  const filteredCode = String((filtered.error as any)?.code ?? '').toUpperCase()
  if (filteredCode === 'PGRST204' || filteredCode === '42703' || filtered.error?.message?.toLowerCase().includes('created_via_invite')) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'registers_today: created_via_invite column missing, falling back to legacy count',
      error: filtered.error,
    })
    const legacy = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', createdAfterIso)
      .lt('created_at', createdBeforeIso)
    if (legacy.error)
      cloudlog({ requestId: c.get('requestId'), message: 'registers_today legacy error', error: legacy.error })
    return legacy.count ?? 0
  }

  if (filtered.error)
    cloudlog({ requestId: c.get('requestId'), message: 'registers_today error', error: filtered.error })
  return filtered.count ?? 0
}

async function getBundleStorageGb(c: Context): Promise<number> {
  const res = await supabaseAdmin(c).rpc('total_bundle_storage_bytes')
  if (res.error) {
    cloudlog({ requestId: c.get('requestId'), message: 'total_bundle_storage_bytes error', error: res.error })
    return 0
  }
  const bytes = res.data ?? 0
  const gigabytes = bytes / (1024 ** 3)
  return Number.isFinite(gigabytes) ? Number(gigabytes.toFixed(2)) : 0
}

async function updateUsageGlobalStatsSnapshot(
  c: Context,
  window: DailyWindow,
  message: string,
  patch: GlobalStatsSnapshotPatch,
  logContext: Record<string, unknown>,
): Promise<void> {
  await updateGlobalStatsSnapshot(c, window.prevDayDateId, patch)
  cloudlog({
    requestId: c.get('requestId'),
    message,
    dateId: window.prevDayDateId,
    ...logContext,
  })
}

async function runUsageUpdatesGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  const updatesLastMonth = await readLastMonthUpdatesCF(c, window.prevDayEnd)
  await updateUsageGlobalStatsSnapshot(c, window, 'Updated global stats usage updates shard', { updates_last_month: updatesLastMonth }, { updatesLastMonth })
}

async function runUsageDevicesGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  const devicesLastMonth = await readLastMonthDevicesCF(c, window.prevDayEnd)
  await updateUsageGlobalStatsSnapshot(c, window, 'Updated global stats usage devices shard', { devices_last_month: devicesLastMonth }, { devicesLastMonth })
}

async function runUsageDevicePlatformsGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  const devicesByPlatform = await readLastMonthDevicesByPlatformCF(c, window.prevDayEnd)
  await updateUsageGlobalStatsSnapshot(c, window, 'Updated global stats usage device platforms shard', {
    devices_last_month_android: devicesByPlatform.android,
    devices_last_month_ios: devicesByPlatform.ios,
  }, { devicesByPlatform })
}

async function runUsageRegistrationsGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  const metricWindow = getMetricWindowFromDailyWindow(window)
  const registersToday = await getRegistersToday(c, metricWindow.dayStart.toISOString(), metricWindow.nextDayStart.toISOString())
  await updateUsageGlobalStatsSnapshot(c, window, 'Updated global stats usage registrations shard', { registers_today: registersToday }, { registersToday })
}

async function runUsageStorageGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  const bundleStorageGb = await getBundleStorageGb(c)
  await updateUsageGlobalStatsSnapshot(c, window, 'Updated global stats usage storage shard', { bundle_storage_gb: bundleStorageGb }, { bundleStorageGb })
}

async function runUsageSuccessRateGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  // Same device-day formula as public /data — not the 1-minute getUpdateStats health window.
  const successRate = await getDeviceDaySuccessRateCF(c, window.prevDayStart, window.prevDayEnd)
  await updateUsageGlobalStatsSnapshot(c, window, 'Updated global stats usage success rate shard', { success_rate: successRate }, { successRate })
}

async function runUsageDemoAppsGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  const metricWindow = getMetricWindowFromDailyWindow(window)
  const demoAppsCreated = await countDemoSeededApps(c, metricWindow.dayStart.toISOString(), metricWindow.nextDayStart.toISOString())
  await updateUsageGlobalStatsSnapshot(c, window, 'Updated global stats usage demo apps shard', { demo_apps_created: demoAppsCreated }, { demoAppsCreated })
}

function getTrailing12mStart(nextDayStart: Date): Date {
  const year = nextDayStart.getUTCFullYear() - 1
  const month = nextDayStart.getUTCMonth()
  const day = nextDayStart.getUTCDate()
  const clampedDay = Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate())
  return new Date(Date.UTC(
    year,
    month,
    clampedDay,
    nextDayStart.getUTCHours(),
    nextDayStart.getUTCMinutes(),
    nextDayStart.getUTCSeconds(),
    nextDayStart.getUTCMilliseconds(),
  ))
}

async function getUpgradeRate12m(
  c: Context,
  window: DailyWindow,
  todayUpgradedOrgs: number,
): Promise<number> {
  // Paying -> bigger plan only. Numerator is Stripe-sourced daily upgrade counts
  // (global_stats.upgraded_orgs), same as the backfill script. Do NOT use
  // stripe_info.upgraded_at here: that column is sparse/recent and crashes the
  // chart after each daily run. Add today's freshly counted upgrades because
  // today's global_stats row is not written yet.
  const nextDayStart = getMetricWindowFromDailyWindow(window).nextDayStart
  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)
  const snapshotEndIso = nextDayStart.toISOString()
  const trailingStartDateId = getTrailing12mStart(nextDayStart).toISOString().slice(0, 10)
  const todayDateId = window.prevDayDateId

  try {
    // Paying denominator matches getBillingSnapshotCounts (plans join + lifecycle filters),
    // not all orgs/users.
    const result = await drizzleClient.execute(sql`
      SELECT
        (
          SELECT COUNT(DISTINCT si.customer_id)::int
          FROM public.stripe_info si
          INNER JOIN public.plans p ON p.stripe_id = si.product_id
          WHERE si.is_good_plan = true
            AND si.created_at < ${snapshotEndIso}::timestamptz
            AND si.paid_at IS NOT NULL
            AND si.paid_at < ${snapshotEndIso}::timestamptz
            AND si.trial_at <= ${snapshotEndIso}::timestamptz
            AND si.status IN (
              'succeeded'::public.stripe_status,
              'canceled'::public.stripe_status,
              'deleted'::public.stripe_status
            )
            AND (si.canceled_at IS NULL OR si.canceled_at >= ${snapshotEndIso}::timestamptz)
            AND si.subscription_anchor_end > ${snapshotEndIso}::timestamptz
        ) AS paying,
        (
          SELECT COALESCE(SUM(gs.upgraded_orgs), 0)::int
          FROM public.global_stats gs
          WHERE gs.date_id >= ${trailingStartDateId}
            AND gs.date_id < ${todayDateId}
        ) AS prior_upgraded_orgs_12m
    `)
    const row = result.rows[0] as {
      paying?: number | string | null
      prior_upgraded_orgs_12m?: number | string | null
    } | undefined
    const upgradedOrgs12m = (Number(row?.prior_upgraded_orgs_12m) || 0) + (Number(todayUpgradedOrgs) || 0)
    return calculateConversionRate(upgradedOrgs12m, Number(row?.paying) || 0)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getUpgradeRate12m error', error })
    throw error
  }
  finally {
    closeClient(c, pgClient)
  }
}

async function runRevenueGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  const supabase = supabaseAdmin(c)
  const metricWindow = getMetricWindowFromDailyWindow(window)
  const { dayStart, nextDayStart } = metricWindow
  const dayStartIso = dayStart.toISOString()
  const nextDayStartIso = nextDayStart.toISOString()
  const pastDueSnapshot = await readGlobalStatsPastDueSnapshot(c, window.prevDayDateId)
  const refreshPastDueStats = shouldRefreshMutablePastDueStats(window, new Date(), pastDueSnapshot)
  const [
    revenue,
    new_paying_orgs,
    canceled_orgs,
    upgraded_orgs,
    trialExtensionStats,
    pastDueOrgStats,
    subscriptionAccessCounts,
    credits_bought,
    credits_consumed,
  ] = await Promise.all([
    calculateRevenue(c, window.prevDayEnd),
    Promise.all([
      supabase
        .from('stripe_info')
        .select('customer_id')
        .not('paid_at', 'is', null)
        .eq('is_good_plan', true)
        .gte('paid_at', dayStartIso)
        .lt('paid_at', nextDayStartIso),
      supabase
        .from('stripe_info')
        .select('customer_id')
        .is('paid_at', null)
        .in('status', REVENUE_ACTIVE_STRIPE_STATUSES)
        .eq('is_good_plan', true)
        .gte('created_at', dayStartIso)
        .lt('created_at', nextDayStartIso),
    ]).then(([paidToday, legacyFallback]) => {
      if (paidToday.error) {
        cloudlog({ requestId: c.get('requestId'), message: 'new_paying_orgs paid_at error', error: paidToday.error })
        return 0
      }
      if (legacyFallback.error) {
        cloudlog({ requestId: c.get('requestId'), message: 'new_paying_orgs legacy fallback error', error: legacyFallback.error })
        return 0
      }
      return countUniqueCustomers(paidToday.data || [], legacyFallback.data || [])
    }),
    supabase
      .from('stripe_info')
      .select('customer_id')
      .not('canceled_at', 'is', null)
      .gte('canceled_at', dayStartIso)
      .lt('canceled_at', nextDayStartIso)
      .then((res) => {
        if (res.error) {
          cloudlog({ requestId: c.get('requestId'), message: 'canceled_orgs error', error: res.error })
          return 0
        }
        return new Set((res.data || []).map(row => row.customer_id)).size
      }),
    supabase
      .from('stripe_info')
      .select('customer_id')
      .gte('upgraded_at', dayStartIso)
      .lt('upgraded_at', nextDayStartIso)
      .then((res) => {
        if (res.error) {
          cloudlog({ requestId: c.get('requestId'), message: 'upgraded_orgs error', error: res.error })
          return 0
        }
        return new Set((res.data || []).map(row => row.customer_id)).size
      }),
    getTrialExtensionStats(c, metricWindow),
    refreshPastDueStats
      ? (async () => {
          const res = await supabase
            .from('stripe_info')
            .select('customer_id, past_due_at, updated_at')
            .not('past_due_at', 'is', null)
            .lt('past_due_at', nextDayStartIso)

          if (res.error) {
            cloudlog({ requestId: c.get('requestId'), message: 'past_due_org_stats error', error: res.error })
            return { past_due_orgs: 0, past_due_orgs_average_days: 0 }
          }

          return calculatePastDueOrgStats((res.data || []) as PastDueOrgRow[], nextDayStart)
        })()
      : Promise.resolve({ past_due_orgs: 0, past_due_orgs_average_days: 0 }),
    refreshPastDueStats
      ? getSubscriptionAccessSnapshotCounts(c, nextDayStart)
      : Promise.resolve(getEmptySubscriptionAccessSnapshotCounts()),
    supabase
      .from('usage_credit_grants')
      .select('credits_total')
      .gte('granted_at', dayStartIso)
      .lt('granted_at', nextDayStartIso)
      .then((res) => {
        if (res.error) {
          cloudlog({ requestId: c.get('requestId'), message: 'credits_bought error', error: res.error })
          return 0
        }
        return (res.data || []).reduce((sum, row) => sum + (Number(row.credits_total) || 0), 0)
      }),
    supabase
      .from('usage_credit_consumptions')
      .select('credits_used')
      .gte('applied_at', dayStartIso)
      .lt('applied_at', nextDayStartIso)
      .then((res) => {
        if (res.error) {
          cloudlog({ requestId: c.get('requestId'), message: 'credits_consumed error', error: res.error })
          return 0
        }
        return (res.data || []).reduce((sum, row) => sum + (Number(row.credits_used) || 0), 0)
      }),
  ])

  const upgrade_rate_12m = await getUpgradeRate12m(c, window, upgraded_orgs)

  const snapshotPatch: GlobalStatsSnapshotPatch = {
    canceled_orgs,
    credits_bought: Math.round(credits_bought),
    credits_consumed: Math.round(credits_consumed),
    mrr: revenue.mrr,
    new_paying_orgs,
    plan_enterprise_monthly: revenue.plan_enterprise_monthly,
    plan_enterprise_yearly: revenue.plan_enterprise_yearly,
    plan_maker_monthly: revenue.plan_maker_monthly,
    plan_maker_yearly: revenue.plan_maker_yearly,
    plan_solo_monthly: revenue.plan_solo_monthly,
    plan_solo_yearly: revenue.plan_solo_yearly,
    plan_team_monthly: revenue.plan_team_monthly,
    plan_team_yearly: revenue.plan_team_yearly,
    revenue_enterprise: revenue.revenue_enterprise,
    revenue_maker: revenue.revenue_maker,
    revenue_solo: revenue.revenue_solo,
    revenue_team: revenue.revenue_team,
    trial_extended_orgs: trialExtensionStats.trial_extended_orgs,
    trial_extended_subscribed_orgs: trialExtensionStats.trial_extended_subscribed_orgs,
    total_revenue: revenue.total_revenue,
    upgrade_rate_12m,
    upgraded_orgs,
  }

  // stripe_info only stores current past_due_at; old replays must not overwrite historical values after recovery.
  if (refreshPastDueStats) {
    snapshotPatch.past_due_orgs = pastDueOrgStats.past_due_orgs
    snapshotPatch.past_due_orgs_average_days = pastDueOrgStats.past_due_orgs_average_days
    snapshotPatch.active_canceled_orgs = subscriptionAccessCounts.active_canceled_orgs
    snapshotPatch.active_past_due_orgs = subscriptionAccessCounts.active_past_due_orgs
  }

  await updateGlobalStatsSnapshot(c, window.prevDayDateId, snapshotPatch)

  cloudlog({ requestId: c.get('requestId'), message: 'Updated global stats revenue shard', dateId: window.prevDayDateId, mrr: revenue.mrr, new_paying_orgs, canceled_orgs })
}

async function runPluginsGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  const plugin_breakdown = await getPluginBreakdownCF(c, window.prevDayEnd)

  await updateGlobalStatsSnapshot(c, window.prevDayDateId, {
    plugin_major_breakdown: plugin_breakdown.major_breakdown,
    plugin_version_breakdown: plugin_breakdown.version_breakdown,
    plugin_version_ladder: plugin_breakdown.version_ladder as unknown as Json,
  })

  cloudlog({ requestId: c.get('requestId'), message: 'Updated global stats plugin shard', dateId: window.prevDayDateId })
}

async function runBuildsGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  const build_stats = await getBuildStats(c, window)

  await updateGlobalStatsSnapshot(c, window.prevDayDateId, {
    builds_android: build_stats.android,
    builds_ios: build_stats.ios,
    builds_last_month: build_stats.last_month,
    builds_last_month_android: build_stats.last_month_android,
    builds_last_month_ios: build_stats.last_month_ios,
    builds_success_android: build_stats.success_android,
    builds_success_ios: build_stats.success_ios,
    builds_success_total: build_stats.success_total,
    builds_total: build_stats.total,
  })

  if (build_stats.daily_metrics_available) {
    const { error: buildMetricsError } = await supabaseAdmin(c)
      .from('global_stats')
      .update({
        build_total_seconds_day_ios: build_stats.total_seconds_day_ios,
        build_total_seconds_day_android: build_stats.total_seconds_day_android,
        build_avg_seconds_day_ios: build_stats.avg_seconds_day_ios,
        build_avg_seconds_day_android: build_stats.avg_seconds_day_android,
        build_count_day_ios: build_stats.build_count_day_ios,
        build_count_day_android: build_stats.build_count_day_android,
      })
      .eq('date_id', window.prevDayDateId)

    if (buildMetricsError) {
      if (isMissingBuildMetricColumnError(buildMetricsError)) {
        const { error: legacyBuildMetricsError } = await supabaseAdmin(c)
          .from('global_stats')
          .update({
            build_minutes_day_ios: build_stats.total_seconds_day_ios / 60,
            build_minutes_day_android: build_stats.total_seconds_day_android / 60,
            builds_day_ios: build_stats.build_count_day_ios,
            builds_day_android: build_stats.build_count_day_android,
          } as any)
          .eq('date_id', window.prevDayDateId)

        if (legacyBuildMetricsError)
          throw legacyBuildMetricsError
      }
      else {
        throw buildMetricsError
      }
    }
  }
  else {
    cloudlog({ requestId: c.get('requestId'), message: 'Skipping build metric update because daily aggregation failed' })
  }

  cloudlog({ requestId: c.get('requestId'), message: 'Updated global stats builds shard', dateId: window.prevDayDateId, builds_total: build_stats.total })
}

async function runRetentionGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  const retention_metrics = await getRevenueRetentionMetrics(c, window.prevDayDateId)

  await updateGlobalStatsSnapshot(c, window.prevDayDateId, {
    churn_revenue: retention_metrics.churnRevenue,
    churn_revenue_enterprise: retention_metrics.churnRevenueEnterprise,
    churn_revenue_maker: retention_metrics.churnRevenueMaker,
    churn_revenue_solo: retention_metrics.churnRevenueSolo,
    churn_revenue_team: retention_metrics.churnRevenueTeam,
    nrr: retention_metrics.nrr,
  })

  cloudlog({ requestId: c.get('requestId'), message: 'Updated global stats retention shard', dateId: window.prevDayDateId, nrr: retention_metrics.nrr })
}

async function runPaidProductsGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  const paid_product_activity_stats = await getPaidProductActivityStats(c, getMetricWindowFromDailyWindow(window))

  await updateGlobalStatsSnapshot(c, window.prevDayDateId, {
    builder_active_paying_clients_60d: paid_product_activity_stats.builder_active_paying_clients_60d,
    live_updates_active_paying_clients_60d: paid_product_activity_stats.live_updates_active_paying_clients_60d,
  })

  cloudlog({ requestId: c.get('requestId'), message: 'Updated global stats paid products shard', dateId: window.prevDayDateId })
}

async function runLtvGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  const ltv_stats = await getLtvStats(c, getMetricWindowFromDailyWindow(window))

  await updateGlobalStatsSnapshot(c, window.prevDayDateId, {
    average_ltv: ltv_stats.average_ltv,
    longest_ltv: ltv_stats.longest_ltv,
    shortest_ltv: ltv_stats.shortest_ltv,
  })

  cloudlog({ requestId: c.get('requestId'), message: 'Updated global stats ltv shard', dateId: window.prevDayDateId, average_ltv: ltv_stats.average_ltv })
}

async function readGlobalStatsSnapshot(c: Context, dateId: string): Promise<GlobalStatsSnapshotRow> {
  const { data, error } = await supabaseAdmin(c)
    .from('global_stats')
    .select('*')
    .eq('date_id', dateId)
    .single()

  if (error || !data)
    quickError(503, 'global_stats_snapshot_not_ready', 'Global stats snapshot is not ready', { dateId }, error, { alert: false })

  return data as GlobalStatsSnapshotRow
}

async function readGlobalStatsPastDueSnapshot(c: Context, dateId: string): Promise<MutableSubscriptionHealthSnapshot | null> {
  const { data, error } = await supabaseAdmin(c)
    .from('global_stats')
    .select('past_due_orgs, past_due_orgs_average_days, active_canceled_orgs, active_past_due_orgs')
    .eq('date_id', dateId)
    .maybeSingle()

  if (error)
    throw error

  return data as MutableSubscriptionHealthSnapshot | null
}

function getNumber(value: number | null | undefined): number {
  return Number(value) || 0
}

interface NativeNotificationGlobalStats {
  apps: number
  providers: number
  campaigns: number
  campaigns_day: number
  sent_day: number
  received_day: number
  opened_day: number
  failed_day: number
  sent_last_month: number
  opened_last_month: number
}

function countNotificationEvent(rows: { event: string, count: number }[], event: string): number {
  return rows.reduce((sum, row) => sum + (row.event === event ? Number(row.count) || 0 : 0), 0)
}

async function getNativeNotificationGlobalStats(c: Context, window: DailyWindow): Promise<NativeNotificationGlobalStats> {
  const dayStartIso = window.prevDayStart.toISOString()
  const dayEndIso = window.prevDayEnd.toISOString()
  const lastMonthStart = new Date(window.prevDayEnd.getTime() - 30 * 24 * 60 * 60 * 1000)

  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const result = await drizzleClient.execute<{
      apps: number
      providers: number
      campaigns: number
      campaigns_day: number
    }>(sql`
      SELECT
        (
          SELECT COUNT(DISTINCT app_id)::int
          FROM public.notification_provider_configs
          WHERE status = 'configured'
            AND created_at < ${dayEndIso}::timestamptz
        ) AS apps,
        (
          SELECT COUNT(*)::int
          FROM public.notification_provider_configs
          WHERE status = 'configured'
            AND created_at < ${dayEndIso}::timestamptz
        ) AS providers,
        (
          SELECT COUNT(*)::int
          FROM public.notification_campaigns
          WHERE created_at < ${dayEndIso}::timestamptz
        ) AS campaigns,
        (
          SELECT COUNT(*)::int
          FROM public.notification_campaigns
          WHERE created_at >= ${dayStartIso}::timestamptz
            AND created_at < ${dayEndIso}::timestamptz
        ) AS campaigns_day
    `)
    const row = result.rows[0] ?? { apps: 0, providers: 0, campaigns: 0, campaigns_day: 0 }

    const [dayRows, monthRows] = await Promise.all([
      readGlobalNotificationStatsCF(c, { since: window.prevDayStart, until: window.prevDayEnd, throwOnError: true }),
      readGlobalNotificationStatsCF(c, { since: lastMonthStart, until: window.prevDayEnd, throwOnError: true }),
    ])

    return {
      apps: Number(row.apps) || 0,
      providers: Number(row.providers) || 0,
      campaigns: Number(row.campaigns) || 0,
      campaigns_day: Number(row.campaigns_day) || 0,
      sent_day: countNotificationEvent(dayRows, 'sent'),
      received_day: countNotificationEvent(dayRows, 'received'),
      opened_day: countNotificationEvent(dayRows, 'opened'),
      failed_day: countNotificationEvent(dayRows, 'failed'),
      sent_last_month: countNotificationEvent(monthRows, 'sent'),
      opened_last_month: countNotificationEvent(monthRows, 'opened'),
    }
  }
  finally {
    if (pgClient)
      closeClient(c, pgClient)
  }
}

async function runNativeNotificationsGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  const stats = await getNativeNotificationGlobalStats(c, window)

  await updateGlobalStatsSnapshot(c, window.prevDayDateId, {
    notifications_apps: stats.apps,
    notifications_providers: stats.providers,
    notifications_campaigns: stats.campaigns,
    notifications_campaigns_day: stats.campaigns_day,
    notifications_sent_day: stats.sent_day,
    notifications_received_day: stats.received_day,
    notifications_opened_day: stats.opened_day,
    notifications_failed_day: stats.failed_day,
    notifications_sent_last_month: stats.sent_last_month,
    notifications_opened_last_month: stats.opened_last_month,
  })

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Updated global stats native_notifications shard',
    dateId: window.prevDayDateId,
    notifications_apps: stats.apps,
    notifications_sent_day: stats.sent_day,
  })
}

async function runNotificationsGlobalStatsShard(c: Context, window: DailyWindow): Promise<void> {
  const notificationClaim = await claimGlobalStatsNotificationDelivery(c, window.prevDayDateId)
  if (!notificationClaim) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Skipping claimed global stats notification shard',
      dateId: window.prevDayDateId,
    })
    return
  }

  try {
    const completedShards = await readCompletedGlobalStatsShards(c, window.prevDayDateId)
    if (hasCompletedGlobalStatsNotifications(completedShards)) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'Skipping completed global stats notification shard',
        dateId: window.prevDayDateId,
        completedShards: Array.from(completedShards).sort((a, b) => a.localeCompare(b)),
      })
      return
    }

    const snapshot = await readGlobalStatsSnapshot(c, window.prevDayDateId)

    const apps = getNumber(snapshot.apps)
    const users = getNumber(snapshot.users)
    const orgs = getNumber(snapshot.orgs)
    const missingShards = getMissingGlobalStatsRequiredShards(completedShards)
    if (apps <= 0 || users <= 0 || orgs <= 0 || missingShards.length > 0) {
      quickError(503, 'global_stats_snapshot_not_ready', 'Global stats snapshot is not ready', {
        dateId: window.prevDayDateId,
        apps,
        users,
        orgs,
        completedShards: Array.from(completedShards),
        missingShards,
      }, undefined, { alert: false })
    }

    const bundle_storage_gb = getNumber(snapshot.bundle_storage_gb)
    const success_rate = getNumber(snapshot.success_rate)
    const org_conversion_rate = getNumber(snapshot.org_conversion_rate)
    await runGlobalStatsNotificationProviderStep(
      c,
      window.prevDayDateId,
      'tracking',
      completedShards,
      GLOBAL_STATS_NOTIFICATION_TRACKING_STEP,
      GLOBAL_STATS_NOTIFICATION_TRACKING_CLAIM,
      async () => {
        await sendEventToTracking(c, {
          channel: 'updates-stats',
          event: 'Updates last month',
          user_id: 'admin',
          tags: {
            updates_last_month: getNumber(snapshot.updates_last_month),
            success_rate,
            registers_today: getNumber(snapshot.registers_today),
            storage_gb: bundle_storage_gb,
            org_conversion_rate,
          },
        }, { background: false, strict: true })
      },
    )

    await markGlobalStatsShardComplete(c, window.prevDayDateId, 'notifications')
    cloudlog({ requestId: c.get('requestId'), message: 'Sent global stats tracking event from snapshot', dateId: window.prevDayDateId })
  }
  finally {
    await releaseGlobalStatsNotificationDeliveryClaim(c, notificationClaim, window.prevDayDateId)
  }
}

function scheduleGlobalStatsUpdate(
  c: Context,
  runUpdate: (c: Context) => Promise<void> = runGlobalStatsUpdate,
  options: ScheduleGlobalStatsUpdateOptions = {},
) {
  const retryCount = options.retryCount ?? 0
  const retryMsgId = options.retryMsgId ?? null
  const cancelRetry = options.cancelRetry ?? cancelGlobalStatsRetry
  let updateSucceeded = false
  const task = Promise.resolve()
    .then(() => runUpdate(c))
    .then(async () => {
      updateSucceeded = true
      if (retryMsgId === null)
        return
      await cancelRetry(c, retryMsgId)
    })
    .catch(async (error: unknown) => {
      cloudlogErr({ requestId: c.get('requestId'), message: 'global stats background task failed', retryCount, retryMsgId, updateSucceeded, error })
      if (retryMsgId !== null && !updateSucceeded)
        return
      if (retryMsgId !== null)
        throw error
      if (retryCount >= GLOBAL_STATS_BACKGROUND_MAX_RETRIES) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'global stats background retry budget exhausted', retryCount, error })
        throw error
      }
    })

  if (retryMsgId === null && retryCount >= GLOBAL_STATS_BACKGROUND_MAX_RETRIES)
    return task

  return backgroundTask(c, task)
}

export const globalStatsTestUtils = {
  buildGlobalStatsRetryMessage,
  buildGlobalStatsShardMessage,
  readGlobalStatsPayload,
  REVENUE_ACTIVE_STRIPE_STATUSES,
  GLOBAL_STATS_BACKGROUND_MAX_RETRIES,
  GLOBAL_STATS_NOTIFICATION_LOCK_NAMESPACE,
  USAGE_GLOBAL_STATS_SHARDS,
  calculatePastDueOrgStats,
  calculateSubscriptionAccessSnapshotCounts,
  isActiveCanceledAtSnapshot,
  isActivePastDueAtSnapshot,
  normalizeSubscriptionAccessSnapshotCounts,
  shouldRefreshMutablePastDueStats,
  calculateChurnRevenue,
  calculateConversionRate,
  calculateNrr,
  getPlanConversionRates,
  getPaidPlanTotal,
  getUpgradeRate12m,
  getTrailing12mStart,
  countUniqueCustomers,
  getCompletedDayWindowForDateId,
  getMetricWindowFromDailyWindow,
  getCompletedAppBuildOnboardingWindow,
  getMissingGlobalStatsRequiredShards,
  getMissingGlobalStatsShards,
  getGlobalStatsShardQueueCandidates,
  getGlobalStatsRepairShardQueueCandidates,
  getGlobalStatsStaleRepairShards,
  isGlobalStatsBuildShardStale,
  getEmptyBuildShardStats,
  buildRecentGlobalStatsRepairDateIds,
  hasCompletedGlobalStatsNotifications,
  shouldSkipCompletedGlobalStatsShardRetry,
  summarizeAppBuildOnboardingRows,
  getGlobalStatsNotificationStepAction,
  normalizeCompletedGlobalStatsShards,
  getGlobalStatsShardFunctionName,
  getCompletedDayWindow,
  getCurrentDayWindow,
  getPreviousDateId,
  normalizeGlobalStatsDateId,
  normalizeGlobalStatsShard,
  normalizeGlobalStatsRetryCount,
  normalizePlanTotals,
  normalizeBillingSnapshotCounts,
  isUnpaidAtBillingSnapshot,
  isPaidPlanAtBillingSnapshot,
  resolvePlanBillingInterval,
  resolvePlanMrrDollars,
  hasLeftTrialAtSnapshot,
  normalizeCoreSnapshotCounts,
  getBillingSnapshotCounts,
  getCoreSnapshotCounts,
  reserveGlobalStatsRetry,
  reserveGlobalStatsShardRetry,
  scheduleGlobalStatsUpdate,
  scheduleGlobalStatsShardUpdate,
}

export const app = new Hono<MiddlewareKeyVariables>()

async function runGlobalStatsShard(c: Context, shard: GlobalStatsShard, dateId: string): Promise<void> {
  const completedShards = await readCompletedGlobalStatsShards(c, dateId)
  if (await shouldSkipGlobalStatsShardUpdate(c, dateId, completedShards, shard)) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Skipping completed global stats shard retry',
      shard,
      dateId,
    })
    return
  }

  const window = getCompletedDayWindowForDateId(dateId)

  switch (shard) {
    case 'core':
      await runCoreGlobalStatsShard(c, window)
      await markGlobalStatsShardComplete(c, dateId, shard)
      return
    case 'usage_updates':
      await runUsageUpdatesGlobalStatsShard(c, window)
      await markGlobalStatsShardComplete(c, dateId, shard)
      return
    case 'usage_devices':
      await runUsageDevicesGlobalStatsShard(c, window)
      await markGlobalStatsShardComplete(c, dateId, shard)
      return
    case 'usage_device_platforms':
      await runUsageDevicePlatformsGlobalStatsShard(c, window)
      await markGlobalStatsShardComplete(c, dateId, shard)
      return
    case 'usage_registrations':
      await runUsageRegistrationsGlobalStatsShard(c, window)
      await markGlobalStatsShardComplete(c, dateId, shard)
      return
    case 'usage_storage':
      await runUsageStorageGlobalStatsShard(c, window)
      await markGlobalStatsShardComplete(c, dateId, shard)
      return
    case 'usage_success_rate':
      await runUsageSuccessRateGlobalStatsShard(c, window)
      await markGlobalStatsShardComplete(c, dateId, shard)
      return
    case 'usage_demo_apps':
      await runUsageDemoAppsGlobalStatsShard(c, window)
      await markGlobalStatsShardComplete(c, dateId, shard)
      return
    case 'revenue':
      await runRevenueGlobalStatsShard(c, window)
      await markGlobalStatsShardComplete(c, dateId, shard)
      return
    case 'plugins':
      await runPluginsGlobalStatsShard(c, window)
      await markGlobalStatsShardComplete(c, dateId, shard)
      return
    case 'builds':
      await runBuildsGlobalStatsShard(c, window)
      await markGlobalStatsShardComplete(c, dateId, shard)
      return
    case 'retention':
      await runRetentionGlobalStatsShard(c, window)
      await markGlobalStatsShardComplete(c, dateId, shard)
      return
    case 'paid_products':
      await runPaidProductsGlobalStatsShard(c, window)
      await markGlobalStatsShardComplete(c, dateId, shard)
      return
    case 'ltv':
      await runLtvGlobalStatsShard(c, window)
      await markGlobalStatsShardComplete(c, dateId, shard)
      return
    case 'notifications':
      await runNotificationsGlobalStatsShard(c, window)
      return
    case 'native_notifications':
      await runNativeNotificationsGlobalStatsShard(c, window)
      await markGlobalStatsShardComplete(c, dateId, shard)
  }
}

function scheduleGlobalStatsShardUpdate(
  c: Context,
  shard: GlobalStatsShard,
  dateId: string,
  options: ScheduleGlobalStatsShardOptions = {},
) {
  const retryCount = options.retryCount ?? 0
  const retryMsgId = options.retryMsgId ?? null
  const cancelRetry = options.cancelRetry ?? cancelGlobalStatsRetry
  const runShard = options.runShard ?? runGlobalStatsShard
  let updateSucceeded = false
  const task = Promise.resolve()
    .then(() => runShard(c, shard, dateId))
    .then(async () => {
      updateSucceeded = true
      if (retryMsgId === null)
        return
      await cancelRetry(c, retryMsgId)
    })
    .catch(async (error: unknown) => {
      cloudlogErr({ requestId: c.get('requestId'), message: 'global stats shard background task failed', shard, dateId, retryCount, retryMsgId, updateSucceeded, error })
      if (retryMsgId !== null && !updateSucceeded)
        return
      if (retryMsgId !== null)
        throw error
      if (retryCount >= GLOBAL_STATS_BACKGROUND_MAX_RETRIES) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'global stats shard background retry budget exhausted', shard, dateId, retryCount, error })
        throw error
      }
    })

  if (retryMsgId === null && retryCount >= GLOBAL_STATS_BACKGROUND_MAX_RETRIES)
    return task

  return backgroundTask(c, task)
}

async function runGlobalStatsUpdate(c: Context, dateId = getDailyWindow().prevDayDateId, retryCount = 0): Promise<void> {
  await repairRecentMissingGlobalStatsSnapshots(c, dateId)
  if (await shouldSkipCompletedGlobalStatsRetryDispatch(c, dateId, retryCount))
    return

  if (retryCount > 0) {
    await dispatchMissingGlobalStatsShards(c, dateId)
    return
  }

  await dispatchGlobalStatsShards(c, dateId)
}

function resolveGlobalStatsSnapshotDateId(payload: GlobalStatsPayload): string {
  const payloadDateId = normalizeGlobalStatsDateId(payload.date_id)
  if (payload.date_id !== undefined && payloadDateId === null)
    quickError(400, 'invalid_global_stats_date_id', 'Invalid global stats date_id', { date_id: payload.date_id }, undefined, { alert: false })

  return payloadDateId ?? getDailyWindow().prevDayDateId
}

async function scheduleGlobalStatsShardRequest(c: Context, shard: GlobalStatsShard, snapshotDateId: string, retryCount: number): Promise<void> {
  let retryMsgId: number | null = null

  try {
    retryMsgId = await reserveGlobalStatsShardRetry(c, shard, snapshotDateId, retryCount)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to reserve global stats shard retry', shard, retryCount, dateId: snapshotDateId, error })
    quickError(503, 'global_stats_shard_retry_reserve_failed', 'Failed to reserve global stats shard retry', { shard, retryCount, dateId: snapshotDateId }, error, { alert: false })
  }

  await scheduleGlobalStatsShardUpdate(c, shard, snapshotDateId, {
    retryCount,
    retryMsgId,
  })
}

function createGlobalStatsShardApp(shard: GlobalStatsShard): Hono<MiddlewareKeyVariables> {
  const shardApp = new Hono<MiddlewareKeyVariables>()

  shardApp.post('/', middlewareAPISecret, async (c) => {
    const payload = await readGlobalStatsPayload(c)
    const snapshotDateId = resolveGlobalStatsSnapshotDateId(payload)
    const retryCount = normalizeGlobalStatsRetryCount(payload.retry_count)

    if (payload.shard !== undefined) {
      const payloadShard = normalizeGlobalStatsShard(payload.shard)
      if (payloadShard !== shard)
        quickError(400, 'invalid_global_stats_shard', 'Invalid global stats shard', { shard: payload.shard, expected: shard }, undefined, { alert: false })
    }

    await scheduleGlobalStatsShardRequest(c, shard, snapshotDateId, retryCount)
    return c.json(BRES, 202)
  })

  return shardApp
}

export const globalStatsLegacyUsageApp = new Hono<MiddlewareKeyVariables>()

globalStatsLegacyUsageApp.post('/', middlewareAPISecret, async (c) => {
  const payload = await readGlobalStatsPayload(c)
  const snapshotDateId = resolveGlobalStatsSnapshotDateId(payload)
  await dispatchMissingGlobalStatsUsageShards(c, snapshotDateId)
  return c.json(BRES, 202)
})

export const globalStatsShardApps: Record<GlobalStatsShard, Hono<MiddlewareKeyVariables>> = {
  core: createGlobalStatsShardApp('core'),
  usage_updates: createGlobalStatsShardApp('usage_updates'),
  usage_devices: createGlobalStatsShardApp('usage_devices'),
  usage_device_platforms: createGlobalStatsShardApp('usage_device_platforms'),
  usage_registrations: createGlobalStatsShardApp('usage_registrations'),
  usage_storage: createGlobalStatsShardApp('usage_storage'),
  usage_success_rate: createGlobalStatsShardApp('usage_success_rate'),
  usage_demo_apps: createGlobalStatsShardApp('usage_demo_apps'),
  revenue: createGlobalStatsShardApp('revenue'),
  plugins: createGlobalStatsShardApp('plugins'),
  builds: createGlobalStatsShardApp('builds'),
  retention: createGlobalStatsShardApp('retention'),
  paid_products: createGlobalStatsShardApp('paid_products'),
  ltv: createGlobalStatsShardApp('ltv'),
  notifications: createGlobalStatsShardApp('notifications'),
  native_notifications: createGlobalStatsShardApp('native_notifications'),
}

app.post('/', middlewareAPISecret, async (c) => {
  const payload = await readGlobalStatsPayload(c)
  const snapshotDateId = resolveGlobalStatsSnapshotDateId(payload)
  const retryCount = normalizeGlobalStatsRetryCount(payload.retry_count)

  if (payload.shard !== undefined) {
    const shard = normalizeGlobalStatsShard(payload.shard)
    if (shard === null)
      quickError(400, 'invalid_global_stats_shard', 'Invalid global stats shard', { shard: payload.shard }, undefined, { alert: false })

    await scheduleGlobalStatsShardRequest(c, shard, snapshotDateId, retryCount)
    return c.json(BRES, 202)
  }

  let retryMsgId: number | null = null

  try {
    // Reserve the next delayed dispatcher retry before returning 202 so queue_consumer can acknowledge the current message safely.
    retryMsgId = await reserveGlobalStatsRetry(c, retryCount, snapshotDateId)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to reserve global stats dispatcher retry', retryCount, dateId: snapshotDateId, error })
    quickError(503, 'global_stats_retry_reserve_failed', 'Failed to reserve global stats retry', { retryCount, dateId: snapshotDateId }, error, { alert: false })
  }

  await scheduleGlobalStatsUpdate(c, context => runGlobalStatsUpdate(context, snapshotDateId, retryCount), {
    retryCount,
    retryMsgId,
  })
  return c.json(BRES, 202)
})
