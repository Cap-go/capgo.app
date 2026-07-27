import type { Context } from 'hono'
import type { ValidationIssue } from '../../utils/schema_validation.ts'
import type { AuthInfo } from '../../utils/hono.ts'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import { createSchema, makeIssue, safeParseSchema } from '../../utils/schema_validation.ts'
import { honoFactory, quickError, simpleError, useCors } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_middleware.ts'
import { cloudlog } from '../../utils/logging.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { getRetryablePostgrestStatus, isRetryablePostgrestError, isRetryablePostgrestResult, retryWithBackoff } from '../../utils/retry.ts'
import { readNativeVersionUsage } from '../../utils/stats.ts'
import { supabaseApikey, supabaseClient } from '../../utils/supabase.ts'
import { isStripeConfigured } from '../../utils/utils.ts'
import { buildDailyReportedCountsByName, convertCountsToPercentagesByName, fillMissingDailyCounts } from '../../utils/version_stats_helpers.ts'

dayjs.extend(utc)

export const app = honoFactory.createApp()
app.use('*', useCors)
app.use('*', middlewareAuth())

function accumulateNumbers(values: number[]): number[] {
  return values.reduce<number[]>((result, value) => {
    result.push(value + (result.at(-1) ?? 0))
    return result
  }, [])
}

function parseQueryDate(query: Record<string, string>, key: 'from' | 'to', issues: ValidationIssue[]): Date | undefined {
  const value = query[key]
  if (typeof value !== 'string') {
    issues.push(makeIssue(`${key} is required`, [key]))
    return undefined
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    issues.push(makeIssue(`${key} must be a valid date`, [key]))
    return undefined
  }

  return parsed
}

function parseOptionalQueryBoolean(query: Record<string, string>, key: 'breakdown' | 'noAccumulate', issues: ValidationIssue[]): boolean | undefined {
  const value = query[key]
  if (value === undefined) {
    return undefined
  }

  if (value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }

  issues.push(makeIssue(`${key} must be true or false`, [key]))
  return undefined
}

const bundleUsageSchema = createSchema<{ from: Date, to: Date }>((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { issues: [makeIssue('Expected query object')] }
  }

  const query = value as Record<string, string>
  const issues: ValidationIssue[] = []
  const from = parseQueryDate(query, 'from', issues)
  const to = parseQueryDate(query, 'to', issues)

  if (issues.length > 0) {
    return { issues }
  }

  return {
    value: {
      from: from!,
      to: to!,
    },
  }
})

const normalStatsSchema = createSchema<{
  from: Date
  to: Date
  breakdown?: boolean
  noAccumulate?: boolean
}>((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { issues: [makeIssue('Expected query object')] }
  }

  const query = value as Record<string, string>
  const issues: ValidationIssue[] = []
  const from = parseQueryDate(query, 'from', issues)
  const to = parseQueryDate(query, 'to', issues)
  const breakdown = parseOptionalQueryBoolean(query, 'breakdown', issues)
  const noAccumulate = parseOptionalQueryBoolean(query, 'noAccumulate', issues)

  if (issues.length > 0) {
    return { issues }
  }

  return {
    value: {
      from: from!,
      to: to!,
      breakdown,
      noAccumulate,
    },
  }
})

interface AppUsageByVersion {
  date: string
  app_id: string
  version_name: string
  get: number | null
  install: number | null
  uninstall: number | null
}

interface NativeVersionUsageRow {
  date: string
  platform: string
  version_build: string
  devices: number | null
}

interface AppMetricRow {
  app_id: string
  date: string
  mau: number
  storage: number
  bandwidth: number
  build_time_unit: number
  get: number
  fail: number
  install: number
  uninstall: number
}

interface StorageHourlyMetricRow {
  app_id: string
  date: string
  storage_byte_hours: number
}

interface QueryResult<T> {
  data: T | null
  error: unknown
  status?: number | null
}

interface AppOwnerOrgRow {
  owner_org: string | null
}

const STATS_QUERY_RETRY_ATTEMPTS = 3
const STATS_QUERY_RETRY_DELAY_MS = 250
const STORAGE_BYTE_HOURS_PAGE_SIZE = 1000
// PostgREST max_rows is 1000. Org dashboards return apps × days and must paginate
// or bandwidth/MAU for later app_ids are silently dropped while /app/:id still works.
const APP_METRICS_PAGE_SIZE = 1000

// Helper to get authenticated supabase client based on auth type
function getAuthenticatedSupabase(c: Context, auth: AuthInfo) {
  if (auth.authType === 'apikey' && auth.apikey) {
    return supabaseApikey(c, auth.apikey.key)
  }
  // JWT auth
  const authorization = c.req.header('authorization')
  if (!authorization) {
    throw quickError(401, 'no_authorization', 'No authorization header')
  }
  return supabaseClient(c, authorization)
}

