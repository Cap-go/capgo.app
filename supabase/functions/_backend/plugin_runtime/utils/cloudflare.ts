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
    blobs: [device_id, action, version_name, serializeStatsMetadata(metadata), ...appLogDimensionB