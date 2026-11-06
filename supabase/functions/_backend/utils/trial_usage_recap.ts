import type { PgClient } from './pg.ts'
import { queryJson } from './pg_rls.ts'

/** Minimum points to show the usage recap variant instead of onboarding help. */
export const TRIAL_USAGE_RECAP_LOW_THRESHOLD = 3

export type TrialUsageRecapKind = 'trial_usage_recap' | 'trial_end_usage_recap'

/** Dedup id for Bento once send and org_notifications claims (one send per org per trial window per email kind). */
export function trialUsageRecapUniqId(
  kind: TrialUsageRecapKind,
  orgId: string,
  trialEndDate: string,
): string {
  const tail = `${orgId}:${trialEndDate}`
  return kind === 'trial_usage_recap' ? `trial_usage_recap:${tail}` : `trial_end_usage_recap:${tail}`
}

export interface TrialUsageRecapDisplayInputs {
  successful_updates: number
  failed_updates: number
  bandwidth_bytes: bigint | number
  peak_daily_mau: number
  bundles_uploaded: number
  deploy_count: number
  native_builds_run: number
  channels_count: number
  apps_count: number
}

/** Hides zero metrics in templates so we never celebrate empty stats. */
export function trialUsageRecapDisplayFlags(input: TrialUsageRecapDisplayInputs): Pick<
  TrialUsageRecapPayload,
  | 'show_successful_updates'
  | 'show_bandwidth'
  | 'show_peak_mau'
  | 'show_bundles_uploaded'
  | 'show_deploy_count'
  | 'show_native_builds'
  | 'show_channels_count'
  | 'show_apps_count'
> {
  let bw: bigint
  if (typeof input.bandwidth_bytes === 'bigint') {
    bw = input.bandwidth_bytes
  }
  else {
    const n = Number(input.bandwidth_bytes)
    bw = Number.isFinite(n) ? BigInt(Math.max(0, Math.trunc(n))) : 0n
  }
  return {
    show_successful_updates: input.successful_updates > 0,
    show_bandwidth: bw > 0n,
    show_peak_mau: input.peak_daily_mau > 0,
    show_bundles_uploaded: input.bundles_uploaded > 0,
    show_deploy_count: input.deploy_count > 0,
    show_native_builds: input.native_builds_run > 0,
    show_channels_count: input.channels_count > 0,
    show_apps_count: input.apps_count > 0,
  }
}

export interface TrialUsageMetricsRow {
  mau: bigint | number | null
  storage: bigint | number | null
  bandwidth: bigint | number | null
  build_time_unit: bigint | number | null
  get: bigint | number | null
  fail: bigint | number | null
  install: bigint | number | null
  uninstall: bigint | number | null
}

export interface TrialUsageCounts {
  apps: number
  channels: number
  bundles_uploaded: number
  deploys: number
  native_builds: number
  peak_daily_mau: number
}

export interface TrialUsageRecapPayload {
  org_id: string
  kind: TrialUsageRecapKind
  trial_end_date: string
  trial_end_date_label: string
  variant: 'usage' | 'low_usage'
  low_usage_score: number
  /** ISO date range inclusive for stats (UTC dates). */
  metrics_start_date: string
  metrics_end_date: string
  successful_updates: number
  failed_updates: number
  bandwidth_bytes: number
  bandwidth_human: string
  peak_daily_mau: number
  bundles_uploaded: number
  native_builds_run: number
  channels_count: number
  apps_count: number
  deploy_count: number
  show_pay_as_you_go: boolean
  plans_url: string
  usage_url: string
  docs_cli_url: string
  docs_upload_url: string
  docs_channels_url: string
  show_successful_updates: boolean
  show_bandwidth: boolean
  show_peak_mau: boolean
  show_bundles_uploaded: boolean
  show_deploy_count: boolean
  show_native_builds: boolean
  show_channels_count: boolean
  show_apps_count: boolean
}

/** Coerces numeric DB metrics to bigint, treating null as zero. */
function toBigIntish(value: bigint | number | null | undefined): bigint {
  if (value == null)
    return 0n
  return BigInt(value)
}

/** Human readable byte size for email copy. */
function formatBytes(bytes: bigint): string {
  const b = Number(bytes)
  if (!Number.isFinite(b) || b === 0)
    return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(b) / Math.log(k)))
  return `${Number.parseFloat((b / k ** i).toFixed(2))} ${sizes[i]}`
}

/** UTC calendar date YYYY-MM-DD from a timestamptz ISO string (never the local prefix of the stored string). */
export function utcCalendarDateFromIso(iso: string): string | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t))
    return null
  return new Date(t).toISOString().slice(0, 10)
}

/**
 * Calendar dates in UTC derived from org creation and trial end (stripe_info.trial_at).
 * Plugin gate ends at the start of trial_at UTC day, so the last included metrics day is one day before.
 */