function isRetryableStatsError(error: unknown) {
  return isRetryablePostgrestError(error)
}

function getMissingAppStatsError(errors: unknown[]) {
  return errors.find((error) => {
    if (!error || typeof error !== 'object')
      return false

    const appError = error as { app_id?: unknown, error?: unknown, status?: unknown }
    return appError.error === 'app_not_found'
      || (appError.status === 404 && typeof appError.app_id === 'string')
  })
}

function isRetryableStatsResult(result: QueryResult<unknown>) {
  return isRetryablePostgrestResult(result)
}

async function executeStatsQueryWithRetry<T>(
  c: Context,
  label: string,
  query: () => Promise<QueryResult<T>>,
): Promise<QueryResult<T>> {
  const { result, lastError, attempts } = await retryWithBackoff(async () => {
    try {
      return await query()
    }
    catch (error) {
      return { data: null, error }
    }
  }, {
    attempts: STATS_QUERY_RETRY_ATTEMPTS,
    baseDelayMs: STATS_QUERY_RETRY_DELAY_MS,
    shouldRetry: current => isRetryableStatsResult(current),
  })

  const finalResult = result ?? { data: null, error: lastError }
  if (attempts > 1) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'statistics query retried',
      label,
      attempts,
      hasError: Boolean(finalResult.error),
    })
  }

  return finalResult
}

async function resolveAppOwnerOrg(
  c: Context,
  appId: string,
  supabase: ReturnType<typeof supabaseClient>,
): Promise<{ ownerOrg: string | null, error: unknown, notFound: boolean }> {
  const { data, error } = await executeStatsQueryWithRetry<AppOwnerOrgRow>(
    c,
    'statistics_app_lookup',
    async () => await supabase
      .from('apps')
      .select('owner_org')
      .eq('app_id', appId)
      .maybeSingle() as QueryResult<AppOwnerOrgRow>,
  )

  if (error)
    return { ownerOrg: null, error, notFound: false }

  if (!data)
    return { ownerOrg: null, error: null, notFound: true }

  return { ownerOrg: data.owner_org ?? null, error: null, notFound: false }
}

async function getStatsAppOwnerOrgOrThrow(
  c: Context,
  auth: AuthInfo,
  appId: string,
  supabase: ReturnType<typeof supabaseClient>,
) {
  const { ownerOrg, error, notFound } = await resolveAppOwnerOrg(c, appId, supabase)

  if (error)
    throw quickError(500, 'cannot_get_app_statistics', 'Cannot get app statistics', { error })

  if (notFound && auth.authType === 'apikey')
    throw quickError(401, 'no_access_to_app', 'No access to app', { data: auth.userId ?? null })

  if (notFound)
    throw quickError(404, 'app_not_found', 'App not found', { app_id: appId })

  if (ownerOrg && auth.authType !== 'jwt')
    await checkOrganizationAccess(c, ownerOrg, supabase)

  return ownerOrg
}

async function fetchAppMetricsRows(
  c: Context,
  supabase: ReturnType<typeof supabaseClient>,
  params: {
    orgId: string
    appId?: string | null
    startDate: string
    endDate: string
  },
): Promise<QueryResult<AppMetricRow[]>> {
  const rows: AppMetricRow[] = []

  for (let pageStart = 0; ; pageStart += APP_METRICS_PAGE_SIZE) {
    const { data, error, status } = await executeStatsQueryWithRetry<AppMetricRow[]>(
      c,
      params.appId ? 'get_app_metrics_for_app' : 'get_app_metrics_for_org',
      async () => {
        // Org dashboards return apps × days. Without range pagination, PostgREST
        // max_rows (1000) silently drops later app_ids — single-app RPC still works
        // because it filters inside SQL before the row limit applies.
        const query = params.appId
          ? supabase.rpc('get_app_metrics' as any, {
              p_org_id: params.orgId,
              p_app_id: params.appId,
              p_start_date: params.startDate,
              p_end_date: params.endDate,
            })
          : supabase.rpc('get_app_metrics', {
              org_id: params.orgId,
              start_date: params.startDate,
              end_date: params.endDate,
            })

        return await (query as any)
          .order('app_id', { ascending: true })
          .order('date', { ascending: true })
          .range(pageStart, pageStart + APP_METRICS_PAGE_SIZE - 1) as QueryResult<AppMetricRow[]>
      },
    )

    if (error)
      return { data: null, error, status }

    rows.push(...(data ?? []))
    if ((data?.length ?? 0) < APP_METRICS_PAGE_SIZE)
      break
  }

  return { data: rows, error: null }
}

