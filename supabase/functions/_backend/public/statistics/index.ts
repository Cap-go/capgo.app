import type { Context } from 'hono'
import type { ValidationIssue } from '../../utils/schema_validation.ts'
import type { AuthInfo } from '../../utils/hono.ts'
import type { PgClient } from '../../utils/pg.ts'
import type { RlsPrincipal } from '../../utils/pg_rls.ts'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import { createSchema, makeIssue, safeParseSchema } from '../../utils/schema_validation.ts'
import { honoFactory, quickError, simpleError, useCors } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_middleware.ts'
import { cloudlog, cloudlogErr, serializeError } from '../../utils/logging.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { isTransientPgError } from '../../utils/pg_errors.ts'
import { apikeyPrincipal, authPrincipal, queryJson, withRlsTransaction } from '../../utils/pg_rls.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { getRetryablePostgrestStatus, isRetryablePostgrestError, isRetryablePostgrestResult, retryWithBackoff } from '../../utils/retry.ts'
import { readNativeActiveDevicesSummary, readNativeDailyPlatformActive, readNativeVersionUsage } from '../../utils/stats.ts'
import { isStatisticsRangeTooLarge, MAX_STATISTICS_RANGE_DAYS, statisticsRangeDays } from '../../utils/statistics_range.ts'
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

interface NativeDailyPlatformRow {
  date: string
  platform: string
  devices: number
}

interface NativeActiveDevicesSummary {
  android: number
  ios: number
  electron: number
  unknown: number
  total: number
}

interface NativeDailyPlatformActive {
  labels: string[]
  android: number[]
  ios: number[]
  electron: number[]
  unknown: number[]
  total: number[]
}