export function trialUsageMetricsDateRange(orgCreatedAtIso: string, trialAtIso: string): { startDate: string, endDate: string } | null {
  const start = utcCalendarDateFromIso(orgCreatedAtIso)
  const trialEndDay = utcCalendarDateFromIso(trialAtIso)
  if (!start || !trialEndDay)
    return null
  const end = addDaysUtcDateOnly(trialEndDay, -1)
  if (end < start)
    return { startDate: start, endDate: start }
  return { startDate: start, endDate: end }
}

/** Adds `days` to a UTC calendar `YYYY-MM-DD` without local timezone shifts. */
function addDaysUtcDateOnly(dateOnly: string, days: number): string {
  const [y, m, d] = dateOnly.split('-').map(Number)
  const t = Date.UTC(y, (m ?? 1) - 1, d ?? 1)
  const next = new Date(t + days * 86_400_000)
  return next.toISOString().slice(0, 10)
}

/** Score from eight signals; below `TRIAL_USAGE_RECAP_LOW_THRESHOLD` sends the onboarding help template. */
function lowUsageScore(counts: TrialUsageCounts, successfulUpdates: number, failedUpdates: number): number {
  let score = 0
  if (successfulUpdates > 0)
    score += 1
  if (failedUpdates > 0)
    score += 1
  if (counts.bundles_uploaded > 0)
    score += 1
  if (counts.deploys > 0)
    score += 1
  if (counts.native_builds > 0)
    score += 1
  if (counts.apps > 0)
    score += 1
  if (counts.channels > 0)
    score += 1
  if (counts.peak_daily_mau > 0)
    score += 1
  return score
}

/** Picks the high usage recap versus low usage onboarding branch from `lowUsageScore`. */
export function trialUsageVariant(
  counts: TrialUsageCounts,
  successfulUpdates: number,
  failedUpdates: number,
): { variant: 'usage' | 'low_usage', score: number } {
  const score = lowUsageScore(counts, successfulUpdates, failedUpdates)
  return {
    variant: score >= TRIAL_USAGE_RECAP_LOW_THRESHOLD ? 'usage' : 'low_usage',
    score,
  }
}

/** True when peak org daily MAU is under 500 so pay as you go CTA copy may apply. */
export function payAsYouGoEligiblePeakMau(peakDailyMau: number): boolean {
  return peakDailyMau < 500
}

/**
 * Loads Bento event fields for trial recap emails: org scoped metrics, variant flags,
 * and console URLs. Throws on org or stripe trial mismatch with the queued `trialEndDate`.
 */
