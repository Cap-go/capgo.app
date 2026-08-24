import type { AnalyticsEngineDataset, D1Database, Hyperdrive, KVNamespace, Queue } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { DeviceComparable } from './deviceComparison.ts'
import type { StatsInsightRawAction, StatsInsightRawDaily, StatsInsightRawDevice, StatsInsightRawSummary, StatsInsightRawVersion } from './statsInsights.ts'
import type { Database } from './supabase.types.ts'
import type { DeviceRes, DeviceWithoutCreatedAt, NativeVersionUsage, ReadDevicesParams, ReadStatsInsightsParams, ReadStatsParams, StatsInsightsResult, StatsMetadata, VersionUsage, VersionUsageChannel } from './types.ts'
import { CACHE_PUT_TIMEOUT_MS, CacheHelper } from './cache.ts'
import { hasComparableDeviceChanged, toComparableDevice } from './deviceComparison.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { emptyStatsInsights, normalizeStatsInsightsResult } from './statsInsights.ts'
import { isBillingOnlyStatsMode, sanitizeDeviceForLogging, type StatsMode } from './stats_mode.ts'
import { DEFAULT_LIMIT } from './types.ts'
import { getEnv } from './utils.ts'

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

const MAX_ANALYTICS_QUERY_LIMIT = 50_000
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
  NOTIFICATION_QUEUE?: Queue
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

function parseStatsDurationMs(metadata?: StatsMetadata | Record<string, unknown> | null): number | null {
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

function parseStatsMetadata(metadata: unknown): StatsMetadata | null {
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
  return [
    normalizeAppLogDimension(dimensions?.platform, 16),
    normalizeAppLogDimension(dimensions?.country_code, 2).toUpperCase(),
    normalizeAppLogDimension(dimensions?.plugin_version, 32),
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

export function trackLogsCFExternal(c: Context, app_id: string, device_id: string, action: Database['public']['Enums']['stats_action'], version_name: string, metadata?: StatsMetadata, dimensions?: AppLogDimensions) {
  if (!c.env.APP_LOG_EXTERNAL)
    return Promise.resolve()

  const durationMs = parseStatsDurationMs(metadata)
  c.env.APP_LOG_EXTERNAL.writeDataPoint({
    blobs: [device_id, action, version_name, serializeStatsMetadata(metadata), ...appLogDimensionBlobs(dimensions)],
    ...(durationMs !== null ? { doubles: [durationMs] } : {}),
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
const TRACK_DEVICE_CACHE_MAX_AGE_SECONDS = 31536000

type DeviceCachePayload = DeviceComparable & {
  app_id: string
  device_id: string
  cached_at: string
}

function toDeviceInfoComparable(device: DeviceWithoutCreatedAt, statsMode: StatsMode): DeviceComparable {
  const comparableDevice = toComparableDevice(device)
  if (!isBillingOnlyStatsMode(statsMode))
    return comparableDevice

  return {
    ...comparableDevice,
    platform: null,
    os_version: '',
    custom_id: '',
    default_channel: null,
    key_id: null,
    install_source: undefined,
    country_code: undefined,
  }
}

export async function trackDevicesCF(c: Context, device: DeviceWithoutCreatedAt, statsMode: StatsMode = 'all') {
  // Runs under waitUntil — Cache I/O here stretches Workers Wall Time charts.
  const start = performance.now()
  let outcome: 'cache_hit' | 'wrote' | 'error' = 'wrote'
  const billingOnly = isBillingOnlyStatsMode(statsMode)

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
    const deviceInfoComparable = toDeviceInfoComparable(device, statsMode)
    const deviceForComparison: DeviceWithoutCreatedAt = {
      ...device,
      platform: billingOnly ? undefined : device.platform,
      os_version: deviceInfoComparable.os_version,
      custom_id: deviceInfoComparable.custom_id,
      default_channel: deviceInfoComparable.default_channel ?? undefined,
      key_id: deviceInfoComparable.key_id ?? undefined,
      install_source: deviceInfoComparable.install_source ?? undefined,
      country_code: deviceInfoComparable.country_code ?? undefined,
    }
    // Do not gate on helper.available — it is sync-racy before ensureCache resolves.
    const cachedDevice = await trackDeviceCache.matchJson<DeviceCachePayload>(trackDeviceCacheRequest)
    if (cachedDevice && !hasComparableDeviceChanged(cachedDevice, deviceForComparison)) {
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

    // Write to Analytics Engine - this is the primary store now (sync; needs no waitUntil)
    cloudlog({ requestId: c.get('requestId'), message: 'Writing to Analytics Engine DEVICE_INFO' })
    // Platform: 0 = android, 1 = ios, 2 = electron. billingOnly stores -1 (unknown).
    const platformLower = billingOnly ? null : deviceInfoComparable.platform?.toLowerCase()
    const platformValue = billingOnly ? -1 : platformLower === 'ios' ? 1 : platformLower === 'electron' ? 2 : 0
    c.env.DEVICE_INFO.writeDataPoint({
      blobs: [
        device.device_id,
        deviceInfoComparable.version_name ?? '',
        deviceInfoComparable.plugin_version ?? '',
        deviceInfoComparable.os_version ?? '',
        deviceInfoComparable.custom_id ?? '',
        deviceInfoComparable.version_build ?? '',
        deviceInfoComparable.default_channel ?? '',
        deviceInfoComparable.key_id ?? '',
        deviceInfoComparable.install_source ?? '',
        deviceInfoComparable.country_code ?? '',
      ],
      doubles: [
        platformValue,
        deviceInfoComparable.is_prod ? 1 : 0,
        deviceInfoComparable.is_emulator ? 1 : 0,
      ],
      indexes: [device.app_id],
    })

    const cachePayload: DeviceCachePayload = {
      ...deviceInfoComparable,
      app_id: device.app_id,
      device_id: device.device_id,
      cached_at: new Date().toISOString(),
    }
    await trackDeviceCache.putJson(trackDeviceCacheRequest, cachePayload, TRACK_DEVICE_CACHE_MAX_AGE_SECONDS, { timeoutMs: CACHE_PUT_TIMEOUT_MS })
  }
  catch (e) {
    outcome = 'error'
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error tracking device', error: serializeError(e), device: sanitizeDeviceForLogging(device, statsMode) })
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

export async function runQueryToCFA<T>(c: Context, query: string) {
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
export interface AdminOnboardingTelemetryWindow {
  app_id: string
  start_at: Date | string
  end_at: Date | string
}

export interface AdminOnboardingTelemetry {
  available: boolean
  first_production_device_at_by_app: Map<string, Date>
  first_update_download_at_by_app: Map<string, Date>
}

interface AdminOnboardingTelemetryRow {
  app_id: string
  first_at: Date | string
}

// Cloudflare Analytics Engine SQL rejects bodies longer than 10_000 chars.
const ADMIN_ONBOARDING_TELEMETRY_MAX_SQL_CHARS = 9_000
const ADMIN_ONBOARDING_COMPLETED_DOWNLOAD_ACTIONS = [
  'download_complete',
  'download_manifest_complete',
  'download_zip_com