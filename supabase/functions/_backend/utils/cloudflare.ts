import type { AnalyticsEngineDataset, D1Database, Hyperdrive, KVNamespace, Queue, SendEmail } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { DeviceInfoWriteCachePayload } from './deviceComparison.ts'
import type { StatsInsightRawAction, StatsInsightRawDaily, StatsInsightRawDevice, StatsInsightRawSummary, StatsInsightRawVersion } from './statsInsights.ts'
import type { Database } from './supabase.types.ts'
import type { ChannelDeviceOverrideIds, ChannelDevicePlatform, DeviceRes, DeviceWithoutCreatedAt, NativeActiveDevicesByPlatformRow, NativeVersionUsage, ReadDevicesParams, ReadStatsInsightsParams, ReadStatsParams, StatsInsightsResult, StatsMetadata, VersionUsage, VersionUsageChannel } from './types.ts'
import { CACHE_PUT_TIMEOUT_MS, CacheHelper } from './cache.ts'
import { canSkipDeviceInfoWrite, DEVICE_INFO_REFRESH_TTL_SECONDS, toComparableDevice } from './deviceComparison.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { emptyStatsInsights, normalizeStatsInsightsResult } from './statsInsights.ts'
import { DEFAULT_LIMIT } from './types.ts'
import { legacyDownloadFailKey, legacyDownloadFailPluginSqlCF, subtractLegacyDownloadFails, summarizeLegacyCheckFailures, sumLegacyDownloadFails } from './legacyDownloadFail.ts'
import { getEnv } from './utils.ts'
import { buildVersionCompareSql } from './versionCompare.ts'

