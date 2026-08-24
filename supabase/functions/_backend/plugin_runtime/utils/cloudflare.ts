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
 * @param platform - Device plat