function metricDayNumber(metricDate: string, from: Date, graphDays: number): number | null {
  const dayNumber = dayjs(metricDate).utc().startOf('day').diff(dayjs(from).utc().startOf('day'), 'day')
  if (dayNumber < 0 || dayNumber >= graphDays)
    return null
  return dayNumber
}

export const statisticsTestUtils = {
  APP_METRICS_PAGE_SIZE,
  executeStatsQueryWithRetry,
  fetchAppMetricsRows,
  getMissingAppStatsError,
  getRetryableStatus: getRetryablePostgrestStatus,
  isRetryableStatsError,
  getStatsAppOwnerOrgOrThrow,
  metricDayNumber,
  resolveAppOwnerOrg,
}

async function checkOrganizationAccess(c: Context, orgId: string, supabase: ReturnType<typeof supabaseClient>) {
  if (!isStripeConfigured(c)) {
    return { isPayingAndGoodPlan: true }
  }
  // Use the existing PostgreSQL function to check organization payment and plan status
  const { data: isPayingAndGoodPlan, error } = await supabase
    .rpc('is_paying_and_good_plan_org', { orgid: orgId })
    .single()

  if (error) {
    throw quickError(404, 'organization_not_found', 'Organization not found or error checking status', {
      error,
    })
  }

  // If organization is not paying or doesn't have a good plan, throw error
  if (!isPayingAndGoodPlan) {
    throw quickError(402, 'subscription_required', 'Organization subscription required or plan invalid', {
      orgId,
      isPayingAndGoodPlan,
    })
  }

  return { isPayingAndGoodPlan }
}

async function getStorageByteHoursByApp(
  c: Context,
  ownerOrg: string | null,
  appIds: string[],
  from: Date,
  to: Date,
  graphDays: number,
  supabase: ReturnType<typeof supabaseClient>,
) {
  const storageByteHoursByApp = appIds.reduce((acc, appId) => {
    acc[appId] = Array.from({ length: graphDays }).fill(0) as number[]
    return acc
  }, {} as Record<string, number[]>)

  if (appIds.length === 0)
    return { data: storageByteHoursByApp, error: null }

  const rows: StorageHourlyMetricRow[] = []
  const fromDay = dayjs(from).utc().format('YYYY-MM-DD')
  const toDay = dayjs(to).utc().format('YYYY-MM-DD')

  for (let pageStart = 0; ; pageStart += STORAGE_BYTE_HOURS_PAGE_SIZE) {
    let query = (supabase as any)
      .from('daily_storage_hourly')
      .select('app_id,date,storage_byte_hours')
      .gte('date', fromDay)
      .lt('date', toDay)
      .order('date', { ascending: true })
      .order('app_id', { ascending: true })
      .range(pageStart, pageStart + STORAGE_BYTE_HOURS_PAGE_SIZE - 1)

    if (ownerOrg)
      query = query.eq('owner_org', ownerOrg)
    if (appIds.length === 1)
      query = query.eq('app_id', appIds[0])

    const { data, error } = await executeStatsQueryWithRetry<StorageHourlyMetricRow[]>(
      c,
      'get_daily_storage_hourly_for_stats',
      async () => await query as QueryResult<StorageHourlyMetricRow[]>,
    )

    if (error)
      return { data: storageByteHoursByApp, error }

    rows.push(...(data ?? []))
    if ((data?.length ?? 0) < STORAGE_BYTE_HOURS_PAGE_SIZE)
      break
  }

  for (const row of rows) {
    if (!storageByteHoursByApp[row.app_id])
      continue

    const dayNumber = dayjs(row.date).utc().startOf('day').diff(dayjs(from).utc().startOf('day'), 'day')
    if (dayNumber < 0 || dayNumber >= graphDays)
      continue

    storageByteHoursByApp[row.app_id][dayNumber] += Number(row.storage_byte_hours ?? 0)
  }

  return { data: storageByteHoursByApp, error: null }
}