/** Escape a value for safe interpolation into an Analytics Engine SQL string. */
export function escapeSqlString(value: string): string {
  return value.replace(/'/g, '\'\'').replace(/\\/g, '\\\\')
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local calendar day, matching prior dayjs().format('YYYY-MM-DD') behavior. */
function formatLocalYmd(date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** Local date-time, matching prior dayjs(...).format('YYYY-MM-DD HH:mm:ss') for "now". */
function formatLocalDateTime(date = new Date()): string {
  return `${formatLocalYmd(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

export const MAX_ANALYTICS_QUERY_LIMIT = 50_000
const INSTALL_SOURCE_COUNT_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30

export function normalizeAnalyticsLimit(limit: unknown, fallback = DEFAULT_LIMIT): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit))
    return fallback

  const integerLimit = Math.trunc(limit)
  if (integerLimit < 1)
    return fallback

  return Math.min(integerLimit, MAX_ANALYTICS_QUERY_LIMIT)
}

// type is require for the bindings no interface
// eslint-disable-next-line ts/consistent-type-definitions
type AiBinding = {
  run: (model: string, input: unknown) => Promise<unknown>
}

// eslint-disable-next-line ts/consistent-type-definitions
export type Bindings = {
  DEVICE_USAGE: AnalyticsEngineDataset
  BANDWIDTH_USAGE: AnalyticsEngineDataset
  VERSION_USAGE: AnalyticsEngineDataset
  APP_LOG: AnalyticsEngineDataset
  APP_LOG_EXTERNAL?: AnalyticsEngineDataset
  DEVICE_INFO: AnalyticsEngineDataset
  NOTIFICATION_REGISTRY?: AnalyticsEngineDataset
  NOTIFICATION_EVENTS?: AnalyticsEngineDataset
  // Workers RPC binding to the admin dashboard's CliUsageIngest entrypoint (prod only).
  ADMIN_CLI_USAGE?: { record: (event: unknown) => Promise<unknown> }
  POSTHOG_QUEUE?: Queue
  POSTHOG_DLQ?: Queue
  POSTHOG_API_KEY?: string
  POSTHOG_API_HOST?: string
  ENV_NAME?: string
  NOTIFICATION_QUEUE?: Queue
  AUTH_EMAIL?: SendEmail
  CONSOLE_EVENTS?: DurableObjectNamespace
  DB_STOREAPPS: D1Database
  CHANNEL_SELF_STORE?: KVNamespace
  PLUGIN_NOTIFICATION_QUEUE?: KVNamespace
  LOCAL_READ_REPLICA_SUPABASE_DB_URL?: string
  HYPERDRIVE_CAPGO_DIRECT_EU?: Hyperdrive
  HYPERDRIVE_CAPGO_READ_NA: Hyperdrive
  HYPERDRIVE_CAPGO_READ_EU: Hyperdrive
  HYPERDRIVE_CAPGO_READ_SA: Hyperdrive
  HYPERDRIVE_CAPGO_READ_OC: Hyperdrive
  HYPERDRIVE_CAPGO_READ_AS_JAPAN: Hyperdrive
  HYPERDRIVE_CAPGO_READ_AS_INDIA: Hyperdrive
  HYPERDRIVE_CAPGO_READ_ME: Hyperdrive
  HYPERDRIVE_CAPGO_READ_AF: Hyperdrive
  HYPERDRIVE_CAPGO_READ_HK: Hyperdrive
  ATTACHMENT_UPLOAD_HANDLER: DurableObjectNamespace
  ATTACHMENT_BUCKET: R2Bucket
  AI?: AiBinding
}

const TRACK_DEVICE_USAGE_CACHE_PATH = '/.track-device-usage-cache'
// Cache per device per day to ensure rolling windows still see active devices.
const TRACK_DEVICE_USAGE_CACHE_MAX_AGE_SECONDS = 2 * 24 * 60 * 60

function normalizeUsagePlatform(platform?: string | null) {
  return platform?.trim().toLowerCase() || 'unknown'
}

function getUsagePlatformValue(platform?: string | null) {
  const normalized = normalizeUsagePlatform(platform)
  if (normalized === 'ios')
    return 1
  if (normalized === 'electron')
    return 2
  if (normalized === 'android')
    return 0

  return -1
}

/**
 * Track device usage (MAU) in Cloudflare Analytics Engine
 *
 * This function sends MAU statistics to Cloudflare Analytics Engine with both app_id and org_id
 * for organization-level analytics and activity detection. The org_id allows for:
 * - Organization-level MAU queries and filtering
 * - Activity detection for organizations with recent MAU stats
 * - Better analytics segmentation by organization
 *
 * Uses caching to only write once per device per day to reduce Analytics Engine costs
 * while maintaining accurate rolling-window MAU counts.
 *
 * @param c - Hono context
 * @param device_id - Unique device identifier
 * @param app_id - Application identifier
 * @param org_id - Organization identifier (optional, defaults to empty string)
 * @param platform - Device platform ('ios' or 'android')
 */
export async function trackDeviceUsageCF(c: Context, device_id: string, app_id: string, org_id: string, platform: string, version_build?: string | null) {
  if (!c.env.DEVICE_USAGE)
    return

  const normalizedPlatform = normalizeUsagePlatform(platform)
  const normalizedVersionBuild = version_build || 'unknown'

  try {
    const usageCache = new CacheHelper(c)
    const usageCacheRequest = usageCache.buildRequest(TRACK_DEVICE_USAGE_CACHE_PATH, {
      app_id,
      device_id,
      day: formatLocalYmd(),
      platform: normalizedPlatform,
      version_build: normalizedVersionBuild,
    })

    // Always await matchJson (resolves Cache API); .available is sync-racy.
    const cachedUsage = await usageCache.matchJson<{ t: number }>(usageCacheRequest)
    if (cachedUsage) {
      // Device/version already tracked for this day, skip write
      return
    }

    const platformValue = getUsagePlatformValue(normalizedPlatform)

    // Write to Analytics Engine
    c.env.DEVICE_USAGE.writeDataPoint({
      blobs: [device_id, org_id, normalizedVersionBuild, normalizedPlatform],
      doubles: [platformValue],
      indexes: [app_id],
    })

    // Cache the write for this native version during the current day (put timed out).
    await usageCache.putJson(usageCacheRequest, { t: Date.now() }, TRACK_DEVICE_USAGE_CACHE_MAX_AGE_SECONDS, { timeoutMs: CACHE_PUT_TIMEOUT_MS })
  }
  catch {
    const platformValue = getUsagePlatformValue(normalizedPlatform)
    // On error, still try to write to Analytics Engine without caching
    c.env.DEVICE_USAGE.writeDataPoint({
      blobs: [device_id, org_id, normalizedVersionBuild, normalizedPlatform],
      doubles: [platformValue],
      indexes: [app_id],
    })
  }
}

export function trackBandwidthUsageCF(c: Context, device_id: string, app_id: string, file_size: number) {
  if (!c.env.BANDWIDTH_USAGE)
    return Promise.resolve()

  c.env.BANDWIDTH_USAGE.writeDataPoint({
    blobs: [device_id],
    doubles: [file_size],
    indexes: [app_id],
  })

  return Promise.resolve()
}

export function trackVersionUsageCF(c: Context, version_name: string, app_id: string, action: string, channel?: VersionUsageChannel | string | null) {
  if (!c.env.VERSION_USAGE)
    return Promise.resolve()

  const channelName = typeof channel === 'string' ? channel : channel?.name
  const channelId = typeof channel === 'object' && channel?.id ? String(channel.id) : ''

  c.env.VERSION_USAGE.writeDataPoint({
    blobs: [app_id, version_name, action, channelName ?? '', channelId],
    indexes: [app_id],
  })

  return Promise.resolve()
}

const MAX_STATS_DURATION_MS = 7_200_000

export function parseStatsDurationMs(metadata?: StatsMetadata | Record<string, unknown> | null): number | null {
  if (!metadata)
    return null
  for (const key of ['duration_ms', 'duration'] as const) {
    const raw = metadata[key]
    if (typeof raw === 'number') {
      if (Number.isFinite(raw) && raw >= 0 && raw <= MAX_STATS_DURATION_MS)
        return raw
      continue
    }
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 15)
      continue
    if (!/^\d+(?:\.\d+)?$/.test(raw))
      continue
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0 || value > MAX_STATS_DURATION_MS)
      continue
    return value
  }
  return null
}

function serializeStatsMetadata(metadata?: StatsMetadata): string {
  return metadata && Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : ''
}

export function parseStatsMetadata(metadata: unknown): StatsMetadata | null {
  if (typeof metadata !== 'string' || metadata === '')
    return null

  try {
    const parsed = JSON.parse(metadata)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null
    return parsed as StatsMetadata
  }
  catch {
    return null
  }
}

export interface AppLogDimensions {
  platform?: string | null
  country_code?: string | null
  plugin_version?: string | null
  channel?: VersionUsageChannel | null
}

function normalizeAppLogDimension(value: string | null | undefined, maxLength: number) {
  if (!value)
    return ''
  const normalized = value.trim()
  if (!normalized)
    return ''
  return normalized.slice(0, maxLength)
}

function appLogDimensionBlobs(dimensions?: AppLogDimensions) {
  // blob5=platform, blob6=country_code, blob7=plugin_version (denormalized for public /data breakdowns)
  // blob8=channel name, blob9=channel id: only set on failure logs, so the live
  // release view can break failures down per channel.
  const channelId = dimensions?.channel?.id
  return [
    normalizeAppLogDimension(dimensions?.platform, 16),
    normalizeAppLogDimension(dimensions?.country_code, 2).toUpperCase(),
    normalizeAppLogDimension(dimensions?.plugin_version, 32),
    normalizeAppLogDimension(dimensions?.channel?.name, 128),
    channelId ? String(channelId) : '',
  ]
}

export function trackLogsCF(c: Context, app_id: string, device_id: string, action: string, version_name: string, metadata?: StatsMetadata, dimensions?: AppLogDimensions) {
  if (!c.env.APP_LOG)
    return Promise.resolve()

  const durationMs = parseStatsDurationMs(metadata)
  c.env.APP_LOG.writeDataPoint({
    blobs: [device_id, action, version_name, serializeStatsMetadata(metadata), ...appLogDimensionBlobs(dimensions)],
    ...(durationMs !== null ? { doubles: [durationMs] } : {}),
    indexes: [app_id],
  })

  return Promise.resolve()
}

// app_log_external only feeds the global on-prem update total, so it is sampled
// client-side: one write per APP_LOG_EXTERNAL_SAMPLE_RATE events, with the rate
// stored in double2 so countUpdatesFromLogsExternalCF scales the total back up.
export const APP_LOG_EXTERNAL_SAMPLE_RATE = 10

export function trackLogsCFExternal(c: Context, app_id: string, device_id: string, action: Database['public']['Enums']['stats_action'], version_name: string, metadata?: StatsMetadata, dimensions?: AppLogDimensions) {
  if (!c.env.APP_LOG_EXTERNAL)
    return Promise.resolve()
  if (crypto.getRandomValues(new Uint32Array(1))[0] % APP_LOG_EXTERNAL_SAMPLE_RATE !== 0)
    return Promise.resolve()

  const durationMs = parseStatsDurationMs(metadata)
  c.env.APP_LOG_EXTERNAL.writeDataPoint({
    blobs: [device_id, action, version_name, serializeStatsMetadata(metadata), ...appLogDimensionBlobs(dimensions)],
    doubles: [durationMs ?? 0, APP_LOG_EXTERNAL_SAMPLE_RATE],
    indexes: [app_id],
  })

  return Promise.resolve()
}

function getReplicaWriteStoreAppSession(c: Context) {
  return c.env.DB_STOREAPPS
}

function getReplicaReadStoreAppSession(c: Context) {
  return c.env.DB_STOREAPPS.withSession('first-unconstrained')
}

const TRACK_DEVICE_CACHE_PATH = '/.track-device-cache'
// Cache entries expire with the refresh TTL; canSkipDeviceInfoWrite also checks
// cached_at so an entry kept past its max-age by the colo still forces a write.
const TRACK_DEVICE_CACHE_MAX_AGE_SECONDS = DEVICE_INFO_REFRESH_TTL_SECONDS

export async function trackDevicesCF(c: Context, device: DeviceWithoutCreatedAt) {
  // Runs under waitUntil — Cache I/O here stretches Workers Wall Time charts.
  const start = performance.now()
  let outcome: 'cache_hit' | 'wrote' | 'error' = 'wrote'

  // Analytics Engine DEVICE_INFO is required for tracking devices
  if (!c.env.DEVICE_INFO) {
    cloudlog({ requestId: c.get('requestId'), message: 'DEVICE_INFO not available, skipping trackDevicesCF' })
    return
  }

  try {
    const trackDeviceCache = new CacheHelper(c)
    const trackDeviceCacheRequest = trackDeviceCache.buildRequest(TRACK_DEVICE_CACHE_PATH, {
      app_id: device.app_id,
      device_id: device.device_id,
    })
    // Do not gate on helper.available — it is sync-racy before ensureCache resolves.
    const cachedDevice = await trackDeviceCache.matchJson<DeviceInfoWriteCachePayload>(trackDeviceCacheRequest)
    if (canSkipDeviceInfoWrite(cachedDevice, device)) {
      outcome = 'cache_hit'
      cloudlog({
        requestId: c.get('requestId'),
        message: 'Cache hit – device unchanged, skipping write',
        context: {
          device_id: device.device_id,
          app_id: device.app_id,
        },
      })
      return
    }

    const comparableDevice = toComparableDevice(device)

    // Write to Analytics Engine - this is the primary store now (sync; needs no waitUntil)
    cloudlog({ requestId: c.get('requestId'), message: 'Writing to Analytics Engine DEVICE_INFO' })
    // Platform: 0 = android, 1 = ios, 2 = electron
    const platformLower = comparableDevice.platform?.toLowerCase()
    const platformValue = platformLower === 'ios' ? 1 : platformLower === 'electron' ? 2 : platformLower === 'android' ? 0 : -1
    c.env.DEVICE_INFO.writeDataPoint({
      blobs: [
        device.device_id,
        comparableDevice.version_name ?? '',
        comparableDevice.plugin_version ?? '',
        comparableDevice.os_version ?? '',
        comparableDevice.custom_id ?? '',
        comparableDevice.version_build ?? '',
        comparableDevice.default_channel ?? '',
        comparableDevice.key_id ?? '',
        comparableDevice.install_source ?? '',
        comparableDevice.country_code ?? '',
      ],
      doubles: [
        platformValue,
        comparableDevice.is_prod == null ? -1 : comparableDevice.is_prod ? 1 : 0,
        comparableDevice.is_emulator == null ? -1 : comparableDevice.is_emulator ? 1 : 0,
      ],
      indexes: [device.app_id],
    })

    const cachePayload: DeviceInfoWriteCachePayload = {
      ...comparableDevice,
      app_id: device.app_id,
      device_id: device.device_id,
      cached_at: new Date().toISOString(),
    }
    await trackDeviceCache.putJson(trackDeviceCacheRequest, cachePayload, TRACK_DEVICE_CACHE_MAX_AGE_SECONDS, { timeoutMs: CACHE_PUT_TIMEOUT_MS })
  }
  catch (e) {
    outcome = 'error'
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error tracking device', error: serializeError(e), device })
  }
  finally {
    const ms = Math.round(performance.now() - start)
    if (ms >= 20) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'trackDevicesCF_timing',
        ms,
        outcome,
        app_id: device.app_id,
      })
    }
  }
}

export function formatDateCF(date: string | Date | undefined | null) {
  // Preserve prior dayjs edge-case behavior:
  // - undefined formats as "now" in local time (dayjs(undefined))
  // - null / '' / unparseable values format as the literal "Invalid Date"
  if (date === undefined)
    return formatLocalDateTime()
  if (date === null || date === '')
    return 'Invalid Date'

  const normalizedDate = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(normalizedDate.getTime()))
    return 'Invalid Date'

  const year = normalizedDate.getUTCFullYear()
  const month = pad2(normalizedDate.getUTCMonth() + 1)
  const day = pad2(normalizedDate.getUTCDate())
  const hours = pad2(normalizedDate.getUTCHours())
  const minutes = pad2(normalizedDate.getUTCMinutes())
  const seconds = pad2(normalizedDate.getUTCSeconds())

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

interface AnalyticsApiResponse {
  data: { [key: string]: string }[]
  meta: { name: string, type: string }[]
  rows: number
  rows_before_limit_at_least: number
}

function convertDataToJsTypes<T>(apiResponse: AnalyticsApiResponse) {
  const { meta, data } = apiResponse

  // cloudlog(c.get('requestId'), 'meta', meta)
  const toNumber = Number
  const converters: Record<string, (value: string) => unknown> = {
    String,
    // Analytics Engine returns aggregate sums as Float64 string values.
    // Without conversion, callers that do `sum + row.install` string-concatenate.
    Float64: toNumber,
    Float32: toNumber,
    Int64: toNumber,
    Int32: toNumber,
    UInt64: toNumber,
    UInt32: toNumber,
    DateTime: (value: string) => new Date(value),
  }

  return data.map((row) => {
    const convertedRow = {} as any
    meta.forEach((column) => {
      const { name, type } = column
      convertedRow[name] = converters[type] ? converters[type](row[name]) : row[name]
    })
    return convertedRow as T
  })
}

export async function runQueryToCFA<T>(c: Context, query: string, signal?: AbortSignal) {
  const CF_ANALYTICS_TOKEN = getEnv(c, 'CF_ANALYTICS_TOKEN')
  const CF_ACCOUNT_ID = getEnv(c, 'CF_ACCOUNT_ANALYTICS_ID')

  const headers = {
    'Authorization': `Bearer ${CF_ANALYTICS_TOKEN}`,
    'Content-Type': 'text/plain; charset=utf-8',
    'Accept-Encoding': 'gzip, zlib, deflate, zstd, br',
    'User-Agent': 'Capgo/1.0',
  }
  const requestId = c.get('requestId')
  cloudlog({
    requestId,
    message: 'runQueryToCFA payload',
    queryLength: query.length,
    headerNames: Object.keys(headers),
  })

  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql`, {
      method: 'POST',
      headers,
      body: query,
      signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      let errorForLog: unknown = errorText
      try {
        errorForLog = JSON.parse(errorText)
      }
      catch {
        // Keep the raw text body when Cloudflare returns HTML or plain text.
      }
      const errorPreview = (errorText || response.statusText).replace(/\s+/g, ' ').trim().slice(0, 500)
      cloudlogErr({ requestId: c.get('requestId'), message: 'runQueryToCFA HTTPError', status: response.status, error: errorForLog })
      throw new Error(`runQueryToCFA HTTP ${response.status}: ${errorPreview}`)
    }

    const res = await response.json() as AnalyticsApiResponse & { data: T[] }
    return convertDataToJsTypes<T>(res)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'runQueryToCFA error', error: serializeError(e) })
    if (e instanceof Error && e.message.startsWith('runQueryToCFA HTTP '))
      throw e
    const errorMessage = e instanceof Error ? e.message : String(e)
    throw new Error(`runQueryToCFA encountered an error: ${errorMessage}`, { cause: e })
  }
}
export interface DeviceUsageCF {
  date: string
  mau: number
  app_id: string
  org_id?: string
}