export async function loadTrialUsageRecapPayload(
  pg: PgClient,
  orgId: string,
  kind: TrialUsageRecapKind,
  trialEndDateFromPayload: string,
  consoleBaseUrl: string,
): Promise<TrialUsageRecapPayload> {
  const orgRows = await queryJson<{ created_at: string }>(
    pg,
    'SELECT created_at FROM public.orgs WHERE id = $1 LIMIT 2',
    [orgId],
  )
  if (orgRows.length !== 1)
    throw new Error('org_not_found')

  const stripeRows = await queryJson<{ trial_at: string | null }>(
    pg,
    'SELECT trial_at FROM public.stripe_info si INNER JOIN public.orgs o ON o.customer_id = si.customer_id WHERE o.id = $1 LIMIT 2',
    [orgId],
  )
  if (stripeRows.length !== 1 || !stripeRows[0]?.trial_at)
    throw new Error('stripe_trial_missing')

  const orgCreatedAt = orgRows[0].created_at
  const trialAt = stripeRows[0].trial_at
  const range = trialUsageMetricsDateRange(orgCreatedAt, trialAt)
  if (!range)
    throw new Error('trial_range_invalid')

  const trialEndDate = trialEndDateFromPayload
  const trialAtDay = utcCalendarDateFromIso(trialAt)
  if (!trialAtDay || trialAtDay !== trialEndDate)
    throw new Error('trial_end_date_mismatch')

  const metricsRows = await queryJson<TrialUsageMetricsRow>(
    pg,
    'SELECT * FROM public.get_total_metrics(org_id => $1::uuid, start_date => $2::date, end_date => $3::date)',
    [orgId, range.startDate, range.endDate],
  )
  const metrics = metricsRows.length === 1 ? metricsRows[0] : null

  const install = metrics ? Number(toBigIntish(metrics.install)) : 0
  const fail = metrics ? Number(toBigIntish(metrics.fail)) : 0
  const successfulUpdates = Math.max(0, install)
  const failedUpdates = Math.max(0, fail)
  const bandwidthBytes = metrics ? toBigIntish(metrics.bandwidth) : 0n

  const peakRow = await queryJson<{ peak: string | number | null }>(
    pg,
    `SELECT COALESCE(MAX(daily_total), 0)::bigint AS peak
     FROM (
       SELECT dm.date AS d, SUM(dm.mau)::bigint AS daily_total
       FROM public.daily_mau dm
       INNER JOIN public.apps a ON a.app_id = dm.app_id
       WHERE a.owner_org = $1
         AND dm.date >= $2::date
         AND dm.date <= $3::date
       GROUP BY dm.date
     ) t`,
    [orgId, range.startDate, range.endDate],
  )
  const peakDailyMau = peakRow.length === 1 ? Math.max(0, Math.round(Number(peakRow[0].peak ?? 0))) : 0

  const orgCreatedDay = utcCalendarDateFromIso(orgCreatedAt)
  if (!orgCreatedDay)
    throw new Error('org_created_invalid')
  const orgCreatedStartUtc = `${orgCreatedDay}T00:00:00.000Z`

  const bundleRow = await queryJson<{ c: string | number | null }>(
    pg,
    `SELECT COUNT(*)::bigint AS c FROM public.app_versions av
     WHERE av.owner_org = $1
       AND av.created_at >= $2::timestamptz
       AND av.created_at < $3::timestamptz`,
    [orgId, orgCreatedStartUtc, trialAt],
  )
  const bundlesUploaded = bundleRow.length === 1 ? Math.max(0, Math.round(Number(bundleRow[0].c ?? 0))) : 0

  const deployRow = await queryJson<{ c: string | number | null }>(
    pg,
    `SELECT COUNT(*)::bigint AS c FROM public.deploy_history dh
     INNER JOIN public.apps a ON a.app_id = dh.app_id
     WHERE a.owner_org = $1
       AND dh.deployed_at >= $2::timestamptz
       AND dh.deployed_at < $3::timestamptz`,
    [orgId, orgCreatedStartUtc, trialAt],
  )
  const deployCount = deployRow.length === 1 ? Math.max(0, Math.round(Number(deployRow[0].c ?? 0))) : 0

  const buildRow = await queryJson<{ c: string | number | null }>(
    pg,
    `SELECT COUNT(*)::bigint AS c FROM public.build_requests br
     WHERE br.owner_org = $1
       AND br.started_at IS NOT NULL
       AND br.started_at >= $2::timestamptz
       AND br.started_at < $3::timestamptz`,
    [orgId, orgCreatedStartUtc, trialAt],
  )
  const nativeBuilds = buildRow.length === 1 ? Math.max(0, Math.round(Number(buildRow[0].c ?? 0))) : 0

  const appRow = await queryJson<{ c: string | number | null }>(
    pg,
    'SELECT COUNT(*)::bigint AS c FROM public.apps WHERE owner_org = $1',
    [orgId],
  )
  const appsCount = appRow.length === 1 ? Math.max(0, Math.round(Number(appRow[0].c ?? 0))) : 0

  const channelRow = await queryJson<{ c: string | number | null }>(
    pg,
    `SELECT COUNT(*)::bigint AS c FROM public.channels ch
     INNER JOIN public.apps a ON a.app_id = ch.app_id
     WHERE a.owner_org = $1`,
    [orgId],
  )
  const channelsCount = channelRow.length === 1 ? Math.max(0, Math.round(Number(channelRow[0].c ?? 0))) : 0

  const counts: TrialUsageCounts = {
    apps: appsCount,
    channels: channelsCount,
    bundles_uploaded: bundlesUploaded,
    deploys: deployCount,
    native_builds: nativeBuilds,
    peak_daily_mau: peakDailyMau,
  }

  const { variant, score } = trialUsageVariant(counts, successfulUpdates, failedUpdates)
  const base = consoleBaseUrl.replace(/\/$/, '')
  const oid = encodeURIComponent(orgId)
  const plansUrl = `${base}/settings/organization/plans?oid=${oid}`
  const usageUrl = `${base}/settings/organization/usage?oid=${oid}`

  const display = trialUsageRecapDisplayFlags({
    successful_updates: successfulUpdates,
    failed_updates: failedUpdates,
    bandwidth_bytes: bandwidthBytes,
    peak_daily_mau: peakDailyMau,
    bundles_uploaded: bundlesUploaded,
    deploy_count: deployCount,
    native_builds_run: nativeBuilds,
    channels_count: channelsCount,
    apps_count: appsCount,
  })

  const trialEndDateLabel = new Date(`${trialEndDate}T00:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })

  return {
    org_id: orgId,
    kind,
    trial_end_date: trialEndDate,
    trial_end_date_label: trialEndDateLabel,
    variant,
    low_usage_score: score,
    metrics_start_date: range.startDate,
    metrics_end_date: range.endDate,
    successful_updates: successfulUpdates,
    failed_updates: failedUpdates,
    bandwidth_bytes: Number(bandwidthBytes),
    bandwidth_human: formatBytes(bandwidthBytes),
    peak_daily_mau: peakDailyMau,
    bundles_uploaded: bundlesUploaded,
    native_builds_run: nativeBuilds,
    channels_count: channelsCount,
    apps_count: appsCount,
    deploy_count: deployCount,
    show_pay_as_you_go: payAsYouGoEligiblePeakMau(peakDailyMau),
    plans_url: plansUrl,
    usage_url: usageUrl,
    docs_cli_url: 'https://capgo.app/docs/getting-started/onboarding/',
    docs_upload_url: 'https://capgo.app/docs/getting-started/deploy/#uploading-a-bundle',
    docs_channels_url: 'https://capgo.app/docs/live-updates/channels/',
    ...display,
  }
}