async function getNormalStats(c: Context, appId: string | null, ownerOrg: string | null, from: Date, to: Date, supabase: ReturnType<typeof supabaseClient>, isDashboard: boolean = false, includeBreakdown: boolean = false, noAccumulate: boolean = false) {
  if (!appId && !ownerOrg)
    return { data: null, error: 'Invalid appId or ownerOrg' }

  let ownerOrgId = ownerOrg
  if (appId && !ownerOrgId) {
    const { ownerOrg: resolvedOwnerOrg, error, notFound } = await resolveAppOwnerOrg(c, appId, supabase)
    if (error)
      return { data: null, error }
    if (notFound) {
      return { data: null, error: { error: 'app_not_found', status: 404, app_id: appId } }
    }
    ownerOrgId = resolvedOwnerOrg
  }

  const startDate = dayjs(from).utc().format('YYYY-MM-DD')
  const endDate = dayjs(to).utc().format('YYYY-MM-DD')

  const { data: rawMetrics, error: metricsError } = await fetchAppMetricsRows(c, supabase, {
    orgId: ownerOrgId!,
    appId,
    startDate,
    endDate,
  })

  if (metricsError)
    return { data: null, error: metricsError }
  const metrics = (rawMetrics ?? []) as AppMetricRow[]
  const graphDays = getDaysBetweenDates(from, to)

  const createUndefinedArray = (length: number) => {
    const arr: any[] = [] as any[]
    for (let i = 0; i < length; i++)
      arr.push(0)
    return arr
  }

  let mau = createUndefinedArray(graphDays) as number[]
  let storage = createUndefinedArray(graphDays) as number[]
  let bandwidth = createUndefinedArray(graphDays) as number[]
  let buildTime = createUndefinedArray(graphDays) as number[]
  let gets = isDashboard ? createUndefinedArray(graphDays) as number[] : []

  // Group metrics by app_id
  let metricsByApp = metrics.reduce((acc, metric) => {
    if (!acc[metric.app_id]) {
      acc[metric.app_id] = [metric]
    }
    else {
      acc[metric.app_id].push(metric)
    }
    return acc
  }, {} as Record<string, typeof metrics[0][]>)

  if (appId) {
    metricsByApp = { [appId]: metricsByApp[appId] }
  }

  for (const key in metricsByApp) {
    metricsByApp[key] ??= []
  }

  const metricAppIds = Object.keys(metricsByApp).filter(Boolean)
  const { data: storageByteHoursByApp, error: storageByteHoursError } = await getStorageByteHoursByApp(
    c,
    ownerOrgId,
    appId ? [appId] : metricAppIds,
    from,
    to,
    graphDays,
    supabase,
  )
  if (storageByteHoursError)
    return { data: null, error: storageByteHoursError }

  let storageByteHours = createUndefinedArray(graphDays) as number[]
  Object.values(storageByteHoursByApp).forEach((appStorageByteHours) => {
    appStorageByteHours.forEach((value, index) => {
      storageByteHours[index] += value ?? 0
    })
  })

  Object.values(metricsByApp)
    .forEach((arrItem) => {
      const sortedArrItem = arrItem.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      cloudlog({ requestId: c.get('requestId'), message: 'sortedArrItem', data: sortedArrItem })
      sortedArrItem.forEach((item) => {
        if (!item.date)
          return
        const dayNumber = metricDayNumber(item.date, from, graphDays)
        if (dayNumber === null)
          return

        mau[dayNumber] = (mau[dayNumber] ?? 0) + item.mau
        storage[dayNumber] = (storage[dayNumber] ?? 0) + item.storage
        bandwidth[dayNumber] = (bandwidth[dayNumber] ?? 0) + (item.bandwidth ?? 0)
        buildTime[dayNumber] = (buildTime[dayNumber] ?? 0) + (item.build_time_unit ?? 0)

        if (isDashboard)
          gets[dayNumber] = (gets[dayNumber] ?? 0) + item.get
      })
    })

  if (storage.length !== 0) {
    // some magic, copied from the frontend without much understanding
    const { data: currentStorageBytes, error: storageError } = await executeStatsQueryWithRetry<number>(
      c,
      appId ? 'get_total_app_storage_size_orgs' : 'get_total_storage_size_org',
      async () => await supabase
        .rpc(appId ? 'get_total_app_storage_size_orgs' : 'get_total_storage_size_org', appId ? { org_id: ownerOrgId!, app_id: appId } : { org_id: ownerOrgId! })
        .single() as QueryResult<number>,
    )
    if (storageError)
      return { data: null, error: storageError }

    const storageVariance = storage.reduce((p, c) => (p + (c ?? 0)), 0)
    const currentStorage = currentStorageBytes ?? 0
    const initValue = Math.max(0, (currentStorage - storageVariance + (storage[0] ?? 0)))
    storage[0] = initValue
  }

  // Accumulate data if requested (default behavior for backward compatibility)
  if (noAccumulate === false) {
    storage = accumulateNumbers(storage)
    storageByteHours = accumulateNumbers(storageByteHours)
    mau = accumulateNumbers(mau)
    bandwidth = accumulateNumbers(bandwidth)
    buildTime = accumulateNumbers(buildTime)
    if (isDashboard) {
      gets = accumulateNumbers(gets)
    }
  }
  const baseDay = dayjs(from).utc()

  const finalStats = createUndefinedArray(graphDays) as { date: string, mau: number, storage: number, storage_byte_hours: number, bandwidth: number, build_time_seconds: number, get: number | undefined }[]
  const today = dayjs().utc()
  for (let i = 0; i < graphDays; i++) {
    const day = baseDay.add(i, 'day')
    if (day.utc().startOf('day').isAfter(today.utc().endOf('day')))
      continue
    finalStats[i] = {
      mau: mau[i],
      storage: storage[i],
      storage_byte_hours: storageByteHours[i],
      bandwidth: bandwidth[i],
      build_time_seconds: buildTime[i],
      get: isDashboard ? gets[i] : undefined,
      date: day.toISOString(),
    }
  }

  // If breakdown is requested, return both aggregated and per-app data
  if (includeBreakdown && ownerOrg) {
    const breakdown: any[] = []

    // Process each app's data through the same aggregation logic
    Object.keys(metricsByApp).forEach((appId) => {
      const appMetrics = metricsByApp[appId]

      // Initialize arrays for this app
      let appMau = createUndefinedArray(graphDays) as number[]
      let appStorage = createUndefinedArray(graphDays) as number[]
      let appStorageByteHours = [...(storageByteHoursByApp[appId] ?? createUndefinedArray(graphDays))] as number[]
      let appBandwidth = createUndefinedArray(graphDays) as number[]
      let appBuildTime = createUndefinedArray(graphDays) as number[]
      let appGets = isDashboard ? createUndefinedArray(graphDays) as number[] : []

      // Process metrics for this app (same logic as aggregated version)
      appMetrics.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()).forEach((item) => {
        if (!item.date)
          return
        const dayNumber = metricDayNumber(item.date, from, graphDays)
        if (dayNumber === null)
          return

        appMau[dayNumber] = (appMau[dayNumber] ?? 0) + item.mau
        appStorage[dayNumber] = (appStorage[dayNumber] ?? 0) + item.storage
        appBandwidth[dayNumber] = (appBandwidth[dayNumber] ?? 0) + (item.bandwidth ?? 0)
        appBuildTime[dayNumber] = (appBuildTime[dayNumber] ?? 0) + (item.build_time_unit ?? 0)

        if (isDashboard)
          appGets[dayNumber] = (appGets[dayNumber] ?? 0) + item.get
      })

      // Accumulate data if requested (default behavior for backward compatibility)
      if (noAccumulate === false) {
        appStorage = accumulateNumbers(appStorage)
        appStorageByteHours = accumulateNumbers(appStorageByteHours)
        appMau = accumulateNumbers(appMau)
        appBandwidth = accumulateNumbers(appBandwidth)
        appBuildTime = accumulateNumbers(appBuildTime)
        if (isDashboard) {
          appGets = accumulateNumbers(appGets)
        }
      }

      // Create final stats for this app
      for (let i = 0; i < graphDays; i++) {
        const day = baseDay.add(i, 'day')
        if (day.utc().startOf('day').isAfter(today.utc().endOf('day')))
          continue

        breakdown.push({
          app_id: appId,
          date: day.toISOString(),
          mau: appMau[i],
          storage: appStorage[i],
          storage_byte_hours: appStorageByteHours[i],
          bandwidth: appBandwidth[i],
          build_time_seconds: appBuildTime[i],
          get: isDashboard ? appGets[i] : undefined,
        })
      }
    })

    return {
      data: {
        global: finalStats.filter(x => !!x),
        byApp: breakdown.filter(x => !!x),
      },
      error: null,
    }
  }

  return { data: finalStats.filter(x => !!x), error: null }
}