// Intentional anti-fraud MAU behavior: devices are grouped by (device_id, app_id, org_id).
// After an app transfer, a device active under both the old and the new org in the same
// period is counted once per org, so moving an app between orgs cannot hide its MAU.
// Usage of deleted apps stays billable via deleted_apps for 35 days (see
// calculate_org_metrics_cache_entry), so deleting/recreating an app cannot reset MAU.
// Another org recreating that app_id within 35 days shares the same usage rows
// (both orgs billed, new owner can read them): expected, see
// docs/billing-usage-retention.md.
export function buildDeviceUsageCFQuery(app_id: string, period_start: string, period_end: string) {
  return `SELECT
    date,
    app_id,
    org_id,
    count() AS mau
  FROM (
    SELECT
      formatDateTime(toStartOfInterval(min(timestamp), INTERVAL '1' DAY), '%Y-%m-%d') AS date,
      blob1 AS device_id,
      index1 AS app_id,
      blob2 AS org_id
    FROM device_usage
    WHERE
      app_id = '${escapeSqlString(app_id)}'
      AND timestamp >= toDateTime('${formatDateCF(period_start)}')
      AND timestamp < toDateTime('${formatDateCF(period_end)}')
    GROUP BY device_id, app_id, org_id
  )
  GROUP BY date, app_id, org_id
  ORDER BY date`
}

export async function readDeviceUsageCF(c: Context, app_id: string, period_start: string, period_end: string, options: { throwOnError?: boolean } = {}) {
  if (!c.env.DEVICE_USAGE)
    return [] as DeviceUsageCF[]
  // Count each device on its first active day inside Analytics Engine. Returning
  // one row per device fails with "query result is too large" for apps with
  // hundreds of thousands of monthly devices.
  const query = buildDeviceUsageCFQuery(app_id, period_start, period_end)

  cloudlog({ requestId: c.get('requestId'), message: 'readDeviceUsageCF query', query })
  try {
    const res = await runQueryToCFA<Omit<DeviceUsageCF, 'mau'> & { mau: number | string }>(c, query)
    const groupedByDay = res.reduce((acc, curr) => {
      const { date, app_id, org_id } = curr
      if (!acc[date]) {
        acc[date] = {
          date,
          mau: 0,
          app_id,
          org_id,
        }
      }
      acc[date].mau += Number(curr.mau) || 0
      return acc
    }, {} as Record<string, DeviceUsageCF>)
    return Object.values(groupedByDay).sort((a, b) => a.date > b.date ? 1 : -1)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading device usage', error: serializeError(e), query })
    if (options.throwOnError)
      throw e
  }
  return [] as DeviceUsageCF[]
}

interface BandwidthUsageCF {
  date: string
  bandwidth: number
  app_id: string
}

export async function rawAnalyticsQuery(c: Context, query: string) {
  if (!c.env.BANDWIDTH_USAGE)
    return []

  cloudlog({ requestId: c.get('requestId'), message: 'rawAnalyticsQuery query', query })
  try {
    return await runQueryToCFA<any>(c, query)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading rawAnalyticsQuery', error: serializeError(e) })
  }
  return []
}

export async function readBandwidthUsageCF(c: Context, app_id: string, period_start: string, period_end: string, options: { throwOnError?: boolean } = {}) {
  if (!c.env.BANDWIDTH_USAGE)
    return [] as BandwidthUsageCF[]
  const query = `SELECT
  formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
  sum(double1 * _sample_interval) AS bandwidth,
  index1 AS app_id
FROM bandwidth_usage
WHERE
  timestamp >= toDateTime('${formatDateCF(period_start)}')
  AND timestamp < toDateTime('${formatDateCF(period_end)}')
  AND app_id = '${escapeSqlString(app_id)}'
GROUP BY date, app_id
ORDER BY date, app_id`

  cloudlog({ requestId: c.get('requestId'), message: 'readBandwidthUsageCF query', query })
  try {
    return await runQueryToCFA<BandwidthUsageCF>(c, query)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading bandwidth usage', error: serializeError(e), query })
    if (options.throwOnError)
      throw e
  }
  return [] as BandwidthUsageCF[]
}

interface StoreApp {
  created_at: string // Assuming ISO string format for datetime
  app_id: string
  url: string
  title: string
  summary: string
  icon: string
  free: boolean
  category: string
  capacitor: boolean
  developer_email: string
  installs: number
  developer: string
  score: number
  to_get_framework: boolean
  onprem: boolean
  updates: number
  to_get_info: boolean
  to_get_similar: boolean
  updated_at: string // Assuming ISO string format for datetime
  cordova: boolean
  react_native: boolean
  capgo: boolean
  kotlin: boolean
  flutter: boolean
  native_script: boolean
  lang?: string // Optional as it's not NOT NULL
  developer_id?: string // Optional as it's not NOT NULL
}

export interface VersionUsageChannelFilterOptions {
  /**
   * Also match `get` rows written without any channel. /updates only started
   * recording the serving channel on `get` rows recently, so dashboards that
   * chart `get` keep older history visible while those rows age out of the
   * retention window. Never set this for install/fail based decisions.
   */
  includeUnattributedGets?: boolean
}

/**
 * version_usage channel filter. blob4 holds the channel name and blob5 the channel
 * id; blob5 only exists on newer rows. With both id and name, rows are matched by
 * id and legacy rows without an id fall back to the name.
 */
export function buildVersionUsageChannelFilterCF(channel?: VersionUsageChannel | string | null, options: VersionUsageChannelFilterOptions = {}): string {
  if (!channel)
    return ''
  const channelId = typeof channel === 'object' && channel.id ? String(channel.id) : ''
  const channelName = typeof channel === 'string' ? channel : (channel.name ?? '')
  const safeChannelId = channelId ? escapeSqlString(channelId) : ''
  const safeChannelName = channelName ? escapeSqlString(channelName) : ''
  let match = ''
  if (safeChannelId && safeChannelName)
    match = `(blob5 = '${safeChannelId}' OR (blob5 = '' AND blob4 = '${safeChannelName}'))`
  else if (safeChannelId)
    match = `blob5 = '${safeChannelId}'`
  else if (safeChannelName)
    match = `blob4 = '${safeChannelName}'`
  if (!match)
    return ''
  if (options.includeUnattributedGets)
    return `AND (${match} OR (blob3 = 'get' AND blob4 = '' AND blob5 = ''))`
  return `AND ${match}`
}

const DAY_BUCKET_CF = `formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d')`

/**
 * app_log failure rows carry the channel in blob8 (name) and blob9 (id). Rows
 * written before that have neither and stay out of a channel view.
 */
export function buildAppLogFailureChannelFilterCF(channel?: VersionUsageChannel | string | null): string {
  if (!channel)
    return ''
  const channelId = typeof channel === 'object' && channel.id ? escapeSqlString(String(channel.id)) : ''
  const channelName = escapeSqlString(typeof channel === 'string' ? channel : (channel.name ?? ''))
  if (channelId && channelName)
    return `AND (blob9 = '${channelId}' OR (blob9 = '' AND blob8 = '${channelName}'))`
  if (channelId)
    return `AND blob9 = '${channelId}'`
  if (channelName)
    return `AND blob8 = '${channelName}'`
  return ''
}

export interface LegacyDownloadFailQuery {
  appId: string
  start: string | Date
  end: string | Date
  /** Analytics Engine expression of the bucket, matching the version_usage query it corrects. */
  bucket: string
  channel?: VersionUsageChannel | string | null
  versionName?: string
}

/**
 * Legacy download_fail per bucket and version (see legacyDownloadFail.ts) that
 * version_usage still counted as fails. Never throws: without it, a read keeps
 * the recorded counts.
 */
export async function readLegacyDownloadFailsCF(c: Context, query: LegacyDownloadFailQuery): Promise<Map<string, number>> {
  if (!c.env.APP_LOG)
    return new Map()
  const versionFilter = query.versionName === undefined ? '' : `AND blob3 = '${escapeSqlString(query.versionName)}'`
  const sql = `SELECT
  ${query.bucket} AS bucket,
  blob3 AS version_name,
  blob7 AS plugin_version,
  sum(_sample_interval) AS count
FROM app_log
WHERE
  index1 = '${escapeSqlString(query.appId)}'
  AND blob2 = 'download_fail'
  AND blob7 != ''
  AND blob10 = ''
  AND timestamp >= toDateTime('${formatDateCF(query.start)}')
  AND timestamp < toDateTime('${formatDateCF(query.end)}')
  ${versionFilter}
  ${buildAppLogFailureChannelFilterCF(query.channel)}
GROUP BY bucket, version_name, plugin_version`
  try {
    return sumLegacyDownloadFails(await runQueryToCFA(c, sql))
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading legacy download_fail', error: serializeError(e), query: sql })
    return new Map()
  }
}

export interface LegacyCheckFailuresQuery {
  appId: string
  start: string | Date
  end: string | Date
  channel?: VersionUsageChannel | string | null
  versionNames?: string[]
}

export function buildLegacyCheckFailuresQueryCF(query: LegacyCheckFailuresQuery) {
  const versionFilter = query.versionNames?.length
    ? `AND blob3 IN (${query.versionNames.map(name => `'${escapeSqlString(name)}'`).join(', ')})`
    : ''
  // /stats only resolves the channel of failures it counts, so legacy logs
  // recorded since then carry none. Resolving it for them would add a lookup
  // per event on the plugin hot path, so a channel view also takes the
  // bundle's unattributed logs: bundles are rarely shared across channels,
  // and this only sizes a notice.
  const channelMatch = buildAppLogFailureChannelFilterCF(query.channel).replace(/^AND /, '')
  const channelFilter = channelMatch ? `AND (${channelMatch} OR (blob8 = '' AND blob9 = ''))` : ''
  return `SELECT
  blob3 AS version_name,
  blob7 AS plugin_version,
  sum(_sample_interval) AS count
FROM app_log
WHERE
  index1 = '${escapeSqlString(query.appId)}'
  AND blob2 = 'download_fail'
  AND ${legacyDownloadFailPluginSqlCF('blob7')}
  AND timestamp >= toDateTime('${formatDateCF(query.start)}')
  AND timestamp < toDateTime('${formatDateCF(query.end)}')
  ${versionFilter}
  ${channelFilter}
GROUP BY version_name, plugin_version`
}

/**
 * Every legacy download_fail per bundle, flagged or not, for the dashboard
 * notice that tells users to update the plugin. Never throws: without it, the
 * notice is not shown.
 */
export async function readLegacyCheckFailuresCF(c: Context, query: LegacyCheckFailuresQuery) {
  if (!c.env.APP_LOG)
    return summarizeLegacyCheckFailures([])
  const sql = buildLegacyCheckFailuresQueryCF(query)
  try {
    return summarizeLegacyCheckFailures(await runQueryToCFA(c, sql))
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading legacy check failures', error: serializeError(e), query: sql })
    return summarizeLegacyCheckFailures([])
  }
}