interface AppMetricRow {
  app_id: string
  date: string
  mau: number
  /** Byte-hours the app stored that UTC day (daily_storage_hourly). */
  storage: number
  bandwidth: number
  build_time_unit: number
  get: number
  fail: number
  install: number
  uninstall: number
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

/** Runs one read as the caller and returns its rows as PostgREST would serialize them. */
type StatsDb = <T>(text: string, values: unknown[]) => Promise<T[]>

// Who the statistics reads run as: the API key, or the JWT of the authorization header.
function getStatsPrincipal(c: Context, auth: AuthInfo): RlsPrincipal {
  if (auth.authType === 'apikey' && auth.apikey) {
    return apikeyPrincipal(c, auth.apikey.key)
  }
  // JWT auth
  const authorization = c.req.header('authorization')
  if (!authorization) {
    throw quickError(401, 'no_authorization', 'No authorization header')
  }
  return authPrincipal(c, auth)
}

// Each read is its own RLS transaction, like one PostgREST request. A Hyperdrive Client is one
// connection, so reads on the same client must not interleave their BEGIN/COMMIT. Spread them over
// a few lanes, each with its own client and queue, so organizations still load concurrently (as
// their PostgREST requests did) without opening one connection per read.
const STATS_DB_LANES = 4

function createStatsDb(c: Context, principal: RlsPrincipal) {
  const lanes: { pg: Promise<PgClient>, tail: Promise<unknown>, pending: number }[] = []
  const db: StatsDb = <T>(text: string, values: unknown[]) => {
    let lane = lanes.find(l => l.pending === 0)
    if (!lane && lanes.length < STATS_DB_LANES) {
      const created = { pg: getPgClient(c), tail: Promise.resolve() as Promise<unknown>, pending: 0 }
      // A lane whose connection failed is dropped, so a retry opens a fresh one.
      created.pg.catch(() => {
        const index = lanes.indexOf(created)
        if (index >= 0)
          lanes.splice(index, 1)
      })
      lanes.push(created)
      lane = created
    }
    lane ??= lanes.reduce((a, b) => (b.pending < a.pending ? b : a), lanes[0])
    const target = lane
    target.pending++
    const run = target.tail
      .then(() => target.pg)
      .then(pg => withRlsTransaction(pg, principal, client => queryJson<T>(client, text, values)))
      .finally(() => { target.pending-- })
    target.tail = run.catch(() => {})
    return run
  }
  const close = async () => {
    await Promise.all(lanes.map(async (lane) => {
      await lane.tail
      const pg = await lane.pg.catch(() => null)
      if (pg)
        closeClient(c, pg)
    }))
  }
  return { db, close }
}

async function withStatsDb<T>(c: Context, principal: RlsPrincipal, run: (db: StatsDb) => Promise<T>): Promise<T> {
  const { db, close } = createStatsDb(c, principal)
  try {
    return await run(db)
  }
  finally {
    await close()
  }
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
  return isRetryablePostgrestResult(result) || isTransientPgError(result.error)
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
  db: StatsDb,
): Promise<{ ownerOrg: string | null, error: unknown, notFound: boolean }> {
  const { data, error } = await executeStatsQueryWithRetry<AppOwnerOrgRow>(
    c,
    'statistics_app_lookup',
    async () => ({ data: (await db<AppOwnerOrgRow>('SELECT owner_org FROM public.apps WHERE app_id = $1', [appId]))[0] ?? null, error: null }),
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
  db: StatsDb,
) {
  const { ownerOrg, error, notFound } = await resolveAppOwnerOrg(c, appId, db)

  if (error)
    throw quickError(500, 'cannot_get_app_statistics', 'Cannot get app statistics', { error })

  if (notFound && auth.authType === 'apikey')
    throw quickError(401, 'no_access_to_app', 'No access to app', { data: auth.userId ?? null })

  if (notFound)
    throw quickError(404, 'app_not_found', 'App not found', { app_id: appId })

  if (ownerOrg && auth.authType !== 'jwt')
    await checkOrganizationAccess(c, ownerOrg, db)

  return ownerOrg
}

async function fetchAppMetricsRows(
  c: Context,
  db: StatsDb,
  params: {
    orgId: string
    appId?: string | null
    startDate: string
    endDate: string
  },
): Promise<QueryResult<AppMetricRow[]>> {
  // Org dashboards return apps × days. Direct SQL has no PostgREST max_rows cap, so one ordered
  // read returns every app_id instead of paging past the old 1000-row limit.
  const { data, error, status } = await executeStatsQueryWithRetry<AppMetricRow[]>(
    c,
    params.appId ? 'get_app_metrics_for_app' : 'get_app_metrics_for_org',
    async () => ({
      data: params.appId
        ? await db<AppMetricRow>(
            'SELECT * FROM public.get_app_metrics(p_org_id => $1::uuid, p_app_id => $2::varchar, p_start_date => $3::date, p_end_date => $4::date) ORDER BY app_id ASC, date ASC',
            [params.orgId, params.appId, params.startDate, params.endDate],
          )
        : await db<AppMetricRow>(
            'SELECT * FROM public.get_app_metrics(org_id => $1::uuid, start_date => $2::date, end_date => $3::date) ORDER BY app_id ASC, date ASC',
            [params.orgId, params.startDate, params.endDate],
          ),
      error: null,
    }),
  )

  if (error)
    return { data: null, error, status }

  return { data: data ?? [], error: null }
}

function metricDayNumber(metricDate: string, from: Date, graphDays: number): number | null {
  const dayNumber = dayjs.utc(metricDate).startOf('day').diff(dayjs(from).utc().startOf('day'), 'day')
  if (dayNumber < 0 || dayNumber >= graphDays)
    return null
  return dayNumber
}

export const statisticsTestUtils = {
  withStatsDb,
  assembleNormalStats,
  buildStorageSeries,
  storageBytesFromByteHours,
  getApiKeyAppsNormalStats,
  getNormalStats,
  checkOrganizationsAccess,
  executeStatsQueryWithRetry,
  fetchAppMetricsRows,
  getMissingAppStatsError,
  getRetryableStatus: getRetryablePostgrestStatus,
  isRetryableStatsError,
  getStatsAppOwnerOrgOrThrow,
  metricDayNumber,
  resolveAppOwnerOrg,
}

async function checkOrganizationAccess(c: Context, orgId: string, db: StatsDb) {
  await checkOrganizationsAccess(c, [orgId], db)
  return { isPayingAndGoodPlan: true }
}

/**
 * Payment and plan check for several organizations in one read. Fails like checking each
 * organization in order: a read error is a 404, and the first organization that is not paying
 * (or has a bad plan) is a 402 naming that organization.
 */
async function checkOrganizationsAccess(c: Context, orgIds: string[], db: StatsDb) {
  if (orgIds.length === 0 || !isStripeConfigured(c))
    return

  // Use the existing PostgreSQL function to check organization payment and plan status
  let rows: { ord: number | string, is_paying_and_good_plan_org: boolean | null }[]
  try {
    rows = await db<{ ord: number | string, is_paying_and_good_plan_org: boolean | null }>(
      `SELECT input.ord, public.is_paying_and_good_plan_org(orgid => input.org_id) AS is_paying_and_good_plan_org
       FROM unnest($1::uuid[]) WITH ORDINALITY AS input(org_id, ord)
       ORDER BY input.ord`,
      [orgIds],
    )
  }
  catch (error) {
    throw quickError(404, 'organization_not_found', 'Organization not found or error checking status', {
      error,
    })
  }

  // Match by input position: PostgreSQL returns uuids in lowercase canonical form, so keying by
  // the returned id would miss callers that pass an uppercase organization id.
  const statusByOrd = new Map(rows.map(row => [Number(row.ord), row.is_paying_and_good_plan_org]))
  for (const [index, orgId] of orgIds.entries()) {
    const isPayingAndGoodPlan = statusByOrd.get(index + 1) ?? null
    // If organization is not paying or doesn't have a good plan, throw error
    if (!isPayingAndGoodPlan) {
      throw quickError(402, 'subscription_required', 'Organization subscription required or plan invalid', {
        orgId,
        isPayingAndGoodPlan,
      })
    }
  }
}

interface NormalStatsEntry {
  date: string
  mau: number
  storage: number
  storage_byte_hours: number
  bandwidth: number
  build_time_seconds: number
  get: number | undefined
}

interface NormalStatsResult {
  data: any
  error: any
}

function createZeroArray(length: number): number[] {
  return Array.from({ length }, () => 0)
}

function groupMetricsByApp(metrics: AppMetricRow[]) {
  return metrics.reduce((acc, metric) => {
    if (!acc[metric.app_id]) {
      acc[metric.app_id] = [metric]
    }
    else {
      acc[metric.app_id].push(metric)
    }
    return acc
  }, {} as Record<string, AppMetricRow[]>)
}

const HOURS_PER_DAY = 24

/**
 * Bytes stored on each day: the byte-hours of the day divided by its hours. Today only counts the
 * hours elapsed so far.
 */
function storageBytesFromByteHours(byteHours: number[], from: Date, now = dayjs().utc()): number[] {
  const firstDay = dayjs(from).utc().startOf('day')
  return byteHours.map((value, index) => {
    // Fractional hours: at 00:30 a bundle stored since midnight used half a byte-hour per byte.
    const hours = Math.min(HOURS_PER_DAY, now.diff(firstDay.add(index, 'day'), 'hour', true))
    if (hours <= 0)
      return 0
    return Math.round((value ?? 0) / hours)
  })
}

/** Day-over-day change of a level series, the shape `storage` had when noAccumulate is set. */
function dailyChanges(levels: number[]): number[] {
  return levels.map((value, index) => index === 0 ? value : value - levels[index - 1])
}

interface StorageSeries {
  /** Bytes stored each day (average over the day), or its daily changes when noAccumulate is set. */
  storage: number[]
  /** Byte-hours used each day, accumulated unless noAccumulate is set. */
  storageByteHours: number[]
}

function buildStorageSeries(dailyByteHours: number[], from: Date, noAccumulate: boolean): StorageSeries {
  const levels = storageBytesFromByteHours(dailyByteHours, from)
  return noAccumulate
    ? { storage: dailyChanges(levels), storageByteHours: dailyByteHours }
    : { storage: levels, storageByteHours: accumulateNumbers(dailyByteHours) }
}

/**
 * Turns the rows read for one app or one organization into the daily series the endpoints return.
 * Pure: every database read happens before, so the per-app and batched paths share this exactly.
 *
 * Storage has one source, the byte-hours in `get_app_metrics().storage`. `storage_byte_hours`
 * returns them; the legacy `storage` field returns the bytes stored each day derived from them.
 */
function assembleNormalStats(c: Context, params: {
  metricsByApp: Record<string, AppMetricRow[]>
  from: Date
  graphDays: number
  isDashboard: boolean
  includeBreakdown: boolean
  noAccumulate: boolean
}): NormalStatsResult {
  const { metricsByApp, from, graphDays, isDashboard, includeBreakdown, noAccumulate } = params

  let mau = createZeroArray(graphDays)
  const byteHours = createZeroArray(graphDays)
  let bandwidth = createZeroArray(graphDays)
  let buildTime = createZeroArray(graphDays)
  let gets = isDashboard ? createZeroArray(graphDays) : []

  Object.values(metricsByApp)
    .forEach((arrItem) => {
      const sortedArrItem = arrItem.toSorted((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      cloudlog({ requestId: c.get('requestId'), message: 'sortedArrItem', data: sortedArrItem })
      sortedArrItem.forEach((item) => {
        if (!item.date)
          return
        const dayNumber = metricDayNumber(item.date, from, graphDays)
        if (dayNumber === null)
          return

        mau[dayNumber] = (mau[dayNumber] ?? 0) + item.mau
        byteHours[dayNumber] = (byteHours[dayNumber] ?? 0) + Number(item.storage ?? 0)
        bandwidth[dayNumber] = (bandwidth[dayNumber] ?? 0) + (item.bandwidth ?? 0)
        buildTime[dayNumber] = (buildTime[dayNumber] ?? 0) + (item.build_time_unit ?? 0)

        if (isDashboard)
          gets[dayNumber] = (gets[dayNumber] ?? 0) + item.get
      })
    })

  const storage = buildStorageSeries(byteHours, from, noAccumulate)

  // Accumulate data if requested (default behavior for backward compatibility)
  if (noAccumulate === false) {
    mau = accumulateNumbers(mau)
    bandwidth = accumulateNumbers(bandwidth)
    buildTime = accumulateNumbers(buildTime)
    if (isDashboard) {
      gets = accumulateNumbers(gets)
    }
  }
  const baseDay = dayjs(from).utc()

  const finalStats = createZeroArray(graphDays) as unknown as NormalStatsEntry[]
  const today = dayjs().utc()
  for (let i = 0; i < graphDays; i++) {
    const day = baseDay.add(i, 'day')
    if (day.utc().startOf('day').isAfter(today.utc().endOf('day')))
      continue
    finalStats[i] = {
      mau: mau[i],
      storage: storage.storage[i],
      storage_byte_hours: storage.storageByteHours[i],
      bandwidth: bandwidth[i],
      build_time_seconds: buildTime[i],
      get: isDashboard ? gets[i] : undefined,
      date: day.toISOString(),
    }
  }

  // If breakdown is requested, return both aggregated and per-app data
  if (includeBreakdown) {
    const breakdown: any[] = []

    // Process each app's data through the same aggregation logic
    Object.keys(metricsByApp).forEach((appId) => {
      const appMetrics = metricsByApp[appId]

      // Initialize arrays for this app
      let appMau = createZeroArray(graphDays)
      const appByteHours = createZeroArray(graphDays)
      let appBandwidth = createZeroArray(graphDays)
      let appBuildTime = createZeroArray(graphDays)
      let appGets = isDashboard ? createZeroArray(graphDays) : []

      // Process metrics for this app (same logic as aggregated version)
      appMetrics.toSorted((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()).forEach((item) => {
        if (!item.date)
          return
        const dayNumber = metricDayNumber(item.date, from, graphDays)
        if (dayNumber === null)
          return

        appMau[dayNumber] = (appMau[dayNumber] ?? 0) + item.mau
        appByteHours[dayNumber] = (appByteHours[dayNumber] ?? 0) + Number(item.storage ?? 0)
        appBandwidth[dayNumber] = (appBandwidth[dayNumber] ?? 0) + (item.bandwidth ?? 0)
        appBuildTime[dayNumber] = (appBuildTime[dayNumber] ?? 0) + (item.build_time_unit ?? 0)

        if (isDashboard)
          appGets[dayNumber] = (appGets[dayNumber] ?? 0) + item.get
      })

      const appStorage = buildStorageSeries(appByteHours, from, noAccumulate)

      // Accumulate data if requested (default behavior for backward compatibility)
      if (noAccumulate === false) {
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
          storage: appStorage.storage[i],
          storage_byte_hours: appStorage.storageByteHours[i],
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

async function getNormalStats(c: Context, appId: string | null, ownerOrg: string | null, from: Date, to: Date, db: StatsDb, isDashboard: boolean = false, includeBreakdown: boolean = false, noAccumulate: boolean = false): Promise<NormalStatsResult> {
  if (!appId && !ownerOrg)
    return { data: null, error: 'Invalid appId or ownerOrg' }

  let ownerOrgId = ownerOrg
  if (appId && !ownerOrgId) {
    const { ownerOrg: resolvedOwnerOrg, error, notFound } = await resolveAppOwnerOrg(c, appId, db)
    if (error)
      return { data: null, error }
    if (notFound) {
      return { data: null, error: { error: 'app_not_found', status: 404, app_id: appId } }
    }
    ownerOrgId = resolvedOwnerOrg
  }

  const startDate = dayjs(from).utc().format('YYYY-MM-DD')
  const endDate = dayjs(to).utc().format('YYYY-MM-DD')

  const { data: rawMetrics, error: metricsError } = await fetchAppMetricsRows(c, db, {
    orgId: ownerOrgId!,
    appId,
    startDate,
    endDate,
  })

  if (metricsError)
    return { data: null, error: metricsError }
  const metrics = (rawMetrics ?? []) as AppMetricRow[]
  const graphDays = getDaysBetweenDates(from, to)

  // Group metrics by app_id
  let metricsByApp = groupMetricsByApp(metrics)

  if (appId) {
    metricsByApp = { [appId]: metricsByApp[appId] }
  }

  for (const key in metricsByApp) {
    metricsByApp[key] ??= []
  }

  return assembleNormalStats(c, {
    metricsByApp,
    from,
    graphDays,
    isDashboard,
    includeBreakdown: includeBreakdown && !!ownerOrg,
    noAccumulate,
  })
}

interface StatsAppAccessRow {
  app_id: string
  owner_org: string | null
  org_read: boolean | null
  app_read: boolean | null
}

/**
 * Account statistics for an API key, one result per app in `appIds` order.
 *
 * Each result equals `getNormalStats(c, appId, null, ...)` for that app, but the reads are batched
 * instead of running four RLS transactions per app over the shared lanes:
 * - one `apps` lookup for every owner org;
 * - one access read, using the same checks `get_app_metrics` applies (org read for the org
 *   overload, app read for the app overload);
 * - one `get_app_metrics` call per org the key can read, filtered to the key's apps here, so the
 *   per-org metrics cache JSON is decoded once per org instead of once per app. Orgs the key cannot
 *   read (app-scoped keys) keep the per-app call, which is what they returned before;
 * - storage comes from the same `get_app_metrics` rows (byte-hours per day).
 */
async function getApiKeyAppsNormalStats(c: Context, appIds: string[], from: Date, to: Date, db: StatsDb, noAccumulate: boolean): Promise<NormalStatsResult[]> {
  if (appIds.length === 0)
    return []

  const uniqueAppIds = Array.from(new Set(appIds))
  const failAll = (error: unknown) => appIds.map(() => ({ data: null, error }))

  const { data: ownerRows, error: ownerError } = await executeStatsQueryWithRetry<StatsAppAccessRow[]>(
    c,
    'statistics_apps_access_lookup',
    async () => ({
      // `apps` is read under RLS, like `resolveAppOwnerOrg`; an app missing here is reported as not found.
      data: await db<StatsAppAccessRow>(
        `WITH input AS (
           SELECT apps.app_id, apps.owner_org
           FROM public.apps
           WHERE apps.app_id = ANY($1::varchar[])
         ),
         org_access AS (
           SELECT orgs.owner_org, public.request_has_org_read_access(orgs.owner_org) AS org_read
           FROM (SELECT DISTINCT input.owner_org FROM input WHERE input.owner_org IS NOT NULL) AS orgs
         )
         SELECT
           input.app_id,
           input.owner_org,
           COALESCE(org_access.org_read, false) AS org_read,
           CASE WHEN input.owner_org IS NULL THEN false
             ELSE public.request_has_app_read_access(input.owner_org, input.app_id)
           END AS app_read
         FROM input
         LEFT JOIN org_access ON org_access.owner_org = input.owner_org`,
        [uniqueAppIds],
      ),
      error: null,
    }),
  )
  if (ownerError)
    return failAll(ownerError)

  const appRows = new Map((ownerRows ?? []).map(row => [row.app_id, row]))
  const foundApps = uniqueAppIds.filter(appId => appRows.has(appId))
  const graphDays = getDaysBetweenDates(from, to)
  const startDate = dayjs(from).utc().format('YYYY-MM-DD')
  const endDate = dayjs(to).utc().format('YYYY-MM-DD')

  // Group the readable apps by owner org.
  const appsByOrg = new Map<string, { orgRead: boolean, appIds: string[] }>()
  for (const appId of foundApps) {
    const row = appRows.get(appId)!
    if (!row.owner_org || !row.app_read)
      continue
    const group = appsByOrg.get(row.owner_org) ?? { orgRead: !!row.org_read, appIds: [] }
    group.appIds.push(appId)
    appsByOrg.set(row.owner_org, group)
  }

  const metricsTask = Promise.all(Array.from(appsByOrg.entries()).map(async ([orgId, group]) => {
    if (group.orgRead) {
      const { data, error } = await fetchAppMetricsRows(c, db, { orgId, startDate, endDate })
      if (error)
        return { appIds: group.appIds, rows: [] as AppMetricRow[], error }
      const wanted = new Set(group.appIds)
      return { appIds: group.appIds, rows: (data ?? []).filter(row => wanted.has(row.app_id)), error: null }
    }
    const results = await Promise.all(group.appIds.map(appId => fetchAppMetricsRows(c, db, { orgId, appId, startDate, endDate })))
    const error = results.find(result => result.error)?.error ?? null
    return { appIds: group.appIds, rows: results.flatMap(result => result.data ?? []), error }
  }))

  const metricGroups = await metricsTask

  const metricsByAppId = new Map<string, AppMetricRow[]>()
  const metricsErrorByAppId = new Map<string, unknown>()
  for (const group of metricGroups) {
    for (const appId of group.appIds) {
      if (group.error)
        metricsErrorByAppId.set(appId, group.error)
      metricsByAppId.set(appId, [])
    }
    for (const row of group.rows)
      metricsByAppId.get(row.app_id)?.push(row)
  }

  return appIds.map((appId) => {
    if (!appRows.has(appId))
      return { data: null, error: { error: 'app_not_found', status: 404, app_id: appId } }
    const metricsError = metricsErrorByAppId.get(appId)
    if (metricsError)
      return { data: null, error: metricsError }

    return assembleNormalStats(c, {
      metricsByApp: { [appId]: metricsByAppId.get(appId) ?? [] },
      from,
      graphDays,
      isDashboard: false,
      includeBreakdown: false,
      noAccumulate,
    })
  })
}

async function getBundleUsage(appId: string, from: Date, to: Date, shouldGetLatestVersion: boolean, db: StatsDb) {
  let dailyVersion: AppUsageByVersion[]
  try {
    // PostgREST max_rows capped this read at 1000 rows; keep that bound.
    dailyVersion = await db<AppUsageByVersion>(
      `SELECT date, app_id, version_name, get, install, uninstall
       FROM public.daily_version
       WHERE app_id = $1
         AND date >= $2::date
         AND date <= $3::date
         AND version_name IS NOT NULL
       ORDER BY date ASC
       LIMIT 1000`,
      [appId, from.toISOString(), to.toISOString()],
    )
  }
  catch (dailyVersionError) {
    return { data: null, error: dailyVersionError }
  }

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

function summarizeNativeActiveDevices(rows: Array<{ platform: string, devices: number }>): NativeActiveDevicesSummary {
  const summary: NativeActiveDevicesSummary = {
    android: 0,
    ios: 0,
    electron: 0,
    unknown: 0,
    total: 0,
  }

  rows.forEach((row) => {
    const platform = normalizeNativePlatform(row.platform)
    const devices = Math.max(0, Number(row.devices) || 0)
    if (platform === 'total') {
      summary.total = devices
      return
    }
    if (platform === 'android') {
      summary.android += devices
      return
    }
    if (platform === 'ios') {
      summary.ios += devices
      return
    }
    if (platform === 'electron') {
      summary.electron += devices
      return
    }
    summary.unknown += devices
  })

  if (summary.total === 0) {
    summary.total = summary.android + summary.ios + summary.electron + summary.unknown
  }

  return summary
}

function buildDailyPlatformActiveTotals(rows: NativeDailyPlatformRow[], dates: string[]): NativeDailyPlatformActive {
  const dateIndexByLabel = new Map(dates.map((date, index) => [date, index]))
  const android = Array.from({ length: dates.length }).fill(0) as number[]
  const ios = Array.from({ length: dates.length }).fill(0) as number[]
  const electron = Array.from({ length: dates.length }).fill(0) as number[]
  const unknown = Array.from({ length: dates.length }).fill(0) as number[]
  const totalFromRows = Array.from({ length: dates.length }).fill(0) as number[]
  const hasTotalFromRows = Array.from({ length: dates.length }).fill(false) as boolean[]

  rows.forEach((row) => {
    const date = dayjs.utc(row.date).format('YYYY-MM-DD')
    const index = dateIndexByLabel.get(date)
    if (index === undefined)
      return

    const devices = Math.max(0, Number(row.devices) || 0)
    const rawPlatform = row.platform?.trim().toLowerCase() || ''
    if (rawPlatform === 'total') {
      totalFromRows[index] = devices
      hasTotalFromRows[index] = true
      return
    }

    const platform = normalizeNativePlatform(row.platform)
    if (platform === 'android')
      android[index] += devices
    else if (platform === 'ios')
      ios[index] += devices
    else if (platform === 'electron')
      electron[index] += devices
    else
      unknown[index] += devices
  })

  const total = dates.map((_date, index) => (
    hasTotalFromRows[index]
      ? totalFromRows[index]
      : android[index] + ios[index] + electron[index] + unknown[index]
  ))

  return {
    labels: dates,
    android,
    ios,
    electron,
    unknown,
    total,
  }
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
    const date = dayjs.utc(row.date).format('YYYY-MM-DD')
    const seriesName = getNativeVersionSeriesName(row)
    if (!dateSet.has(date) || !counts[date] || !seriesNames.includes(seriesName))
      return

    counts[date][seriesName] += Math.max(0, Number(row.devices) || 0)
  })

  return counts
}

async function getAuthorizedStatsAppPrincipal(c: Context, appId: string) {
  const auth = c.get('auth') as AuthInfo

  if (!await checkPermission(c, 'app.read', { appId })) {
    throw quickError(401, 'no_access_to_app', 'No access to app', { data: auth?.userId ?? null })
  }

  const principal = getStatsPrincipal(c, auth)
  await withStatsDb(c, principal, db => getStatsAppOwnerOrgOrThrow(c, auth, appId, db))

  return principal
}

async function getNativeVersionUsage(c: Context, appId: string, from: Date, to: Date, principal: RlsPrincipal) {
  const dates = generateDateLabels(from, to)
  const startDate = dayjs(from).utc().startOf('day').format('YYYY-MM-DD')
  const endDate = dayjs(to).utc().startOf('day').add(1, 'day').format('YYYY-MM-DD')
  const previousStartDate = dayjs(from).utc().startOf('day').subtract(dates.length, 'day').format('YYYY-MM-DD')
  const emptySummary: NativeActiveDevicesSummary = {
    android: 0,
    ios: 0,
    electron: 0,
    unknown: 0,
    total: 0,
  }
  // The KPI cards and daily platform chart are secondary: one failing Analytics Engine
  // query (timeout, rate limit) must not 500 the whole Native tab, so each read degrades
  // to empty data independently. Only the version usage read itself is fatal.
  const [usageResult, summaryResult, previousSummaryResult, dailyResult] = await Promise.allSettled([
    readNativeVersionUsage(c, appId, startDate, endDate, principal) as Promise<NativeVersionUsageRow[]>,
    readNativeActiveDevicesSummary(c, appId, startDate, endDate, principal),
    readNativeActiveDevicesSummary(c, appId, previousStartDate, startDate, principal),
    readNativeDailyPlatformActive(c, appId, startDate, endDate, principal),
  ])
  if (usageResult.status === 'rejected')
    return { data: null, error: usageResult.reason }

  const logSecondaryFailure = (section: string, result: PromiseSettledResult<unknown>) => {
    if (result.status === 'rejected')
      cloudlogErr({ requestId: c.get('requestId'), message: 'Native usage secondary read failed', section, appId, error: serializeError(result.reason) })
  }
  logSecondaryFailure('activeDevices', summaryResult)
  logSecondaryFailure('previousPeriodActiveDevices', previousSummaryResult)
  logSecondaryFailure('dailyPlatformActive', dailyResult)

  const nativeVersionUsage = usageResult.value
  const activeDevicesSummary = summaryResult.status === 'fulfilled' ? summarizeNativeActiveDevices(summaryResult.value) : emptySummary
  const previousPeriodActiveDevices = previousSummaryResult.status === 'fulfilled' ? summarizeNativeActiveDevices(previousSummaryResult.value) : { ...emptySummary }
  const dailyPlatformRows: NativeDailyPlatformRow[] = dailyResult.status === 'fulfilled' ? dailyResult.value : []
  const seriesNames = [...new Set(nativeVersionUsage.map(getNativeVersionSeriesName))]
  const dailyCounts = buildNativeVersionCounts(nativeVersionUsage, dates, seriesNames)
  const dailyPercentages = convertCountsToPercentagesByName(dailyCounts, dates, seriesNames)
  const activeVersions = getActiveVersionsByName(seriesNames, dailyCounts)
  const datasets = createDatasetsByName(activeVersions, dates, dailyPercentages, dailyCounts)
  const latestVersion = getLatestDayVersionShare(activeVersions, dates, dailyCounts)
  const dailyPlatformActive = buildDailyPlatformActiveTotals(dailyPlatformRows, dates)

  return {
    data: {
      labels: dates,
      datasets,
      latestVersion: {
        name: latestVersion.name,
        percentage: latestVersion.percentage.toFixed(1),
      },
      activeDevices: activeDevicesSummary,
      previousPeriodActiveDevices,
      dailyPlatformActive,
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

export const nativeUsageTestUtils = {
  summarizeNativeActiveDevices,
  buildDailyPlatformActiveTotals,
  normalizeNativePlatform,
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
  return statisticsRangeDays(firstDate, secondDate)
}

// Every day in the range becomes a row per app, so an unbounded range (e.g. 2000 → 2026) costs
// thousands of rows per app. Reject it before touching the database.
function assertStatisticsRange(range: { from: Date, to: Date }) {
  if (isStatisticsRangeTooLarge(range.from, range.to)) {
    throw simpleError('date_range_too_large', `The range between from and to must be at most ${MAX_STATISTICS_RANGE_DAYS} days`, {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      maxDays: MAX_STATISTICS_RANGE_DAYS,
    })
  }
}

app.get('/app/:app_id', async (c) => {
  const appId = c.req.param('app_id')
  const query = c.req.query()
  const bodyParsed = safeParseSchema(normalStatsSchema, query)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data
  assertStatisticsRange(body)
  const auth = c.get('auth') as AuthInfo

  // Use unified RBAC permission check
  if (!await checkPermission(c, 'app.read', { appId })) {
    throw quickError(401, 'no_access_to_app', 'No access to app', { data: auth?.userId ?? null })
  }

  // Read as the caller - RLS will enforce access
  const principal = getStatsPrincipal(c, auth)

  const { data: finalStats, error: statsError } = await withStatsDb(c, principal, async (db) => {
    const ownerOrg = await getStatsAppOwnerOrgOrThrow(c, auth, appId, db)
    return getNormalStats(c, appId, ownerOrg, body.from, body.to, db, c.get('auth')?.authType === 'jwt', false, body.noAccumulate ?? false)
  })

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
  assertStatisticsRange(body)

  const auth = c.get('auth') as AuthInfo
  // Use unified RBAC permission check
  if (!(await checkPermission(c, 'org.read', { orgId }))) {
    throw quickError(401, 'no_access_to_organization', 'No access to organization', { data: auth?.userId ?? null })
  }
  // Read as the caller - RLS will enforce access
  const principal = getStatsPrincipal(c, auth)

  const { data: finalStats, error } = await withStatsDb(c, principal, async (db) => {
    // Check organization payment status before returning stats
    if (auth.authType !== 'jwt')
      await checkOrganizationAccess(c, orgId, db)

    return getNormalStats(c, null, orgId, body.from, body.to, db, c.get('auth')?.authType === 'jwt', body.breakdown ?? false, body.noAccumulate ?? false)
  })

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
  assertStatisticsRange(body)
  const principal = await getAuthorizedStatsAppPrincipal(c, appId)

  const { data, error } = await withStatsDb(c, principal, db => getBundleUsage(appId, body.from, body.to, useDashboard, db))

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
  assertStatisticsRange(body)
  const principal = await getAuthorizedStatsAppPrincipal(c, appId)

  const { data, error } = await getNativeVersionUsage(c, appId, body.from, body.to, principal)

  if (error) {
    throw quickError(500, 'cannot_get_app_statistics', 'Cannot get app statistics', { error })
  }

  return c.json(data)
})

app.get('/user', async (c) => {
  const auth = c.get('auth') as AuthInfo
  // Read as the caller - RLS will enforce access
  const principal = getStatsPrincipal(c, auth)

  const query = c.req.query()
  const bodyParsed = safeParseSchema(normalStatsSchema, query)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data
  assertStatisticsRange(body)

  const stats = await withStatsDb<Array<{ data: any, error: any }>>(c, principal, async (db) => {
    let orgs: { org_id: string }[]
    try {
      orgs = await db<{ org_id: string }>('SELECT * FROM public.get_user_org_ids()', [])
    }
    catch (orgsError) {
      throw quickError(404, 'user_not_found', 'User not found', { error: orgsError })
    }

    const orgIds = Array.from(new Set(orgs.map(org => org.org_id)))

    cloudlog({ requestId: c.get('requestId'), message: 'orgs', data: orgIds })

    if (orgIds.length === 0) {
      throw quickError(401, 'no_organizations_found', 'No organizations found', { data: auth?.userId ?? null })
    }

    // Check organization payment status for every organization before returning stats
    if (auth.authType !== 'jwt')
      await checkOrganizationsAccess(c, orgIds, db)

    if (auth.authType === 'apikey') {
      let apps: { app_id: string }[]
      try {
        apps = await db<{ app_id: string }>('SELECT app_id FROM public.get_accessible_apps_for_apikey_v2(apikey => $1::text)', [c.get('capgkey') as string])
      }
      catch (appsError) {
        throw quickError(404, 'apps_not_found', 'Apps not found', { error: appsError })
      }
      return await getApiKeyAppsNormalStats(c, apps.map(app => app.app_id), body.from, body.to, db, body.noAccumulate ?? false)
    }
    return await Promise.all(orgIds.map(orgId => getNormalStats(c, null, orgId, body.from, body.to, db, auth.authType === 'jwt', false, body.noAccumulate ?? false)))
  })

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
    storage_byte_hours: number
    bandwidth: number
    build_time_seconds: number
    get?: number
  }

  const finalStats = Array.from(stats.flatMap(stat => stat.data!).reduce((acc, curr) => {
    const current = acc.get(curr.date)
    if (current) {
      current.mau += curr.mau
      current.storage += curr.storage
      current.storage_byte_hours += curr.storage_byte_hours
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