async function getBundleUsage(appId: string, from: Date, to: Date, shouldGetLatestVersion: boolean, supabase: ReturnType<typeof supabaseClient>) {
  // Query uses version_name column - cast needed because auto-generated types are stale
  const { data: rawDailyVersion, error: dailyVersionError } = await supabase
    .from('daily_version')
    .select('date, app_id, version_name, get, install, uninstall')
    .eq('app_id', appId)
    .gte('date', from.toISOString())
    .lte('date', to.toISOString())
    .not('version_name', 'is', null)
    .order('date', { ascending: true })
  if (dailyVersionError)
    return { data: null, error: dailyVersionError }

  // Cast to our interface - the SQL table has version_name but types are stale
  const dailyVersion = rawDailyVersion as unknown as AppUsageByVersion[]

  // Get unique version names from the data
  const versions = [...new Set(dailyVersion.map(d => d.version_name).filter(Boolean))] as string[]
  const dates = generateDateLabels(from, to)

  // Daily reported devices by version (from "get" stats), not synthetic install reconstruction.
  const dailyCounts = buildDailyReportedCountsByName(dailyVersion, dates, versions)
  const filledCounts = fillMissingDailyCounts(dailyCounts, dates, versions)
  const dailyPercentages = convertCountsToPercentagesByName(filledCounts, dates, versions)
  const activeVersions = getActiveVersionsByName(versions, filledCounts)
  const datasets = createDatasetsByName(activeVersions, dates, dailyPercentages, filledCounts)

  if (shouldGetLatestVersion) {
    const latestVersion = getLatestDayVersionShare(activeVersions, dates, filledCounts)

    return {
      data: {
        labels: dates,
        datasets,
        latestVersion: {
          name: latestVersion.name,
          percentage: latestVersion.percentage.toFixed(1),
        },
      },
      error: null,
    }
  }

  return {
    data: {
      labels: dates,
      datasets,
    },
    error: null,
  }
}