export async function readStatsVersionCF(c: Context, app_id: string, period_start: string, period_end: string, channel?: VersionUsageChannel | string, options: VersionUsageChannelFilterOptions = {}): Promise<VersionUsage[]> {
  if (!c.env.VERSION_USAGE)
    return []
  // Note: blob2 contains version_name for new data and version_id (numeric) for old data.
  const channelFilter = buildVersionUsageChannelFilterCF(channel, options)
  const query = `SELECT
  blob1 as app_id,
  blob2 as version_name,
  ${DAY_BUCKET_CF} AS date,
  sum(if(blob3 = 'get', _sample_interval, 0)) AS get,
  sum(if(blob3 = 'fail', _sample_interval, 0)) AS fail,
  sum(if(blob3 = 'install', _sample_interval, 0)) AS install,
  sum(if(blob3 = 'uninstall', _sample_interval, 0)) AS uninstall
FROM version_usage
WHERE
  index1 = '${escapeSqlString(app_id)}'
  AND timestamp >= toDateTime('${formatDateCF(period_start)}')
  AND timestamp < toDateTime('${formatDateCF(period_end)}')
  ${channelFilter}
GROUP BY date, app_id, version_name
ORDER BY date`

  cloudlog({ requestId: c.get('requestId'), message: 'readStatsVersionCF query', query })
  try {
    const [usage, legacyFails] = await Promise.all([
      runQueryToCFA<VersionUsage>(c, query),
      readLegacyDownloadFailsCF(c, { appId: app_id, start: period_start, end: period_end, bucket: DAY_BUCKET_CF, channel }),
    ])
    return subtractLegacyDownloadFails(usage, row => legacyDownloadFailKey(row.date, row.version_name), legacyFails)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading version usage', error: serializeError(e), query })
  }
  return []
}

export async function readNativeVersionUsageCF(c: Context, app_id: string, period_start: string, period_end: string): Promise<NativeVersionUsage[]> {
  if (!c.env.DEVICE_USAGE)
    return []

  const query = `SELECT
  formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
  if(blob4 != '', blob4, if(double1 = 1, 'ios', if(double1 = 2, 'electron', if(double1 = 0, 'android', 'unknown')))) AS platform,
  if(blob3 = '', 'unknown', blob3) AS version_build,
  COUNT(DISTINCT blob1) AS devices
FROM device_usage
WHERE
  index1 = '${escapeSqlString(app_id)}'
  AND timestamp >= toDateTime('${formatDateCF(period_start)}')
  AND timestamp < toDateTime('${formatDateCF(period_end)}')
GROUP BY date, platform, version_build
ORDER BY date, platform, version_build`

  cloudlog({ requestId: c.get('requestId'), message: 'readNativeVersionUsageCF query', query })
  try {
    return await runQueryToCFA<NativeVersionUsage>(c, query)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading native version usage', error: serializeError(e), query })
  }
  return []
}

export async function readNativeActiveDevicesSummaryCF(
  c: Context,
  app_id: string,
  period_start: string,
  period_end: string,
): Promise<NativeActiveDevicesByPlatformRow[]> {
  if (!c.env.DEVICE_USAGE)
    return []

  const platformQuery = `SELECT
  if(blob4 != '', blob4, if(double1 = 1, 'ios', if(double1 = 2, 'electron', if(double1 = 0, 'android', 'unknown')))) AS platform,
  COUNT(DISTINCT blob1) AS devices
FROM device_usage
WHERE
  index1 = '${escapeSqlString(app_id)}'
  AND timestamp >= toDateTime('${formatDateCF(period_start)}')
  AND timestamp < toDateTime('${formatDateCF(period_end)}')
GROUP BY platform
ORDER BY platform`

  const totalQuery = `SELECT
  COUNT(DISTINCT blob1) AS devices
FROM device_usage
WHERE
  index1 = '${escapeSqlString(app_id)}'
  AND timestamp >= toDateTime('${formatDateCF(period_start)}')
  AND timestamp < toDateTime('${formatDateCF(period_end)}')`

  cloudlog({ requestId: c.get('requestId'), message: 'readNativeActiveDevicesSummaryCF query', query: platformQuery })
  try {
    const [platformRows, totalRows] = await Promise.all([
      runQueryToCFA<{ platform: string, devices: number | string }>(c, platformQuery),
      runQueryToCFA<{ devices: number | string }>(c, totalQuery),
    ])

    const rows = platformRows.map(row => ({
      platform: row.platform || 'unknown',
      devices: Math.max(0, Number(row.devices) || 0),
    }))

    rows.push({
      platform: 'total',
      devices: Math.max(0, Number(totalRows[0]?.devices) || 0),
    })

    return rows
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading native active devices summary', error: serializeError(e), query: platformQuery })
    throw e
  }
}

export async function readNativeDailyPlatformActiveCF(
  c: Context,
  app_id: string,
  period_start: string,
  period_end: string,
): Promise<Array<{ date: string, platform: string, devices: number }>> {
  if (!c.env.DEVICE_USAGE)
    return []

  const whereClause = `index1 = '${escapeSqlString(app_id)}'
  AND timestamp >= toDateTime('${formatDateCF(period_start)}')
  AND timestamp < toDateTime('${formatDateCF(period_end)}')`

  const platformQuery = `SELECT
  formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
  if(blob4 != '', blob4, if(double1 = 1, 'ios', if(double1 = 2, 'electron', if(double1 = 0, 'android', 'unknown')))) AS platform,
  COUNT(DISTINCT blob1) AS devices
FROM device_usage
WHERE
  ${whereClause}
GROUP BY date, platform
ORDER BY date, platform`

  const totalQuery = `SELECT
  formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
  'total' AS platform,
  COUNT(DISTINCT blob1) AS devices
FROM device_usage
WHERE
  ${whereClause}
GROUP BY date
ORDER BY date`

  cloudlog({ requestId: c.get('requestId'), message: 'readNativeDailyPlatformActiveCF query', query: platformQuery })
  try {
    const [platformRows, totalRows] = await Promise.all([
      runQueryToCFA<{ date: string, platform: string, devices: number | string }>(c, platformQuery),
      runQueryToCFA<{ date: string, platform: string, devices: number | string }>(c, totalQuery),
    ])

    const rows = [
      ...platformRows.map(row => ({
        date: row.date,
        platform: row.platform || 'unknown',
        devices: Math.max(0, Number(row.devices) || 0),
      })),
      ...totalRows.map(row => ({
        date: row.date,
        platform: 'total',
        devices: Math.max(0, Number(row.devices) || 0),
      })),
    ]

    rows.sort((left, right) => {
      if (left.date !== right.date)
        return left.date < right.date ? -1 : 1
      if (left.platform === right.platform)
        return 0
      return left.platform < right.platform ? -1 : 1
    })

    return rows
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading native daily platform active', error: serializeError(e), queries: { platformQuery, totalQuery } })
    throw e
  }
}

function buildDeviceIdListCF(deviceIds: string[]) {
  return deviceIds.map(id => `'${escapeSqlString(id)}'`).join(', ')
}

// device_info double1: 0 = android, 1 = ios, 2 = electron
const DEVICE_INFO_PLATFORM_VALUES: Record<ChannelDevicePlatform, number> = { android: 0, ios: 1, electron: 2 }

/**
 * Channel scope for device_info rows by effective channel: the device-reported
 * default_channel (or no reported channel on platforms where this channel is the
 * public default), minus devices forced to another channel, plus devices forced
 * into this channel through channel_devices. Override ids are lowercased by
 * partitionChannelDeviceOverrides, so device ids are compared lowercased too.
 */
export function buildDeviceChannelScopeCF(channelName: string, overrides?: ChannelDeviceOverrideIds): string {
  const reportedMatch = `default_channel = '${escapeSqlString(channelName)}'`
  const defaultPlatforms = (overrides?.defaultForPlatforms ?? []).map(platform => DEVICE_INFO_PLATFORM_VALUES[platform])
  const defaultChannelMatch = defaultPlatforms.length
    ? `(${reportedMatch} OR (default_channel = '' AND platform IN (${defaultPlatforms.join(', ')})))`
    : reportedMatch
  const elsewhere = overrides?.elsewhere ?? []
  const into = overrides?.into ?? []
  const byDefaultChannel = elsewhere.length
    ? `(${defaultChannelMatch} AND lower(device_id) NOT IN (${buildDeviceIdListCF(elsewhere)}))`
    : defaultChannelMatch
  if (!into.length)
    return byDefaultChannel
  return `(${byDefaultChannel} OR lower(device_id) IN (${buildDeviceIdListCF(into)}))`
}

export function buildDeviceVersionCountsCFQuery(app_id: string, channelName?: string, overrides?: ChannelDeviceOverrideIds) {
  const channelFilter = channelName ? `AND ${buildDeviceChannelScopeCF(channelName, overrides)}` : ''

  return `SELECT
  version_name,
  count() AS device_count
FROM (
  SELECT
    argMax(blob2, timestamp) AS version_name,
    argMax(blob7, timestamp) AS default_channel,
    argMax(double1, timestamp) AS platform,
    blob1 AS device_id
  FROM device_info
  WHERE index1 = '${escapeSqlString(app_id)}'
  GROUP BY blob1
)
WHERE version_name != '' ${channelFilter}
GROUP BY version_name`
}

export async function readDeviceVersionCountsCF(c: Context, app_id: string, channelName?: string, overrides?: ChannelDeviceOverrideIds): Promise<Record<string, number>> {
  if (!c.env.DEVICE_INFO)
    return {}

  const query = buildDeviceVersionCountsCFQuery(app_id, channelName, overrides)

  cloudlog({ requestId: c.get('requestId'), message: 'readDeviceVersionCountsCF query', query })
  try {
    const result = await runQueryToCFA<{ version_name: string, device_count: number }>(c, query)
    return result.reduce<Record<string, number>>((acc, row) => {
      acc[row.version_name] = row.device_count
      return acc
    }, {})
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading device version counts from Analytics Engine', error: serializeError(e), query })
  }
  return {}
}

function buildInstallSourceList(installSources: string[]) {
  return installSources.map(source => `'${escapeSqlString(source)}'`).join(', ')
}
export function buildDeviceIdsByInstallSourcesQuery(app_id: string, installSources: string[]) {
  return `SELECT blob1 AS device_id
FROM (
  SELECT
    blob1,
    argMax(blob9, timestamp) AS install_source
  FROM device_info
  WHERE index1 = '${escapeSqlString(app_id)}' AND blob9 != ''
  GROUP BY blob1
)
WHERE install_source IN (${buildInstallSourceList(installSources)})`
}

async function readDeviceIdsByInstallSourcesCF(c: Context, app_id: string, installSources: string[]): Promise<string[]> {
  const query = buildDeviceIdsByInstallSourcesQuery(app_id, installSources)
  cloudlog({ requestId: c.get('requestId'), message: 'readDeviceIdsByInstallSourcesCF query', query })
  const res = await runQueryToCFA<{ device_id: string }>(c, query)
  return res.map(row => row.device_id)
}

export async function countInstallSourcesCF(c: Context, app_id: string): Promise<Record<string, number>> {
  const cache = new CacheHelper(c)
  const cacheKey = cache.buildRequest('/internal/install-source-counts', { app_id })
  const cached = await cache.matchJson<Record<string, number>>(cacheKey)
  if (cached)
    return cached

  const query = `SELECT
  install_source,
  COUNT() AS total
FROM (
  SELECT
    blob1 AS device_id,
    argMax(blob9, timestamp) AS install_source
  FROM device_info
  WHERE index1 = '${escapeSqlString(app_id)}'
  GROUP BY blob1
)
WHERE install_source != ''
GROUP BY install_source`

  cloudlog({ requestId: c.get('requestId'), message: 'countInstallSourcesCF query', query })
  const res = await runQueryToCFA<{ install_source: string, total: number }>(c, query)
  const counts = res.reduce<Record<string, number>>((acc, row) => {
    acc[row.install_source] = row.total
    return acc
  }, {})
  await cache.putJson(cacheKey, counts, INSTALL_SOURCE_COUNT_CACHE_TTL_SECONDS)
  return counts
}

function platformOsToCFDouble(platform: Database['public']['Enums']['platform_os']): number {
  if (platform === 'ios')
    return 1
  if (platform === 'electron')
    return 2
  return 0
}

function normalizeVersionNameFilter(versionName: string | string[] | undefined): string[] {
  if (!versionName)
    return []
  const names = (Array.isArray(versionName) ? versionName : [versionName])
    .map(name => name.trim())
    .filter(Boolean)
  return [...new Set(names)]
}

function buildVersionNameSqlCondition(versionName: string | string[] | undefined): string {
  const names = normalizeVersionNameFilter(versionName)
  if (!names.length)
    return ''
  if (names.length === 1)
    return `version_name = '${escapeSqlString(names[0]!)}'`
  return `version_name IN (${names.map(name => `'${escapeSqlString(name)}'`).join(', ')})`
}

export async function countDevicesCF(
  c: Context,
  app_id: string,
  customIdMode: boolean,
  deviceIds: string[] = [],
  versionName?: string | string[],
  search?: string,
  options?: {
    platform?: Database['public']['Enums']['platform_os']
    defaultChannel?: string
    updatedAt?: { gt?: string, lte?: string }
    osVersionCompare?: ReadDevicesParams['os_version_compare']
    versionNameCompare?: ReadDevicesParams['version_name_compare']
  },
) {
  // Use Analytics Engine DEVICE_INFO for counting devices
  const platform = options?.platform
  const defaultChannel = options?.defaultChannel
  const updatedAt = options?.updatedAt
  const osVersionCondition = buildVersionCompareSql('os_version', options?.osVersionCompare, 'cf')
  const versionNameCompareCondition = buildVersionCompareSql('version_name', options?.versionNameCompare, 'cf')
  const versionNameCondition = versionNameCompareCondition ? '' : buildVersionNameSqlCondition(versionName)
  const conditions = [`index1 = '${escapeSqlString(app_id)}'`]

  if (deviceIds.length) {
    if (deviceIds.length === 1)
      conditions.push(`blob1 = '${escapeSqlString(deviceIds[0])}'`)
    else
      conditions.push(`blob1 IN (${deviceIds.map(id => `'${escapeSqlString(id)}'`).join(', ')})`)
  }

  if (updatedAt?.gt)
    conditions.push(`timestamp > toDateTime('${escapeSqlString(formatDateCF(updatedAt.gt))}')`)
  if (updatedAt?.lte)
    conditions.push(`timestamp <= toDateTime('${escapeSqlString(formatDateCF(updatedAt.lte))}')`)

  // Match latest aggregated fields for current-state filtering (same as Supabase devices table).
  // customIdMode must use aggregated custom_id so historical non-empty blob5 rows
  // do not keep devices that later cleared their custom id.
  if (versionNameCondition || versionNameCompareCondition || osVersionCondition || platform || defaultChannel || search || customIdMode) {
    const outerConditions: string[] = []
    if (customIdMode)
      outerConditions.push(`custom_id != ''`)
    if (versionNameCondition)
      outerConditions.push(versionNameCondition)
    if (versionNameCompareCondition)
      outerConditions.push(versionNameCompareCondition)
    if (osVersionCondition)
      outerConditions.push(osVersionCondition)
    if (platform)
      outerConditions.push(`platform = ${platformOsToCFDouble(platform)}`)
    if (defaultChannel)
      outerConditions.push(`default_channel = '${escapeSqlString(defaultChannel)}'`)
    if (search) {
      const searchLower = search.toLowerCase()
      if (deviceIds.length) {
        outerConditions.push(`(position('${escapeSqlString(searchLower)}' IN toLower(custom_id)) > 0 OR position('${escapeSqlString(searchLower)}' IN toLower(version_name)) > 0)`)
      }
      else {
        outerConditions.push(`(position('${escapeSqlString(searchLower)}' IN toLower(device_id)) > 0 OR position('${escapeSqlString(searchLower)}' IN toLower(custom_id)) > 0 OR position('${escapeSqlString(searchLower)}' IN toLower(version_name)) > 0)`)
      }
    }

    const query = `SELECT COUNT() AS total
FROM (
  SELECT
    argMax(blob1, timestamp) AS device_id,
    argMax(blob2, timestamp) AS version_name,
    argMax(blob4, timestamp) AS os_version,
    argMax(blob5, timestamp) AS custom_id,
    argMax(blob7, timestamp) AS default_channel,
    argMax(double1, timestamp) AS platform
  FROM device_info
  WHERE ${conditions.join(' AND ')}
  GROUP BY blob1
)
WHERE ${outerConditions.join(' AND ')}`

    cloudlog({ requestId: c.get('requestId'), message: 'countDevicesCF query', query })
    try {
      const res = await runQueryToCFA<{ total: number }>(c, query)
      return res[0]?.total ?? 0
    }
    catch (e) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading device count from Analytics Engine', error: serializeError(e), query })
    }
    return 0
  }

  const query = `SELECT COUNT(DISTINCT blob1) AS total
FROM device_info
WHERE ${conditions.join(' AND ')}`

  cloudlog({ requestId: c.get('requestId'), message: 'countDevicesCF query', query })
  try {
    const res = await runQueryToCFA<{ total: number }>(c, query)
    return res[0]?.total ?? 0
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading device count from Analytics Engine', error: serializeError(e), query })
  }
  return 0
}

interface DeviceInfoCF {
  device_id: string
  version_name: string
  plugin_version: string
  os_version: string
  custom_id: string
  version_build: string
  default_channel: string
  key_id: string
  install_source: string
  country_code?: string
  platform: number // 0 = android, 1 = ios
  is_prod: number // 0 or 1
  is_emulator: number // 0 or 1
  updated_at: string
}

interface DevicesOrderCF {
  ascending: boolean
}

function getReadDevicesCFOrder(params: ReadDevicesParams): DevicesOrderCF | null {
  const activeOrder = params.order?.find(
    col => col.key === 'updated_at' && typeof col.sortable === 'string',
  )

  return activeOrder ? { ascending: activeOrder.sortable === 'asc' } : null
}

function buildReadDevicesCFCursorCondition(cursor: string | undefined, devicesOrder: DevicesOrderCF | null) {
  if (!cursor)
    return ''

  const [cursorTime, cursorDeviceId] = cursor.split('|')
  if (!(cursorTime && cursorDeviceId))
    return ''

  const safeCursorDeviceId = escapeSqlString(cursorDeviceId)
  if (!devicesOrder)
    return `device_id > '${safeCursorDeviceId}'`

  const safeCursorTime = escapeSqlString(cursorTime)
  const comparison = devicesOrder.ascending ? '>' : '<'

  return `(updated_at ${comparison} toDateTime('${safeCursorTime}') OR (updated_at = toDateTime('${safeCursorTime}') AND device_id > '${safeCursorDeviceId}'))`
}

function buildReadDevicesCFUpdatedAtGtCondition(updatedAtGt: string | undefined) {
  if (!updatedAtGt)
    return ''

  const safeUpdatedAtGt = escapeSqlString(formatDateCF(updatedAtGt))
  return `updated_at > toDateTime('${safeUpdatedAtGt}')`
}
function buildReadDevicesCFUpdatedAtLteCondition(updatedAtLte: string | undefined) {
  if (!updatedAtLte)
    return ''
  const safeUpdatedAtLte = escapeSqlString(formatDateCF(updatedAtLte))
  return `updated_at <= toDateTime('${safeUpdatedAtLte}')`
}

function buildReadDevicesCFCustomIdsCondition(customIds: string[] | undefined) {
  if (!customIds?.length)
    return ''

  if (customIds.length === 1)
    return `custom_id = '${escapeSqlString(customIds[0])}'`

  const customIdsList = customIds.map(id => `'${escapeSqlString(id)}'`).join(', ')
  return `custom_id IN (${customIdsList})`
}

function buildReadDevicesCFPlatformCondition(platform: ReadDevicesParams['platform']) {
  if (!platform)
    return ''
  return `platform = ${platformOsToCFDouble(platform)}`
}

function buildReadDevicesCFDefaultChannelCondition(defaultChannel: ReadDevicesParams['default_channel']) {
  if (!defaultChannel)
    return ''
  return `default_channel = '${escapeSqlString(defaultChannel)}'`
}

function buildReadDevicesCFVersionNameCondition(versionName: ReadDevicesParams['version_name']) {
  return buildVersionNameSqlCondition(versionName)
}

function buildReadDevicesCFSearchCondition(search: string | undefined, deviceIds: string[] | undefined) {
  if (!search)
    return undefined
  const searchLower = search.toLowerCase()
  if (deviceIds?.length) {
    return `(position('${escapeSqlString(searchLower)}' IN toLower(custom_id)) > 0 OR position('${escapeSqlString(searchLower)}' IN toLower(version_name)) > 0)`
  }
  return `(position('${escapeSqlString(searchLower)}' IN toLower(device_id)) > 0 OR position('${escapeSqlString(searchLower)}' IN toLower(custom_id)) > 0 OR position('${escapeSqlString(searchLower)}' IN toLower(version_name)) > 0)`
}

function buildReadDevicesCFOuterConditions(params: ReadDevicesParams, devicesOrder: DevicesOrderCF | null, customIdMode: boolean) {
  return [
    buildReadDevicesCFCursorCondition(params.cursor, devicesOrder),
    buildReadDevicesCFUpdatedAtGtCondition(params.updated_at_gt),
    buildReadDevicesCFUpdatedAtLteCondition(params.updated_at_lte),
    // Match the latest aggregated custom_id, not historical event rows.
    customIdMode ? `custom_id != ''` : undefined,
    buildReadDevicesCFCustomIdsCondition(params.customIds),
    // Match the latest aggregated platform/version/search, not historical event rows.
    buildReadDevicesCFPlatformCondition(params.platform),
    buildReadDevicesCFDefaultChannelCondition(params.default_channel),
    params.version_name_compare
      ? buildVersionCompareSql('version_name', params.version_name_compare, 'cf')
      : buildReadDevicesCFVersionNameCondition(params.version_name),
    buildVersionCompareSql('os_version', params.os_version_compare, 'cf'),
    buildReadDevicesCFSearchCondition(params.search, params.deviceIds),
  ].filter((condition): condition is string => Boolean(condition))
}