function normalizeNativePlatform(platform: string | null | undefined) {
  return platform?.trim().toLowerCase() || 'unknown'
}

function formatNativePlatform(platform: string | null | undefined) {
  const normalized = normalizeNativePlatform(platform)
  if (normalized === 'ios')
    return 'iOS'
  if (normalized === 'android')
    return 'Android'
  if (normalized === 'electron')
    return 'Electron'
  if (normalized === 'unknown')
    return 'Unknown'

  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function getNativeVersionSeriesName(row: NativeVersionUsageRow) {
  return `${formatNativePlatform(row.platform)} ${row.version_build || 'unknown'}`
}

function buildNativeVersionCounts(rows: NativeVersionUsageRow[], dates: string[], seriesNames: string[]) {
  const dateSet = new Set(dates)
  const counts = dates.reduce((acc, date) => {
    acc[date] = seriesNames.reduce((seriesAcc, seriesName) => {
      seriesAcc[seriesName] = 0
      return seriesAcc
    }, {} as Record<string, number>)
    return acc
  }, {} as Record<string, Record<string, number>>)

  rows.forEach((row) => {
    const date = dayjs(row.date).utc().format('YYYY-MM-DD')
    const seriesName = getNativeVersionSeriesName(row)
    if (!dateSet.has(date) || !counts[date] || !seriesNames.includes(seriesName))
      return

    counts[date][seriesName] += Math.max(0, Number(row.devices) || 0)
  })

  return counts
}

async function getAuthorizedStatsAppClient(c: Context, appId: string) {
  const auth = c.get('auth') as AuthInfo

  if (!await checkPermission(c, 'app.read', { appId })) {
    throw quickError(401, 'no_access_to_app', 'No access to app', { data: auth?.userId ?? null })
  }

  const supabase = getAuthenticatedSupabase(c, auth)
  await getStatsAppOwnerOrgOrThrow(c, auth, appId, supabase)

  return supabase
}

async function getNativeVersionUsage(c: Context, appId: string, from: Date, to: Date, supabase: ReturnType<typeof supabaseClient>) {
  const dates = generateDateLabels(from, to)
  const startDate = dayjs(from).utc().startOf('day').format('YYYY-MM-DD')
  const endDate = dayjs(to).utc().startOf('day').add(1, 'day').format('YYYY-MM-DD')
  let nativeVersionUsage: NativeVersionUsageRow[]
  try {
    nativeVersionUsage = await readNativeVersionUsage(c, appId, startDate, endDate, supabase) as NativeVersionUsageRow[]
  }
  catch (error) {
    return { data: null, error }
  }
  const seriesNames = [...new Set(nativeVersionUsage.map(getNativeVersionSeriesName))]
  const dailyCounts = buildNativeVersionCounts(nativeVersionUsage, dates, seriesNames)
  const dailyPercentages = convertCountsToPercentagesByName(dailyCounts, dates, seriesNames)
  const activeVersions = getActiveVersionsByName(seriesNames, dailyCounts)
  const datasets = createDatasetsByName(activeVersions, dates, dailyPercentages, dailyCounts)
  const latestVersion = getLatestDayVersionShare(activeVersions, dates, dailyCounts)

  return {
    data: {
      labels: dates,
      datasets,
      latestVersion: {
        name: latestVersion.name,
        percentage: latestVersion.percentage.toFixed(1),
      },
    },
    error: null,
  }
}

// Filter out versions with no usage (by version_name)
function getActiveVersionsByName(versions: string[], counts: { [date: string]: { [version: string]: number } }) {
  return versions.filter(version =>
    Object.values(counts).some(dayData => (dayData[version] ?? 0) > 0),
  )
}

// Create datasets for Chart.js (by version_name - no lookup needed)
function createDatasetsByName(
  versions: string[],
  dates: string[],
  percentages: { [date: string]: { [version: string]: number } },
  counts: { [date: string]: { [version: string]: number } },
) {
  return versions.map((version) => {
    const percentageData = dates.map(date => percentages[date][version] ?? 0)
    const countData = dates.map(date => Math.max(0, Math.round(counts[date][version] ?? 0)))

    return {
      label: version,
      data: percentageData,
      metaCounts: countData,
    }
  })
}

function generateDateLabels(from: Date, to: Date) {
  const start = dayjs(from).utc().startOf('day')
  const end = dayjs(to).utc().startOf('day')

  if (start.isAfter(end))
    return []

  const labels: string[] = []
  let cursor = start
  while (cursor.isBefore(end) || cursor.isSame(end)) {
    labels.push(cursor.format('YYYY-MM-DD'))
    cursor = cursor.add(1, 'day')
  }

  return labels
}

function fillMissingDailyData(datasets: { label: string, data: number[] }[], labels: string[]) {
  if (datasets.length === 0 || labels.length === 0)
    return datasets

  const today = dayjs().utc().format('YYYY-MM-DD')
  const populated = datasets.map(dataset => ({
    ...dataset,
    data: [...dataset.data],
  }))

  for (let index = 1; index < labels.length; index++) {
    if (labels[index] === today)
      continue

    const dailyTotal = populated.reduce((sum, dataset) => sum + (dataset.data[index] ?? 0), 0)
    const previousTotal = populated.reduce((sum, dataset) => sum + (dataset.data[index - 1] ?? 0), 0)

    if (dailyTotal === 0 && previousTotal > 0) {
      populated.forEach((dataset) => {
        dataset.data[index] = dataset.data[index - 1] ?? 0
      })
    }
  }

  return populated
}

export const bundleUsageTestUtils = {
  generateDateLabels,
  fillMissingDailyData,
  buildDailyReportedCountsByName,
  fillMissingDailyCounts,
  convertCountsToPercentagesByName,
  getActiveVersionsByName,
  createDatasetsByName,
  getLatestDayVersionShare,
}

function getLatestDayVersionShare(
  versions: string[],
  dates: string[],
  counts: { [date: string]: { [version: string]: number } },
) {
  if (versions.length === 0 || dates.length === 0)
    return { name: '', percentage: 0 }

  for (let index = dates.length - 1; index >= 0; index--) {
    const date = dates[index]
    const dayData = counts[date] ?? {}
    let totalAtIndex = 0
    let maxVersion = ''
    let maxCount = -1

    versions.forEach((version) => {
      const count = Math.max(0, Number(dayData[version]) || 0)
      totalAtIndex += count
      if (count > maxCount) {
        maxCount = count
        maxVersion = version
      }
    })

    if (totalAtIndex > 0) {
      return {
        name: maxVersion,
        percentage: (maxCount / totalAtIndex) * 100,
      }
    }
  }

  return { name: '', percentage: 0 }
}

function getDaysBetweenDates(firstDate: Date, secondDate: Date) {
  const oneDay = 24 * 60 * 60 * 1000
  const res = Math.round(Math.abs((firstDate.valueOf() - secondDate.valueOf()) / oneDay))
  return res
}

app.get('/app/:app_id', async (c) => {
  const appId = c.req.param('app_id')
  const query = c.req.query()
  const bodyParsed = safeParseSchema(normalStatsSchema, query)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data
  const auth = c.get('auth') as AuthInfo

  // Use unified RBAC permission check
  if (!await checkPermission(c, 'app.read', { appId })) {
    throw quickError(401, 'no_access_to_app', 'No access to app', { data: auth?.userId ?? null })
  }

  // Use authenticated client - RLS will enforce access
  const supabase = getAuthenticatedSupabase(c, auth)

  const ownerOrg = await getStatsAppOwnerOrgOrThrow(c, auth, appId, supabase)

  const { data: finalStats, error: statsError } = await getNormalStats(c, appId, ownerOrg, body.from, body.to, supabase, c.get('auth')?.authType === 'jwt', false, body.noAccumulate ?? false)

  if (statsError) {
    throw quickError(500, 'cannot_get_app_statistics', 'Cannot get app statistics', { error: statsError })
  }

  return c.json(finalStats)
})

app.get('/org/:org_id', async (c) => {
  const orgId = c.req.param('org_id')
  const query = c.req.query()

  const bodyParsed = safeParseSchema(normalStatsSchema, query)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data

  const auth = c.get('auth') as AuthInfo
  // Use unified RBAC permission check
  if (!(await checkPermission(c, 'org.read', { orgId }))) {
    throw quickError(401, 'no_access_to_organization', 'No access to organization', { data: auth?.userId ?? null })
  }
  // Use authenticated client - RLS will enforce access
  const supabase = getAuthenticatedSupabase(c, auth)

  // Check organization payment status before returning stats
  if (auth.authType !== 'jwt')
    await checkOrganizationAccess(c, orgId, supabase)

  const { data: finalStats, error } = await getNormalStats(c, null, orgId, body.from, body.to, supabase, c.get('auth')?.authType === 'jwt', body.breakdown ?? false, body.noAccumulate ?? false)

  if (error) {
    throw quickError(500, 'cannot_get_organization_statistics', 'Cannot get organization statistics', { error })
  }

  return c.json(finalStats)
})

app.get('/app/:app_id/bundle_usage', async (c) => {
  const appId = c.req.param('app_id')
  const query = c.req.query()
  const useDashboard = false

  const bodyParsed = safeParseSchema(bundleUsageSchema, query)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data
  const supabase = await getAuthorizedStatsAppClient(c, appId)

  const { data, error } = await getBundleUsage(appId, body.from, body.to, useDashboard, supabase)

  if (error) {
    throw quickError(500, 'cannot_get_app_statistics', 'Cannot get app statistics', { error })
  }

  return c.json(data)
})

app.get('/app/:app_id/native_usage', async (c) => {
  const appId = c.req.param('app_id')
  const query = c.req.query()

  const bodyParsed = safeParseSchema(bundleUsageSchema, query)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data
  const supabase = await getAuthorizedStatsAppClient(c, appId)

  const { data, error } = await getNativeVersionUsage(c, appId, body.from, body.to, supabase)

  if (error) {
    throw quickError(500, 'cannot_get_app_statistics', 'Cannot get app statistics', { error })
  }

  return c.json(data)
})

app.get('/user', async (c) => {
  const auth = c.get('auth') as AuthInfo
  // Use authenticated client - RLS will enforce access
  const supabase = getAuthenticatedSupabase(c, auth)

  const query = c.req.query()
  const bodyParsed = safeParseSchema(normalStatsSchema, query)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data

  const { data: orgs, error: orgsError } = await supabase
    .rpc('get_user_org_ids')

  if (orgsError) {
    throw quickError(404, 'user_not_found', 'User not found', { error: orgsError })
  }

  const orgIds = Array.from(new Set((orgs ?? []).map(org => org.org_id)))

  cloudlog({ requestId: c.get('requestId'), message: 'orgs', data: orgIds })

  if (orgIds.length === 0) {
    throw quickError(401, 'no_organizations_found', 'No organizations found', { data: auth?.userId ?? null })
  }

  // Check organization payment status for each organization before returning stats
  for (const orgId of orgIds) {
    if (auth.authType !== 'jwt')
      await checkOrganizationAccess(c, orgId, supabase)
  }

  let stats: Array<{ data: any, error: any }> = []
  if (auth.authType === 'apikey') {
    const { data: apps, error: appsError } = await supabase.rpc('get_accessible_apps_for_apikey_v2', {
      apikey: c.get('capgkey') as string,
    })
    if (appsError) {
      throw quickError(404, 'apps_not_found', 'Apps not found', { error: appsError })
    }
    stats = await Promise.all((apps ?? []).map(app => getNormalStats(c, app.app_id, null, body.from, body.to, supabase, false, false, body.noAccumulate ?? false)))
  }
  else {
    stats = await Promise.all(orgIds.map(orgId => getNormalStats(c, null, orgId, body.from, body.to, supabase, auth.authType === 'jwt', false, body.noAccumulate ?? false)))
  }

  const errors = stats.filter(stat => stat.error).map(stat => stat.error)
  if (errors.length > 0) {
    const missingAppError = getMissingAppStatsError(errors)
    if (missingAppError)
      throw quickError(404, 'app_not_found', 'App not found', { error: missingAppError })

    throw quickError(500, 'cannot_get_user_statistics', 'Cannot get user statistics', { error: errors })
  }

  interface StatEntry {
    date: string
    mau: number
    storage: number
    bandwidth: number
    build_time_seconds: number
    get?: number
  }

  const finalStats = Array.from(stats.map(stat => stat.data!).flat().reduce((acc, curr) => {
    const current = acc.get(curr.date)
    if (current) {
      current.mau += curr.mau
      current.storage += curr.storage
      current.bandwidth += curr.bandwidth
      current.build_time_seconds += curr.build_time_seconds
    }
    else {
      acc.set(curr.date, curr)
    }
    return acc
  }, new Map<string, StatEntry>()).values())

  return c.json(finalStats)
})