export function buildReadDevicesCFQuery(params: ReadDevicesParams, customIdMode: boolean) {
  const limit = normalizeAnalyticsLimit(params.limit)
  const conditions: string[] = [`index1 = '${escapeSqlString(params.app_id)}'`]

  if (params.deviceIds?.length) {
    if (params.deviceIds.length === 1) {
      conditions.push(`blob1 = '${escapeSqlString(params.deviceIds[0])}'`)
    }
    else {
      const devicesList = params.deviceIds.map(id => `'${escapeSqlString(id)}'`).join(', ')
      conditions.push(`blob1 IN (${devicesList})`)
    }
  }

  if (params.updated_at_gt) {
    const safeUpdatedAtGt = escapeSqlString(formatDateCF(params.updated_at_gt))
    conditions.push(`timestamp > toDateTime('${safeUpdatedAtGt}')`)
  }

  if (params.updated_at_lte) {
    const safeUpdatedAtLte = escapeSqlString(formatDateCF(params.updated_at_lte))
    conditions.push(`timestamp <= toDateTime('${safeUpdatedAtLte}')`)
  }

  const devicesOrder = getReadDevicesCFOrder(params)
  const outerConditions = buildReadDevicesCFOuterConditions(params, devicesOrder, customIdMode)
  const includeCountryCode = !!params.deviceIds?.length
  const outerFilter = outerConditions.length ? `WHERE ${outerConditions.join(' AND ')}` : ''
  let orderBy = 'device_id ASC'
  if (devicesOrder) {
    const updatedAtDirection = devicesOrder.ascending ? 'ASC' : 'DESC'
    orderBy = `updated_at ${updatedAtDirection}, device_id ASC`
  }

  return [
    'SELECT *',
    'FROM (',
    '  SELECT',
    '    argMax(blob1, timestamp) AS device_id,',
    '    argMax(blob2, timestamp) AS version_name,',
    '    argMax(blob3, timestamp) AS plugin_version,',
    '    argMax(blob4, timestamp) AS os_version,',
    '    argMax(blob5, timestamp) AS custom_id,',
    '    argMax(blob6, timestamp) AS version_build,',
    '    argMax(blob7, timestamp) AS default_channel,',
    '    argMax(blob8, timestamp) AS key_id,',
    ...(includeCountryCode ? ['    argMax(blob10, if(blob10 != \'\', timestamp, toDateTime(\'1970-01-01 00:00:00\'))) AS country_code,'] : []),
    '    argMax(double1, timestamp) AS platform,',
    '    argMax(double2, timestamp) AS is_prod,',
    '    argMax(double3, timestamp) AS is_emulator,',
    '    max(timestamp) AS updated_at',
    '  FROM device_info',
    `  WHERE ${conditions.join(' AND ')}`,
    '  GROUP BY blob1',
    ')',
    outerFilter,
    `ORDER BY ${orderBy}`,
    `LIMIT ${limit + 1}`,
  ].filter(Boolean).join('\n')
}

/**
 * Read device metadata from the Analytics Engine, respecting search, version, custom ID, and cursor filters.
 */
export async function readDevicesCF(c: Context, params: ReadDevicesParams, customIdMode: boolean): Promise<DeviceRes[]> {
  // Use Analytics Engine DEVICE_INFO for reading devices
  // Schema: blob1=device_id, blob2=version_name, blob3=plugin_version, blob4=os_version,
  //         blob5=custom_id, blob6=version_build, blob7=default_channel, blob8=key_id, blob9=install_source, blob10=country_code
  //         double1=platform (0=android, 1=ios), double2=is_prod, double3=is_emulator
  //         index1=app_id, timestamp=updated_at

  if (params.deviceIds?.length) {
    cloudlog({ requestId: c.get('requestId'), message: 'deviceIds', deviceIdsCount: params.deviceIds.length })
  }

  if (params.search) {
    cloudlog({ requestId: c.get('requestId'), message: 'search', searchLength: params.search.length })
  }

  let readParams = params
  if (params.installSources?.length) {
    const sourceDeviceIds = await readDeviceIdsByInstallSourcesCF(c, params.app_id, params.installSources)
    if (!sourceDeviceIds.length)
      return [] as DeviceRes[]

    const sourceDeviceIdSet = new Set(sourceDeviceIds)
    const deviceIds = params.deviceIds?.length
      ? params.deviceIds.filter(deviceId => sourceDeviceIdSet.has(deviceId))
      : sourceDeviceIds
    if (!deviceIds.length)
      return [] as DeviceRes[]

    readParams = {
      ...params,
      deviceIds,
      installSources: undefined,
    }
  }

  const query = buildReadDevicesCFQuery(readParams, customIdMode)

  cloudlog({ requestId: c.get('requestId'), message: 'readDevicesCF query', query })
  try {
    const res = await runQueryToCFA<DeviceInfoCF>(c, query)
    cloudlog({ requestId: c.get('requestId'), message: 'readDevicesCF res', resLength: res.length })

    // Convert Analytics Engine results to Database device format
    const results = res.map(row => ({
      app_id: params.app_id,
      device_id: row.device_id,
      version: null, // version ID not stored in Analytics Engine
      version_name: row.version_name || null,
      platform: row.platform === 1 ? 'ios' : row.platform === 2 ? 'electron' : row.platform === 0 ? 'android' : null,
      plugin_version: row.plugin_version,
      os_version: row.os_version,
      version_build: row.version_build,
      is_prod: row.is_prod < 0 ? null : Boolean(row.is_prod),
      is_emulator: row.is_emulator < 0 ? null : Boolean(row.is_emulator),
      country_code: row.country_code || null,
      install_source: row.install_source || null,
      custom_id: row.custom_id,
      updated_at: formatDateCF(row.updated_at),
      default_channel: row.default_channel || null,
      created_at: null, // Not stored in Analytics Engine
      key_id: row.key_id || null,
    })) as DeviceRes[]

    return results
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading device list from Analytics Engine', error: serializeError(e), query })
  }
  return [] as DeviceRes[]
}

const DEVICE_PLATFORM_CHANNEL_LOOKUP_CHUNK = 200
const DEVICE_PLATFORM_CHANNEL_LOOKUP_CONCURRENCY = 4

function platformOsFromCFDouble(platform: number | null | undefined): string {
  if (platform === 1)
    return 'ios'
  if (platform === 2)
    return 'electron'
  if (platform === 0)
    return 'android'
  return 'unknown'
}

/**
 * Resolve latest platform + default_channel for a set of device ids from DEVICE_INFO.
 * Used by native observe version breakdown when grouping by platform/channel.
 */
export async function readDevicePlatformChannelByIdsCF(
  c: Context,
  appId: string,
  deviceIds: string[],
): Promise<Map<string, { platform: string, channel_name: string }>> {
  const result = new Map<string, { platform: string, channel_name: string }>()
  if (!c.env.DEVICE_INFO || !deviceIds.length)
    return result

  const uniqueIds = [...new Set(deviceIds.filter(Boolean))]
  const chunks: string[][] = []
  for (let i = 0; i < uniqueIds.length; i += DEVICE_PLATFORM_CHANNEL_LOOKUP_CHUNK)
    chunks.push(uniqueIds.slice(i, i + DEVICE_PLATFORM_CHANNEL_LOOKUP_CHUNK))

  if (!chunks.length)
    return result

  let chunkCursor = 0
  async function lookupChunk(chunk: string[]) {
    const devicesList = chunk.map(id => `'${escapeSqlString(id)}'`).join(', ')
    const query = `SELECT
  device_id,
  platform,
  channel_name
FROM (
  SELECT
    blob1 AS device_id,
    argMax(double1, timestamp) AS platform,
    argMax(blob7, timestamp) AS channel_name
  FROM device_info
  WHERE index1 = '${escapeSqlString(appId)}'
    AND blob1 IN (${devicesList})
  GROUP BY blob1
)`

    cloudlog({ requestId: c.get('requestId'), message: 'readDevicePlatformChannelByIdsCF query', deviceCount: chunk.length })
    try {
      const rows = await runQueryToCFA<{ device_id: string, platform: number, channel_name: string }>(c, query)
      for (const row of rows) {
        result.set(row.device_id, {
          platform: platformOsFromCFDouble(row.platform),
          channel_name: row.channel_name?.trim() ? row.channel_name : 'unknown',
        })
      }
    }
    catch (e) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading device platform/channel map', error: serializeError(e), query })
    }
  }

  async function lookupWorker() {
    while (chunkCursor < chunks.length) {
      const chunk = chunks[chunkCursor++]!
      await lookupChunk(chunk)
    }
  }

  const workerCount = Math.min(DEVICE_PLATFORM_CHANNEL_LOOKUP_CONCURRENCY, chunks.length)
  await Promise.all(Array.from({ length: workerCount }, () => lookupWorker()))

  return result
}

interface StatRowCF {
  app_id: string
  device_id: string
  action: string
  version_name: string
  metadata: string | null
  created_at: string
}

export async function readStatsCF(c: Context, params: ReadStatsParams) {
  if (!c.env.APP_LOG)
    return [] as StatRowCF[]

  const limit = normalizeAnalyticsLimit(params.limit)

  let deviceFilter = ''

  if (params.deviceIds?.length) {
    cloudlog({ requestId: c.get('requestId'), message: 'deviceIds', deviceIds: params.deviceIds })
    if (params.deviceIds.length === 1) {
      deviceFilter = `AND device_id = '${escapeSqlString(params.deviceIds[0])}'`
    }
    else {
      const devicesList = params.deviceIds.map(id => `'${escapeSqlString(id)}'`).join(',')
      deviceFilter = `AND device_id IN (${devicesList})`
    }
  }

  let actionsFilter = ''
  if (params.actions?.length) {
    cloudlog({ requestId: c.get('requestId'), message: 'actions filter', actions: params.actions })
    if (params.actions.length === 1) {
      actionsFilter = `AND action = '${escapeSqlString(params.actions[0])}'`
    }
    else {
      const actionsList = params.actions.map(a => `'${escapeSqlString(a)}'`).join(',')
      actionsFilter = `AND action IN (${actionsList})`
    }
  }

  let versionFilter = ''
  if (params.version_name) {
    versionFilter = `AND blob3 = '${escapeSqlString(params.version_name)}'`
  }

  let searchFilter = ''
  if (params.search) {
    const searchLower = params.search.toLowerCase()
    if (params.deviceIds?.length)
      searchFilter = `AND (position('${escapeSqlString(searchLower)}' IN toLower(action)) > 0 OR position('${escapeSqlString(searchLower)}' IN toLower(blob3)) > 0 OR position('${escapeSqlString(searchLower)}' IN toLower(blob4)) > 0)`
    else
      searchFilter = `AND (position('${escapeSqlString(searchLower)}' IN toLower(device_id)) > 0 OR position('${escapeSqlString(searchLower)}' IN toLower(action)) > 0 OR position('${escapeSqlString(searchLower)}' IN toLower(blob3)) > 0 OR position('${escapeSqlString(searchLower)}' IN toLower(blob4)) > 0)`
  }
  const orderFilters: string[] = []
  const allowedOrderKeys = new Set(['created_at', 'app_id', 'device_id', 'action', 'version_name'])
  if (params.order?.length) {
    params.order.forEach((col) => {
      if (col.sortable && typeof col.sortable === 'string') {
        if (!allowedOrderKeys.has(col.key))
          return
        cloudlog({ requestId: c.get('requestId'), message: 'order', colKey: col.key, colSortable: col.sortable })
        orderFilters.push(`${col.key} ${col.sortable.toUpperCase()}`)
      }
    })
  }
  const orderFilter = orderFilters.length ? `ORDER BY ${orderFilters.join(', ')}` : ''
  const startFilter = params.start_date ? `AND created_at >= toDateTime('${formatDateCF(params.start_date)}')` : ''
  const endFilter = params.end_date ? `AND created_at < toDateTime('${formatDateCF(params.end_date)}')` : ''
  const query = `SELECT
  index1 as app_id,
  blob1 as device_id,
  blob2 as action,
  blob3 as version_name,
  blob4 as metadata,
  timestamp as created_at
FROM app_log
WHERE
  app_id = '${escapeSqlString(params.app_id)}' ${deviceFilter} ${actionsFilter} ${versionFilter} ${searchFilter} ${startFilter} ${endFilter}
GROUP BY app_id, created_at, action, device_id, version_name, metadata
${orderFilter}
LIMIT ${limit}`

  cloudlog({ requestId: c.get('requestId'), message: 'readStatsCF query', query })
  try {
    const rows = await runQueryToCFA<StatRowCF>(c, query)
    return rows.map(row => ({
      ...row,
      metadata: parseStatsMetadata(row.metadata),
    }))
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading stats list', error: serializeError(e), query })
  }
  return [] as StatRowCF[]
}

export interface UpdateDeliveryTimingEventCF {
  app_id: string
  device_id: string
  action: string
  version_name: string
  metadata: StatsMetadata | null
  /** Duration from Analytics Engine double1 when plugins report timing. */
  duration_ms: number | null
  created_at: string
}

/** Prefer AE double1, then stats metadata duration fields. */
export function resolveUpdateDeliveryTimingDurationMs(event: UpdateDeliveryTimingEventCF): number | null {
  if (typeof event.duration_ms === 'number' && Number.isFinite(event.duration_ms) && event.duration_ms > 0 && event.duration_ms <= MAX_STATS_DURATION_MS)
    return event.duration_ms
  return parseStatsDurationMs(event.metadata)
}

export interface ReadUpdateDeliveryTimingEventsCFParams {
  start_date: string
  end_date: string
  actions: string[]
  /** When set, restrict to these app ids. Omit for platform-wide scans. */
  app_ids?: string[]
  /** When set, restrict to these version names (blob3). */
  version_names?: string[]
  after_cursor?: {
    created_at: string
    app_id: string
    device_id: string
    action: string
  }
  limit?: number
}

export function buildUpdateDeliveryTimingEventsCFQuery(params: ReadUpdateDeliveryTimingEventsCFParams): string {
  const limit = normalizeAnalyticsLimit(params.limit, MAX_ANALYTICS_QUERY_LIMIT)
  const actionsList = params.actions.map(action => `'${escapeSqlString(action)}'`).join(', ')
  const appFilter = params.app_ids?.length
    ? (
        params.app_ids.length === 1
          ? `AND index1 = '${escapeSqlString(params.app_ids[0])}'`
          : `AND index1 IN (${params.app_ids.map(id => `'${escapeSqlString(id)}'`).join(', ')})`
      )
    : ''
  const versionFilter = params.version_names?.length
    ? (
        params.version_names.length === 1
          ? `AND blob3 = '${escapeSqlString(params.version_names[0]!)}'`
          : `AND blob3 IN (${params.version_names.map(name => `'${escapeSqlString(name)}'`).join(', ')})`
      )
    : ''
  const cursorFilter = params.after_cursor
    ? `AND (
  timestamp > toDateTime('${formatDateCF(params.after_cursor.created_at)}')
  OR (
    timestamp = toDateTime('${formatDateCF(params.after_cursor.created_at)}')
    AND (
      index1 > '${escapeSqlString(params.after_cursor.app_id)}'
      OR (
        index1 = '${escapeSqlString(params.after_cursor.app_id)}'
        AND blob1 > '${escapeSqlString(params.after_cursor.device_id)}'
      )
      OR (
        index1 = '${escapeSqlString(params.after_cursor.app_id)}'
        AND blob1 = '${escapeSqlString(params.after_cursor.device_id)}'
        AND blob2 > '${escapeSqlString(params.after_cursor.action)}'
      )
    )
  )
)`
    : ''

  return `SELECT
  index1 AS app_id,
  blob1 AS device_id,
  blob2 AS action,
  blob3 AS version_name,
  blob4 AS metadata,
  double1 AS duration_ms,
  timestamp AS created_at
FROM app_log
WHERE
  timestamp >= toDateTime('${formatDateCF(params.start_date)}')
  AND timestamp < toDateTime('${formatDateCF(params.end_date)}')
  AND blob2 IN (${actionsList})
  ${appFilter}
  ${versionFilter}
  ${cursorFilter}
ORDER BY created_at ASC, app_id ASC, device_id ASC, action ASC
LIMIT ${limit}`
}

export async function readUpdateDeliveryTimingEventsCF(
  c: Context,
  params: ReadUpdateDeliveryTimingEventsCFParams,
): Promise<UpdateDeliveryTimingEventCF[]> {
  if (!c.env.APP_LOG)
    return []

  if (!params.actions.length)
    return []

  // Empty app_ids array means "no apps in scope" (e.g. empty org), not platform-wide.
  if (params.app_ids?.length === 0)
    return []

  const query = buildUpdateDeliveryTimingEventsCFQuery(params)
  cloudlog({ requestId: c.get('requestId'), message: 'readUpdateDeliveryTimingEventsCF query', query })
  try {
    const rows = await runQueryToCFA<{
      app_id: string
      device_id: string
      action: string
      version_name: string
      metadata: string | null
      duration_ms: number | string | null
      created_at: string
    }>(c, query)
    return rows.map((row) => {
      const rawDuration = Number(row.duration_ms)
      return {
        app_id: row.app_id,
        device_id: row.device_id,
        action: row.action,
        version_name: row.version_name || 'unknown',
        metadata: parseStatsMetadata(row.metadata),
        duration_ms: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null,
        created_at: row.created_at,
      }
    })
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading update delivery timing events', error: serializeError(e), query })
    throw e
  }
}

export interface NativeObservePluginVersionCF {
  plugin_version: string
  devices: number
}

function nativeObservePluginDevicesSubquery(appId: string): string {
  return `SELECT
    blob1 AS device_id,
    argMax(blob3, timestamp) AS plugin_version,
    argMax(double2, timestamp) AS is_prod,
    argMax(double3, timestamp) AS is_emulator
  FROM device_info
  WHERE index1 = '${escapeSqlString(appId)}'
  GROUP BY blob1`
}

export function buildNativeObservePluginVersionsCFQuery(appId: string, limit = 12): string {
  const safeLimit = normalizeAnalyticsLimit(limit, 12)
  return `SELECT
  if(plugin_version = '', 'unknown', plugin_version) AS plugin_version,
  count() AS devices
FROM (
  ${nativeObservePluginDevicesSubquery(appId)}
)
WHERE is_prod = 1 AND is_emulator != 1
GROUP BY plugin_version
ORDER BY devices DESC, plugin_version ASC
LIMIT ${safeLimit}`
}

export function buildNativeObservePluginTotalDevicesCFQuery(appId: string): string {
  return `SELECT
  count() AS total_devices
FROM (
  ${nativeObservePluginDevicesSubquery(appId)}
)
WHERE is_prod = 1 AND is_emulator != 1`
}

export async function readNativeObservePluginVersionsCF(
  c: Context,
  appId: string,
  limit = 12,
): Promise<{ rows: NativeObservePluginVersionCF[], total_devices: number }> {
  if (!c.env.DEVICE_INFO)
    return { rows: [], total_devices: 0 }

  const versionsQuery = buildNativeObservePluginVersionsCFQuery(appId, limit)
  const totalQuery = buildNativeObservePluginTotalDevicesCFQuery(appId)
  cloudlog({ requestId: c.get('requestId'), message: 'readNativeObservePluginVersionsCF query', versionsQuery, totalQuery })
  try {
    const [rows, totalRows] = await Promise.all([
      runQueryToCFA<{ plugin_version: string, devices: number }>(c, versionsQuery),
      runQueryToCFA<{ total_devices: number }>(c, totalQuery),
    ])
    return {
      rows: rows.map(row => ({
        plugin_version: row.plugin_version || 'unknown',
        devices: Number(row.devices) || 0,
      })),
      total_devices: Number(totalRows[0]?.total_devices) || 0,
    }
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading native observe plugin versions', error: serializeError(e), versionsQuery, totalQuery })
    throw e
  }
}

function buildStatsInsightsActionFilter(actions?: string[]) {
  if (!actions?.length)
    return ''

  if (actions.length === 1)
    return `AND blob2 = '${escapeSqlString(actions[0])}'`

  const actionList = actions.map(action => `'${escapeSqlString(action)}'`).join(',')
  return `AND blob2 IN (${actionList})`
}

function buildStatsInsightsVersionFilter(versionName?: string) {
  const name = versionName?.trim()
  if (!name)
    return ''
  return `AND blob3 = '${escapeSqlString(name)}'`
}

export async function readStatsInsightsCF(c: Context, params: ReadStatsInsightsParams): Promise<StatsInsightsResult> {
  const emptyResult = emptyStatsInsights()
  if (!c.env.APP_LOG)
    return emptyResult

  const actionFilter = buildStatsInsightsActionFilter(params.actions)
  const versionFilter = buildStatsInsightsVersionFilter(params.version_name)
  const periodStart = formatDateCF(params.start_date)
  const periodEnd = formatDateCF(params.end_date)
  const baseWhere = `index1 = '${escapeSqlString(params.app_id)}'
    AND timestamp >= toDateTime('${periodStart}')
    AND timestamp < toDateTime('${periodEnd}')
    ${actionFilter}
    ${versionFilter}`

  const summaryQuery = `SELECT
    sum(_sample_interval) AS total,
    COUNT(DISTINCT blob1) AS device_count,
    COUNT(DISTINCT blob2) AS action_count
  FROM app_log
  WHERE ${baseWhere}`

  const actionsQuery = `SELECT
    blob2 AS action,
    sum(_sample_interval) AS total,
    COUNT(DISTINCT blob1) AS device_count,
    COUNT(DISTINCT blob3) AS version_count,
    min(timestamp) AS first_seen,
    max(timestamp) AS last_seen,
    argMax(blob3, timestamp) AS latest_version_name,
    argMax(blob1, timestamp) AS latest_device_id
  FROM app_log
  WHERE ${baseWhere}
  GROUP BY action
  ORDER BY total DESC
  LIMIT 20`

  const dailyQuery = `SELECT
    formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
    blob2 AS action,
    sum(_sample_interval) AS total
  FROM app_log
  WHERE ${baseWhere}
  GROUP BY date, action
  ORDER BY date ASC, total DESC`

  const versionsQuery = `SELECT
    blob2 AS action,
    blob3 AS version_name,
    sum(_sample_interval) AS total,
    COUNT(DISTINCT blob1) AS device_count,
    max(timestamp) AS last_seen
  FROM app_log
  WHERE ${baseWhere}
  GROUP BY action, version_name
  ORDER BY total DESC
  LIMIT 30`

  const devicesQuery = `SELECT
    blob2 AS action,
    blob1 AS device_id,
    sum(_sample_interval) AS total,
    argMax(blob3, timestamp) AS version_name,
    max(timestamp) AS last_seen
  FROM app_log
  WHERE ${baseWhere}
  GROUP BY action, device_id
  ORDER BY total DESC
  LIMIT 30`

  cloudlog({ requestId: c.get('requestId'), message: 'readStatsInsightsCF queries', appId: params.app_id, start: params.start_date, end: params.end_date, actions: params.actions, versionName: params.version_name })

  try {
    const [summaryRows, actionRows, dailyRows, versionRows, deviceRows] = await Promise.all([
      runQueryToCFA<StatsInsightRawSummary>(c, summaryQuery),
      runQueryToCFA<StatsInsightRawAction>(c, actionsQuery),
      runQueryToCFA<StatsInsightRawDaily>(c, dailyQuery),
      runQueryToCFA<StatsInsightRawVersion>(c, versionsQuery),
      runQueryToCFA<StatsInsightRawDevice>(c, devicesQuery),
    ])

    return normalizeStatsInsightsResult({
      summary: summaryRows[0],
      actions: actionRows,
      daily: dailyRows,
      versions: versionRows,
      devices: deviceRows,
    })
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading stats insights', error: serializeError(e), queries: { summaryQuery, actionsQuery, dailyQuery, versionsQuery, devicesQuery } })
    return emptyResult
  }
}

export async function getAppsFromCF(c: Context, referenceDate?: Date): Promise<{ app_id: string }[]> {
  if (!c.env.DB_STOREAPPS)
    return Promise.resolve([])

  const createdBeforeFilter = referenceDate ? ` AND created_at < '${formatDateCF(referenceDate)}'` : ''
  const query = `SELECT app_id FROM store_apps WHERE (onprem = 1 OR capgo = 1) AND url != ''${createdBeforeFilter}`
  cloudlog({ requestId: c.get('requestId'), message: 'getAppsFromCF query', query })
  // use c.env.DB_STORE_APPS and table store_apps
  try {
    const storeAppSession = getReplicaReadStoreAppSession(c)
      .prepare(query)
      .all()
    const res = await storeAppSession
    if (res.error || !res.results || !res.success)
      cloudlogErr({ requestId: c.get('requestId'), message: 'getAppsFromCF error', error: res.error })
    return res.results as { app_id: string }[]
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading app list', error: serializeError(e), query })
  }
  return []
}

export async function countUpdatesFromLogsCF(c: Context, referenceDate?: Date): Promise<number> {
  const endFilter = referenceDate ? ` AND timestamp < toDateTime('${formatDateCF(referenceDate)}')` : ''
  const query = `SELECT SUM(_sample_interval) AS count FROM app_log WHERE blob2 = 'get'${endFilter}`

  cloudlog({ requestId: c.get('requestId'), message: 'countUpdatesFromLogsCF query', query })
  try {
    const readAnalytics = await runQueryToCFA<{ count: number }>(c, query)
    return readAnalytics[0].count
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error counting updates from logs', error: serializeError(e) })
  }
  return 0
}

export async function countUpdatesFromLogsExternalCF(c: Context, referenceDate?: Date): Promise<number> {
  const endFilter = referenceDate ? ` AND timestamp < toDateTime('${formatDateCF(referenceDate)}')` : ''
  // double2 holds the client-side sample rate; rows written before sampling have 0.
  const query = `SELECT SUM(_sample_interval * if(double2 > 0, double2, 1.0)) AS count FROM app_log_external WHERE blob2 = 'get'${endFilter}`

  cloudlog({ requestId: c.get('requestId'), message: 'countUpdatesFromLogsExternalCF query', query })
  try {
    const readAnalytics = await runQueryToCFA<{ count: number }>(c, query)
    return Math.round(Number(readAnalytics[0].count))
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error counting updates from external logs', error: serializeError(e) })
  }
  return 0
}

interface TopApp {
  url: string
  title: string
  icon: string
  summary: string
  installs: number
  category: string
}
export async function getTopAppsCF(c: Context, mode: string, limit: number): Promise<TopApp[]> {
  if (!c.env.DB_STOREAPPS)
    return Promise.resolve([] as StoreApp[])
  let modeQuery = ''
  if (mode === 'cordova')
    modeQuery = 'cordova = 1 AND capacitor = 0'

  else if (mode === 'flutter')
    modeQuery = 'flutter = 1'

  else if (mode === 'reactNative')
    modeQuery = 'react_native = 1'

  else if (mode === 'nativeScript')
    modeQuery = 'native_script = 1'

  else if (mode === 'capgo')
    modeQuery = 'capgo = 1'
  else
    modeQuery = 'capacitor = 1'

  const query = `SELECT url, title, icon, summary, installs, category FROM store_apps WHERE ${modeQuery} ORDER BY installs DESC LIMIT ${limit}`

  cloudlog({ requestId: c.get('requestId'), message: 'getTopAppsCF query', query })
  try {
    const storeAppSession = getReplicaReadStoreAppSession(c)
      .prepare(query)
      .all()
    const res = await storeAppSession
    return res.results as StoreApp[]
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error getting top apps', error: serializeError(e) })
  }
  return [] as StoreApp[]
}

export async function getTotalAppsByModeCF(c: Context, mode: string) {
  if (!c.env.DB_STOREAPPS)
    return Promise.resolve(0)
  let modeQuery = ''
  if (mode === 'cordova')
    modeQuery = 'cordova = 1 AND capacitor = 0'

  else if (mode === 'flutter')
    modeQuery = 'flutter = 1'

  else if (mode === 'reactNative')
    modeQuery = 'react_native = 1'

  else if (mode === 'nativeScript')
    modeQuery = 'native_script = 1'

  else if (mode === 'capgo')
    modeQuery = 'capgo = 1'
  else
    modeQuery = 'capacitor = 1'

  const query = `SELECT COUNT(*) AS total FROM store_apps WHERE ${modeQuery}`

  cloudlog({ requestId: c.get('requestId'), message: 'getTotalAppsByModeCF query', query })
  try {
    const storeAppSession = getReplicaReadStoreAppSession(c)
      .prepare(query)
      .first('total')
    const res = await storeAppSession
    return res
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error getting total apps by mode', error: serializeError(e) })
  }
  return 0
}

export async function getTotalAppsCF(c: Context) {
  if (!c.env.DB_STOREAPPS)
    return Promise.resolve(0)
  const query = 'SELECT COUNT(*) AS total FROM store_apps'

  cloudlog({ requestId: c.get('requestId'), message: 'getTotalAppsCF query', query })
  try {
    const res = await getReplicaReadStoreAppSession(c)
      .prepare(query)
      .first('total')
    return Number(res ?? 0)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error getting total apps', error: serializeError(e) })
  }
  return 0
}

// add function createIfNotExistStoreInfo

export async function createIfNotExistStoreInfo(c: Context, app: Partial<StoreApp>) {
  if (!c.env.DB_STOREAPPS || !app.app_id)
    return Promise.resolve()

  try {
    // Check if app exists
    const existingApp = await getReplicaReadStoreAppSession(c)
      .prepare('SELECT app_id FROM store_apps WHERE app_id = ?')
      .bind(app.app_id)
      .first()

    if (existingApp) {
      return false
    }
    const columns = Object.keys(app)
    const placeholders = columns.map(() => '?').join(', ')
    const values = columns.map(column => app[column as keyof StoreApp])

    const query = `INSERT INTO store_apps (${columns.join(', ')}) VALUES (${placeholders})`
    cloudlog({ requestId: c.get('requestId'), message: 'createIfNotExistStoreInfo query', query, placeholders, values })
    const res = await getReplicaWriteStoreAppSession(c)
      .prepare(query)
      .bind(...values)
      .run()

    cloudlog({ requestId: c.get('requestId'), message: 'createIfNotExistStoreInfo result', res })
    return true
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error creating store info', error: serializeError(e) })
  }

  return Promise.resolve()
}

export async function updateStoreApp(c: Context, appId: string, updates: number) {
  if (!c.env.DB_STOREAPPS)
    return Promise.resolve()

  const query = `INSERT INTO store_apps (app_id, updates, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(app_id) DO UPDATE SET updates = updates + ?, updated_at = datetime('now')`

  try {
    const res = await getReplicaWriteStoreAppSession(c)
      .prepare(query)
      .bind(appId, updates, updates)
      .run()
    cloudlog({ requestId: c.get('requestId'), message: 'updateStoreApp result', res })
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error updating StoreApp', error: serializeError(e) })
  }

  return Promise.resolve()
}

// Note: Device cleanup is no longer needed as Analytics Engine handles data retention automatically

// Shared failure taxonomy for public device-day success rates.
export const PUBLIC_FAILURE_ACTIONS = ['set_fail', 'update_fail', 'download_fail', 'windows_path_fail', 'canonical_path_fail', 'directory_path_fail', 'unzip_fail', 'low_mem_fail', 'download_manifest_file_fail', 'download_manifest_checksum_fail', 'download_manifest_brotli_fail', 'finish_download_fail', 'manifest_path_fail', 'decrypt_fail', 'insufficient_disk_space', 'cannotGetBundle', 'checksum_fail', 'blocked_by_server_url', 'backend_refusal'] as const
