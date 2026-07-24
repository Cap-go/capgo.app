import type { AnalyticsEngineDataset, D1Database, Hyperdrive, KVNamespace, Queue } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { DeviceComparable } from './deviceComparison.ts'
import type { StatsInsightRawAction, StatsInsightRawDaily, StatsInsightRawDevice, StatsInsightRawSummary, StatsInsightRawVersion } from './statsInsights.ts'
import type { Database } from './supabase.types.ts'
import type { DeviceRes, DeviceWithoutCreatedAt, NativeVersionUsage, ReadDevicesParams, ReadStatsInsightsParams, ReadStatsParams, StatsInsightsResult, StatsMetadata, VersionUsage, VersionUsageChannel } from './types.ts'
import { CacheHelper } from './cache.ts'
import { hasComparableDeviceChanged, toComparableDevice } from './deviceComparison.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { emptyStatsInsights, normalizeStatsInsightsResult } from './statsInsights.ts'
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

    // Check if device/version was already tracked for the current day
    if (usageCache.available) {
      const cachedUsage = await usageCache.matchJson<{ t: number }>(usageCacheRequest)
      if (cachedUsage) {
        // Device/version already tracked for this day, skip write
        return
      }
    }

    const platformValue = getUsagePlatformValue(normalizedPlatform)

    // Write to Analytics Engine
    c.env.DEVICE_USAGE.writeDataPoint({
      blobs: [device_id, org_id, normalizedVersionBuild, normalizedPlatform],
      doubles: [platformValue],
      indexes: [app_id],
    })

    // Cache the write for this native version during the current day
    if (usageCache.available) {
      await usageCache.putJson(usageCacheRequest, { t: Date.now() }, TRACK_DEVICE_USAGE_CACHE_MAX_AGE_SECONDS)
    }
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

  c.env.APP_LOG.writeDataPoint({
    blobs: [device_id, action, version_name, serializeStatsMetadata(metadata), ...appLogDimensionBlobs(dimensions)],
    indexes: [app_id],
  })

  return Promise.resolve()
}

export function trackLogsCFExternal(c: Context, app_id: string, device_id: string, action: Database['public']['Enums']['stats_action'], version_name: string, metadata?: StatsMetadata, dimensions?: AppLogDimensions) {
  if (!c.env.APP_LOG_EXTERNAL)
    return Promise.resolve()

  c.env.APP_LOG_EXTERNAL.writeDataPoint({
    blobs: [device_id, action, version_name, serializeStatsMetadata(metadata), ...appLogDimensionBlobs(dimensions)],
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

export async function trackDevicesCF(c: Context, device: DeviceWithoutCreatedAt) {
  cloudlog({ requestId: c.get('requestId'), message: 'trackDevicesCF', device })

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
    const cachedDevice = trackDeviceCache.available
      ? await trackDeviceCache.matchJson<DeviceCachePayload>(trackDeviceCacheRequest)
      : null
    if (cachedDevice && !hasComparableDeviceChanged(cachedDevice, device)) {
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

    // Write to Analytics Engine - this is the primary store now
    cloudlog({ requestId: c.get('requestId'), message: 'Writing to Analytics Engine DEVICE_INFO' })
    // Platform: 0 = android, 1 = ios, 2 = electron
    const platformLower = comparableDevice.platform?.toLowerCase()
    const platformValue = platformLower === 'ios' ? 1 : platformLower === 'electron' ? 2 : 0
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
        comparableDevice.is_prod ? 1 : 0,
        comparableDevice.is_emulator ? 1 : 0,
      ],
      indexes: [device.app_id],
    })

    // Update cache
    if (trackDeviceCache.available) {
      const cachePayload: DeviceCachePayload = {
        ...comparableDevice,
        app_id: device.app_id,
        device_id: device.device_id,
        cached_at: new Date().toISOString(),
      }
      await trackDeviceCache.putJson(trackDeviceCacheRequest, cachePayload, TRACK_DEVICE_CACHE_MAX_AGE_SECONDS)
    }
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error tracking device', error: serializeError(e), device })
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
  const converters = {
    String: (value: string) => String(value),
    UInt64: (value: string) => Number(value),
    DateTime: (value: string) => new Date(value),
  }

  return data.map((row) => {
    const convertedRow = {} as any
    meta.forEach((column) => {
      const { name, type } = column
      convertedRow[name] = (converters as any)[type] ? (converters as any)[type](row[name]) : row[name]
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

const ADMIN_ONBOARDING_TELEMETRY_WINDOWS_PER_QUERY = 100
const ADMIN_ONBOARDING_COMPLETED_DOWNLOAD_ACTIONS = [
  'download_complete',
  'download_manifest_complete',
  'download_zip_complete',
]

function toValidDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function isAdminOnboardingTelemetryWithinRetention(startDate: Date | string, now = new Date()) {
  const start = toValidDate(startDate)
  if (!start || start > now)
    return false

  const retentionCutoff = new Date(now)
  retentionCutoff.setUTCMonth(retentionCutoff.getUTCMonth() - 3)
  return start >= retentionCutoff
}

function getAdminOnboardingTelemetryWindowFilter(windows: AdminOnboardingTelemetryWindow[]) {
  if (windows.length === 0)
    return '1 = 0'

  return windows.map((window) => {
    return `(index1 = '${escapeSqlString(window.app_id)}'
      AND timestamp >= toDateTime('${formatDateCF(window.start_at)}')
      AND timestamp < toDateTime('${formatDateCF(window.end_at)}'))`
  }).join('\n      OR ')
}

export function buildAdminOnboardingProductionDeviceQuery(windows: AdminOnboardingTelemetryWindow[]) {
  return `SELECT
    index1 AS app_id,
    min(timestamp) AS first_at
  FROM device_info
  WHERE (${getAdminOnboardingTelemetryWindowFilter(windows)})
    AND double2 = 1
    AND double3 = 0
    AND blob3 != ''
  GROUP BY index1`
}

export function buildAdminOnboardingUpdateDownloadQuery(windows: AdminOnboardingTelemetryWindow[]) {
  const actions = ADMIN_ONBOARDING_COMPLETED_DOWNLOAD_ACTIONS.map(action => `'${action}'`).join(', ')
  return `SELECT
    index1 AS app_id,
    min(timestamp) AS first_at
  FROM app_log
  WHERE (${getAdminOnboardingTelemetryWindowFilter(windows)})
    AND blob2 IN (${actions})
  GROUP BY index1`
}

function addFirstSeenByApp(target: Map<string, Date>, rows: AdminOnboardingTelemetryRow[]) {
  for (const row of rows) {
    const firstAt = toValidDate(row.first_at)
    if (!row.app_id || !firstAt)
      continue

    const current = target.get(row.app_id)
    if (!current || firstAt < current)
      target.set(row.app_id, firstAt)
  }
}

function emptyAdminOnboardingTelemetry(available = false): AdminOnboardingTelemetry {
  return {
    available,
    first_production_device_at_by_app: new Map(),
    first_update_download_at_by_app: new Map(),
  }
}

export async function getAdminOnboardingTelemetry(
  c: Context,
  windows: AdminOnboardingTelemetryWindow[],
  rangeStart: Date | string,
  now = new Date(),
): Promise<AdminOnboardingTelemetry> {
  if (!isAdminOnboardingTelemetryWithinRetention(rangeStart, now)
    || !c.env.APP_LOG
    || !c.env.DEVICE_INFO
    || !getEnv(c, 'CF_ANALYTICS_TOKEN')
    || !getEnv(c, 'CF_ACCOUNT_ANALYTICS_ID')) {
    return emptyAdminOnboardingTelemetry()
  }

  const validWindows = windows.filter((window) => {
    const start = toValidDate(window.start_at)
    const end = toValidDate(window.end_at)
    return Boolean(window.app_id && start && end && start < end)
  })
  if (validWindows.length === 0)
    return emptyAdminOnboardingTelemetry(true)

  const telemetry = emptyAdminOnboardingTelemetry(true)
  try {
    for (let index = 0; index < validWindows.length; index += ADMIN_ONBOARDING_TELEMETRY_WINDOWS_PER_QUERY) {
      const windowBatch = validWindows.slice(index, index + ADMIN_ONBOARDING_TELEMETRY_WINDOWS_PER_QUERY)
      const [productionDeviceRows, updateDownloadRows] = await Promise.all([
        runQueryToCFA<AdminOnboardingTelemetryRow>(c, buildAdminOnboardingProductionDeviceQuery(windowBatch)),
        runQueryToCFA<AdminOnboardingTelemetryRow>(c, buildAdminOnboardingUpdateDownloadQuery(windowBatch)),
      ])
      addFirstSeenByApp(telemetry.first_production_device_at_by_app, productionDeviceRows)
      addFirstSeenByApp(telemetry.first_update_download_at_by_app, updateDownloadRows)
    }
    return telemetry
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'getAdminOnboardingTelemetry failed',
      error: serializeError(error),
    })
    return telemetry
  }
}

export interface DeviceUsageCF {
  date: string
  mau: number
  app_id: string
  org_id?: string
}

export interface DeviceUsageAllCF {
  date: string
  device_id: string
  app_id: string
  org_id: string
}

export async function readDeviceUsageCF(c: Context, app_id: string, period_start: string, period_end: string) {
  if (!c.env.DEVICE_USAGE)
    return [] as DeviceUsageCF[]
  const query = `SELECT
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
  ORDER BY date`

  cloudlog({ requestId: c.get('requestId'), message: 'readDeviceUsageCF query', query })
  try {
    const res = await runQueryToCFA<DeviceUsageAllCF>(c, query)
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
      acc[date].mau++
      return acc
    }, {} as Record<string, DeviceUsageCF>)
    return Object.values(groupedByDay).sort((a, b) => a.date > b.date ? 1 : -1)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading device usage', error: serializeError(e), query })
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
  sum(double1) AS bandwidth,
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

export async function readStatsVersionCF(c: Context, app_id: string, period_start: string, period_end: string, channel?: VersionUsageChannel | string): Promise<VersionUsage[]> {
  if (!c.env.VERSION_USAGE)
    return []
  // Note: blob2 contains version_name for new data and version_id (numeric) for old data.
  // blob4 contains channel_name and blob5 contains channel_id only for newer data.
  const channelId = typeof channel === 'object' && channel?.id ? String(channel.id) : ''
  const channelName = typeof channel === 'string' ? channel : channelId ? null : channel?.name
  const safeChannelName = channelName ? escapeSqlString(channelName) : ''
  const safeChannelId = channelId ? escapeSqlString(channelId) : ''
  const channelFilter = safeChannelId
    ? `AND blob5 = '${safeChannelId}'`
    : safeChannelName ? `AND blob4 = '${safeChannelName}'` : ''
  const query = `SELECT
  blob1 as app_id,
  blob2 as version_name,
  formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
  sum(if(blob3 = 'get', 1, 0)) AS get,
  sum(if(blob3 = 'fail', 1, 0)) AS fail,
  sum(if(blob3 = 'install', 1, 0)) AS install,
  sum(if(blob3 = 'uninstall', 1, 0)) AS uninstall
FROM version_usage
WHERE
  app_id = '${escapeSqlString(app_id)}'
  AND timestamp >= toDateTime('${formatDateCF(period_start)}')
  AND timestamp < toDateTime('${formatDateCF(period_end)}')
  ${channelFilter}
GROUP BY date, app_id, version_name
ORDER BY date`

  cloudlog({ requestId: c.get('requestId'), message: 'readStatsVersionCF query', query })
  try {
    return await runQueryToCFA<VersionUsage>(c, query)
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

export async function readDeviceVersionCountsCF(c: Context, app_id: string, channelName?: string): Promise<Record<string, number>> {
  if (!c.env.DEVICE_INFO)
    return {}

  const safeChannel = channelName ? escapeSqlString(channelName) : ''
  const channelFilter = safeChannel ? `AND default_channel = '${safeChannel}'` : ''

  const query = `SELECT
  version_name,
  count() AS device_count
FROM (
  SELECT
    argMax(blob2, timestamp) AS version_name,
    argMax(blob7, timestamp) AS default_channel,
    blob1 AS device_id
  FROM device_info
  WHERE index1 = '${escapeSqlString(app_id)}' AND blob9 != ''
  GROUP BY blob1
)
WHERE version_name != '' ${channelFilter}
GROUP BY version_name`

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

export async function countDevicesCF(
  c: Context,
  app_id: string,
  customIdMode: boolean,
  deviceIds: string[] = [],
  versionName?: string,
  search?: string,
) {
  // Use Analytics Engine DEVICE_INFO for counting devices
  const conditions = [`index1 = '${escapeSqlString(app_id)}'`]

  if (customIdMode)
    conditions.push(`blob5 != ''`)

  if (deviceIds.length) {
    if (deviceIds.length === 1)
      conditions.push(`blob1 = '${escapeSqlString(deviceIds[0])}'`)
    else
      conditions.push(`blob1 IN (${deviceIds.map(id => `'${escapeSqlString(id)}'`).join(', ')})`)
  }

  if (search) {
    const searchLower = search.toLowerCase()
    if (deviceIds.length) {
      conditions.push(`position('${escapeSqlString(searchLower)}' IN toLower(blob5)) > 0`)
    }
    else {
      // Search in device_id, custom_id, or version_name
      conditions.push(`(position('${escapeSqlString(searchLower)}' IN toLower(blob1)) > 0 OR position('${escapeSqlString(searchLower)}' IN toLower(blob5)) > 0 OR position('${escapeSqlString(searchLower)}' IN toLower(blob2)) > 0)`)
    }
  }

  if (versionName)
    conditions.push(`blob2 = '${escapeSqlString(versionName)}'`)

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

function buildReadDevicesCFOuterConditions(params: ReadDevicesParams, devicesOrder: DevicesOrderCF | null) {
  const conditions = [
    buildReadDevicesCFCursorCondition(params.cursor, devicesOrder),
    buildReadDevicesCFUpdatedAtGtCondition(params.updated_at_gt),
  ]
  return conditions.filter(Boolean)
}

export function buildReadDevicesCFQuery(params: ReadDevicesParams, customIdMode: boolean) {
  const limit = normalizeAnalyticsLimit(params.limit)
  const conditions: string[] = [`index1 = '${escapeSqlString(params.app_id)}'`]

  if (customIdMode) {
    conditions.push(`blob5 != ''`)
  }

  if (params.deviceIds?.length) {
    if (params.deviceIds.length === 1) {
      conditions.push(`blob1 = '${escapeSqlString(params.deviceIds[0])}'`)
    }
    else {
      const devicesList = params.deviceIds.map(id => `'${escapeSqlString(id)}'`).join(', ')
      conditions.push(`blob1 IN (${devicesList})`)
    }
  }

  if (params.search) {
    const searchLower = params.search.toLowerCase()
    if (params.deviceIds?.length) {
      conditions.push(`position('${escapeSqlString(searchLower)}' IN toLower(blob5)) > 0`)
    }
    else {
      conditions.push(`(position('${escapeSqlString(searchLower)}' IN toLower(blob1)) > 0 OR position('${escapeSqlString(searchLower)}' IN toLower(blob5)) > 0 OR position('${escapeSqlString(searchLower)}' IN toLower(blob2)) > 0)`)
    }
  }

  if (params.version_name) {
    conditions.push(`blob2 = '${escapeSqlString(params.version_name)}'`)
  }

  if (params.updated_at_gt) {
    const safeUpdatedAtGt = escapeSqlString(formatDateCF(params.updated_at_gt))
    conditions.push(`timestamp > toDateTime('${safeUpdatedAtGt}')`)
  }

  const devicesOrder = getReadDevicesCFOrder(params)
  const outerConditions = buildReadDevicesCFOuterConditions(params, devicesOrder)
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
      platform: row.platform === 1 ? 'ios' : row.platform === 2 ? 'electron' : 'android',
      plugin_version: row.plugin_version,
      os_version: row.os_version,
      version_build: row.version_build,
      is_prod: Boolean(row.is_prod),
      is_emulator: Boolean(row.is_emulator),
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
  app_id = '${escapeSqlString(params.app_id)}' ${deviceFilter} ${actionsFilter} ${searchFilter} ${startFilter} ${endFilter}
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

function buildStatsInsightsActionFilter(actions?: string[]) {
  if (!actions?.length)
    return ''

  if (actions.length === 1)
    return `AND blob2 = '${escapeSqlString(actions[0])}'`

  const actionList = actions.map(action => `'${escapeSqlString(action)}'`).join(',')
  return `AND blob2 IN (${actionList})`
}

export async function readStatsInsightsCF(c: Context, params: ReadStatsInsightsParams): Promise<StatsInsightsResult> {
  const emptyResult = emptyStatsInsights()
  if (!c.env.APP_LOG)
    return emptyResult

  const actionFilter = buildStatsInsightsActionFilter(params.actions)
  const periodStart = formatDateCF(params.start_date)
  const periodEnd = formatDateCF(params.end_date)
  const baseWhere = `index1 = '${escapeSqlString(params.app_id)}'
    AND timestamp >= toDateTime('${periodStart}')
    AND timestamp < toDateTime('${periodEnd}')
    ${actionFilter}`

  const summaryQuery = `SELECT
    count() AS total,
    COUNT(DISTINCT blob1) AS device_count,
    COUNT(DISTINCT blob2) AS action_count
  FROM app_log
  WHERE ${baseWhere}`

  const actionsQuery = `SELECT
    blob2 AS action,
    count() AS total,
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
    count() AS total
  FROM app_log
  WHERE ${baseWhere}
  GROUP BY date, action
  ORDER BY date ASC, total DESC`

  const versionsQuery = `SELECT
    blob2 AS action,
    blob3 AS version_name,
    count() AS total,
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
    count() AS total,
    argMax(blob3, timestamp) AS version_name,
    max(timestamp) AS last_seen
  FROM app_log
  WHERE ${baseWhere}
  GROUP BY action, device_id
  ORDER BY total DESC
  LIMIT 30`

  cloudlog({ requestId: c.get('requestId'), message: 'readStatsInsightsCF queries', appId: params.app_id, start: params.start_date, end: params.end_date, actions: params.actions })

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

export async function countUpdatesFromStoreAppsCF(c: Context): Promise<number> {
  if (!c.env.DB_STOREAPPS)
    return Promise.resolve(0)
  // use countUpdatesFromStoreApps example to make it work with Cloudflare
  const query = `SELECT SUM(updates) + SUM(installs) AS count FROM store_apps WHERE onprem = 1 OR capgo = 1`

  cloudlog({ requestId: c.get('requestId'), message: 'countUpdatesFromStoreAppsCF query', query })
  try {
    const storeAppSession = getReplicaReadStoreAppSession(c)
      .prepare(query)
      .first('count')
    const res = await storeAppSession
    return res
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error counting updates from store apps', error: serializeError(e) })
  }
  return 0
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
  const query = `SELECT SUM(_sample_interval) AS count FROM app_log_external WHERE blob2 = 'get'${endFilter}`

  cloudlog({ requestId: c.get('requestId'), message: 'countUpdatesFromLogsExternalCF query', query })
  try {
    const readAnalytics = await runQueryToCFA<{ count: number }>(c, query)
    return readAnalytics[0].count
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error counting updates from external logs', error: serializeError(e) })
  }
  return 0
}

export async function readActiveAppsCF(c: Context, referenceDate?: Date) {
  const { startExpression, endExpression } = getLastMonthAnalyticsWindow(referenceDate)
  const query = `SELECT index1 as app_id FROM app_log WHERE timestamp >= ${startExpression} AND timestamp < ${endExpression} AND blob2 = 'get' GROUP BY app_id`
  cloudlog({ requestId: c.get('requestId'), message: 'readActiveAppsCF query', query })
  try {
    const response = await runQueryToCFA<{ app_id: string }>(c, query)
    const app_ids = response.map(app => app.app_id)
    // deduplicate them
    const unique = Array.from(new Set(app_ids))
    return unique
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error counting active apps', error: serializeError(e) })
  }
  return []
}

const LAST_MONTH_ANALYTICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export function getLastMonthAnalyticsWindowStart(referenceDate?: Date): Date {
  const end = referenceDate && !Number.isNaN(referenceDate.getTime()) ? referenceDate : new Date(Date.now())
  return new Date(end.getTime() - LAST_MONTH_ANALYTICS_WINDOW_MS)
}

export function getLastMonthAnalyticsWindow(referenceDate?: Date) {
  const start = getLastMonthAnalyticsWindowStart(referenceDate)

  if (!referenceDate) {
    return {
      startExpression: `toDateTime('${formatDateCF(start)}')`,
      endExpression: 'now()',
    }
  }

  const end = Number.isNaN(referenceDate.getTime()) ? new Date(Date.now()) : referenceDate
  return {
    startExpression: `toDateTime('${formatDateCF(start)}')`,
    endExpression: `toDateTime('${formatDateCF(end)}')`,
  }
}

export async function readLastMonthUpdatesCF(c: Context, referenceDate?: Date) {
  const { startExpression, endExpression } = getLastMonthAnalyticsWindow(referenceDate)
  const query = `SELECT sum(if(blob2 = 'get', 1, 0)) AS count FROM app_log WHERE timestamp >= ${startExpression} AND timestamp < ${endExpression}`
  cloudlog({ requestId: c.get('requestId'), message: 'readLastMonthUpdatesCF query', query })
  try {
    const response = await runQueryToCFA<{ count: number }>(c, query)
    cloudlog({ requestId: c.get('requestId'), message: 'readLastMonthUpdatesCF response', response })
    return response[0].count ?? 0
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading last month updates', error: serializeError(e) })
  }
  return 0
}

export async function readLastMonthDevicesCF(c: Context, referenceDate?: Date): Promise<number> {
  if (!c.env.DEVICE_USAGE)
    return 0
  const { startExpression, endExpression } = getLastMonthAnalyticsWindow(referenceDate)
  const query = `SELECT
    index1 AS app_id,
    COUNT(DISTINCT blob1) AS total
  FROM device_usage
  WHERE timestamp >= ${startExpression}
    AND timestamp < ${endExpression}
  GROUP BY index1`

  cloudlog({ requestId: c.get('requestId'), message: 'readLastMonthDevicesCF query', query })
  try {
    const res = await runQueryToCFA<{ app_id: string, total: number }>(c, query)
    return res.reduce((sum, row) => sum + (row.total || 0), 0)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading last month devices', error: serializeError(e) })
  }
  return 0
}

export interface DevicesByPlatform {
  total: number
  ios: number
  android: number
}

export async function readLastMonthDevicesByPlatformCF(c: Context, referenceDate?: Date): Promise<DevicesByPlatform> {
  if (!c.env.DEVICE_USAGE) {
    return { total: 0, ios: 0, android: 0 }
  }

  const { startExpression, endExpression } = getLastMonthAnalyticsWindow(referenceDate)
  // Platform: double1 = 0 for android, 1 for ios
  const baseWhere = `timestamp >= ${startExpression} AND timestamp < ${endExpression}`
  const totalQuery = `SELECT index1 AS app_id, COUNT(DISTINCT blob1) AS total FROM device_usage WHERE ${baseWhere} GROUP BY index1`
  const platformQuery = `SELECT index1 AS app_id, double1 AS platform, COUNT(DISTINCT blob1) AS total FROM device_usage WHERE ${baseWhere} GROUP BY index1, double1`

  cloudlog({ requestId: c.get('requestId'), message: 'readLastMonthDevicesByPlatformCF queries', totalQuery, platformQuery })
  try {
    const [totalRes, platformRes] = await Promise.all([
      runQueryToCFA<{ app_id: string, total: number }>(c, totalQuery),
      runQueryToCFA<{ app_id: string, platform: number, total: number }>(c, platformQuery),
    ])

    const total = totalRes.reduce((sum, row) => sum + (row.total || 0), 0)
    let ios = 0
    let android = 0
    platformRes.forEach((row) => {
      if (row.platform === 1)
        ios += row.total || 0
      else if (row.platform === 0)
        android += row.total || 0
    })
    return {
      total,
      ios,
      android,
    }
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading last month devices by platform', error: serializeError(e) })
  }
  return { total: 0, ios: 0, android: 0 }
}

export async function getAppsToProcessCF(c: Context, flag: 'to_get_framework' | 'to_get_info' | 'to_get_similar', limit: number) {
  if (!c.env.DB_STOREAPPS)
    return Promise.resolve([] as StoreApp[])
  const query = `SELECT * FROM store_apps WHERE ${flag} = 1 ORDER BY created_at ASC LIMIT ${limit}`

  cloudlog({ requestId: c.get('requestId'), message: 'getAppsToProcessCF query', query })
  try {
    const storeAppSession = getReplicaReadStoreAppSession(c)
      .prepare(query)
      .all()
    const res = await storeAppSession
    return res.results as StoreApp[]
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error getting apps to process', error: serializeError(e) })
  }
  return [] as StoreApp[]
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

export async function saveStoreInfoCF(c: Context, app: Partial<StoreApp>) {
  if (!c.env.DB_STOREAPPS)
    return Promise.resolve()

  const columns = Object.keys(app).filter(column => column !== 'app_id') as (keyof StoreApp)[]

  const placeholders = columns.map(() => '?').join(', ')
  const updates = columns.map(column => `${column} = EXCLUDED.${column}`).join(', ')
  const values = columns.map(column => app[column])

  const query = `INSERT INTO store_apps (app_id, ${columns.join(', ')}) VALUES (?, ${placeholders}) ON CONFLICT(app_id) DO UPDATE SET ${updates}`

  try {
    const res = await getReplicaWriteStoreAppSession(c)
      .prepare(query)
      .bind(app.app_id, ...values)
      .run()
    cloudlog({ requestId: c.get('requestId'), message: 'saveStoreInfoCF result', res })
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error saving store info', error: serializeError(e) })
  }

  return Promise.resolve()
}

export function bulkUpdateStoreAppsCF(c: Context, apps: StoreApp[]) {
  if (!c.env.DB_STOREAPPS)
    return Promise.resolve()

  if (!apps.length)
    return Promise.resolve()

  // loop on all apps to insert with saveStoreInfoCF
  const jobs = []
  for (const app of apps)
    jobs.push(saveStoreInfoCF(c, app))

  return Promise.all(jobs)
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

// Update the interface
interface UpdateStats {
  apps: {
    app_id: string
    failed: number
    set: number
    get: number
    success_rate: number
    healthy: boolean
  }[]
  total: {
    failed: number
    set: number
    get: number
    success_rate: number
    healthy: boolean
  }
}

// Update the function
export async function getUpdateStatsCF(c: Context): Promise<UpdateStats> {
  const query = `
    SELECT
      blob1 AS app_id,
      sum(if(blob3 = 'fail', 1, 0)) AS failed,
      sum(if(blob3 = 'install', 1, 0)) AS set,
      sum(if(blob3 = 'get', 1, 0)) AS get
    FROM version_usage
    WHERE timestamp >= toDateTime(toUnixTimestamp(now()) - 600)
      AND timestamp < toDateTime(toUnixTimestamp(now()) - 540)
    GROUP BY blob1
  `

  cloudlog({ requestId: c.get('requestId'), message: 'getUpdateStatsCF query', query })
  try {
    const result = await runQueryToCFA<{ app_id: string, failed: number, set: number, get: number }>(c, query)

    cloudlog({ requestId: c.get('requestId'), message: 'getUpdateStatsCF result', result })
    const apps = result
      .filter(app => app.get > 0)
      .map((app) => {
        const totalEvents = app.set + app.get
        const successRate = Number(Number(totalEvents > 0 ? (app.get / totalEvents) * 100 : 100).toFixed(2))
        return {
          ...app,
          success_rate: successRate,
          healthy: successRate >= 70,
        }
      })

    const total = apps.reduce((acc, app) => {
      acc.failed += app.failed
      acc.set += app.set
      acc.get += app.get
      return acc
    }, { failed: 0, set: 0, get: 0 })

    const totalEvents = total.set + total.get
    const totalSuccessRate = totalEvents > 0 ? (total.get / totalEvents) * 100 : 100

    return {
      apps,
      total: {
        ...total,
        success_rate: Number(totalSuccessRate.toFixed(0)),
        healthy: totalSuccessRate >= 70,
      },
    }
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error getting update stats', error: serializeError(e) })
    return {
      apps: [],
      total: {
        failed: 0,
        set: 0,
        get: 0,
        success_rate: 0,
        healthy: false,
      },
    }
  }
}

// Note: Device cleanup is no longer needed as Analytics Engine handles data retention automatically

// ============================================================================
// ADMIN ANALYTICS FUNCTIONS
// ============================================================================

/**
 * Admin dashboard analytics interfaces and functions for platform-wide statistics
 */

export interface AdminUploadMetrics {
  date: string
  uploads: number
  app_id?: string
}

export interface AdminDistributionMetrics {
  date: string
  downloads: number // 'get' actions
  installs: number
  app_id?: string
}

export interface AdminFailureMetrics {
  date: string
  failures: number
  failure_rate: number // percentage
  app_id?: string
}

export interface AdminSuccessRate {
  installs: number
  fails: number
  success_rate: number // percentage
  total_actions: number
}

export interface AdminPlatformOverview {
  mau: number
  active_apps: number
  active_orgs: number
  success_rate: number
  total_bandwidth: number
  android_devices: number
  ios_devices: number
  electron_devices: number
  total_devices: number
  period_start: string
  period_end: string
}

export interface AdminOrgMetrics {
  org_id: string
  mau: number
  bandwidth: number
  updates: number
  apps_count: number
}

export interface AdminMauTrend {
  date: string
  mau: number
}

export interface AdminSuccessRateTrend {
  date: string
  installs: number
  fails: number
  success_rate: number
}

export interface AdminAppsTrend {
  date: string
  apps_created: number
}

export interface AdminBundlesTrend {
  date: string
  bundles_created: number
}

/**
 * Get upload metrics for admin dashboard
 * Returns daily unique version uploads, optionally filtered by app_id
 */
export async function getAdminUploadMetrics(
  c: Context,
  start_date: string,
  end_date: string,
  app_id?: string,
): Promise<AdminUploadMetrics[]> {
  if (!c.env.VERSION_USAGE)
    return []

  const appFilter = app_id ? `AND blob1 = '${escapeSqlString(app_id)}'` : ''

  const query = `SELECT
    formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
    COUNT(DISTINCT blob2) AS uploads
    ${app_id ? `, blob1 AS app_id` : ''}
  FROM version_usage
  WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
    AND timestamp < toDateTime('${formatDateCF(end_date)}')
    ${appFilter}
  GROUP BY date ${app_id ? ', app_id' : ''}
  ORDER BY date ASC`

  cloudlog({ requestId: c.get('requestId'), message: 'getAdminUploadMetrics query', query })

  try {
    return await runQueryToCFA<AdminUploadMetrics>(c, query)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error in getAdminUploadMetrics', error: serializeError(e), query })
    return []
  }
}

/**
 * Get distribution metrics for admin dashboard
 * Returns daily download (get) and install counts
 */
export async function getAdminDistributionMetrics(
  c: Context,
  start_date: string,
  end_date: string,
  app_id?: string,
): Promise<AdminDistributionMetrics[]> {
  if (!c.env.VERSION_USAGE)
    return []

  const appFilter = app_id ? `AND blob1 = '${escapeSqlString(app_id)}'` : ''

  const query = `SELECT
    formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
    sum(if(blob3 = 'get', 1, 0)) AS downloads,
    sum(if(blob3 = 'install', 1, 0)) AS installs
    ${app_id ? `, blob1 AS app_id` : ''}
  FROM version_usage
  WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
    AND timestamp < toDateTime('${formatDateCF(end_date)}')
    ${appFilter}
  GROUP BY date ${app_id ? ', app_id' : ''}
  ORDER BY date ASC`

  cloudlog({ requestId: c.get('requestId'), message: 'getAdminDistributionMetrics query', query })

  try {
    return await runQueryToCFA<AdminDistributionMetrics>(c, query)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error in getAdminDistributionMetrics', error: serializeError(e), query })
    return []
  }
}

/**
 * Get failure metrics for admin dashboard
 * Returns daily failure counts and failure rates
 */
export async function getAdminFailureMetrics(
  c: Context,
  start_date: string,
  end_date: string,
  app_id?: string,
): Promise<AdminFailureMetrics[]> {
  if (!c.env.VERSION_USAGE)
    return []

  const appFilter = app_id ? `AND blob1 = '${escapeSqlString(app_id)}'` : ''

  const query = `SELECT
    formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
    sum(if(blob3 = 'fail', 1, 0)) AS failures,
    sum(if(blob3 = 'install', 1, 0)) AS installs
    ${app_id ? `, blob1 AS app_id` : ''}
  FROM version_usage
  WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
    AND timestamp < toDateTime('${formatDateCF(end_date)}')
    ${appFilter}
  GROUP BY date ${app_id ? ', app_id' : ''}
  ORDER BY date ASC`

  cloudlog({ requestId: c.get('requestId'), message: 'getAdminFailureMetrics query', query })

  try {
    const rows = await runQueryToCFA<{ date: string, failures: number, installs: number, app_id?: string }>(c, query)
    return rows.map((row) => {
      const total = (row.failures || 0) + (row.installs || 0)
      return {
        date: row.date,
        failures: row.failures || 0,
        app_id: row.app_id,
        failure_rate: total > 0 ? ((row.failures || 0) / total) * 100 : 0,
      }
    })
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error in getAdminFailureMetrics', error: serializeError(e), query })
    return []
  }
}

/**
 * Get platform success rate for admin dashboard
 * Returns overall install vs fail statistics
 */
export async function getAdminSuccessRate(
  c: Context,
  start_date: string,
  end_date: string,
  app_id?: string,
): Promise<AdminSuccessRate | null> {
  if (!c.env.VERSION_USAGE)
    return null

  const appFilter = app_id ? `AND blob1 = '${escapeSqlString(app_id)}'` : ''

  const query = `SELECT
    sum(if(blob3 = 'install', 1, 0)) AS installs,
    sum(if(blob3 = 'fail', 1, 0)) AS fails
  FROM version_usage
  WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
    AND timestamp < toDateTime('${formatDateCF(end_date)}')
    ${appFilter}`

  cloudlog({ requestId: c.get('requestId'), message: 'getAdminSuccessRate query', query })

  try {
    const result = await runQueryToCFA<{ installs: number, fails: number }>(c, query)
    const row = result[0]
    if (!row)
      return null

    const totalActions = (row.installs || 0) + (row.fails || 0)
    return {
      installs: row.installs || 0,
      fails: row.fails || 0,
      total_actions: totalActions,
      success_rate: totalActions > 0 ? ((row.installs || 0) / totalActions) * 100 : 0,
    }
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error in getAdminSuccessRate', error: serializeError(e), query })
    return null
  }
}

/**
 * Get platform overview metrics for admin dashboard
 * Returns MAU, active apps, bandwidth, and device platform distribution
 */
export async function getAdminPlatformOverview(
  c: Context,
  start_date: string,
  end_date: string,
  org_id?: string,
): Promise<AdminPlatformOverview | null> {
  try {
    const orgFilter = org_id ? `AND blob2 = '${escapeSqlString(org_id)}'` : ''

    // Query 1: MAU from DEVICE_USAGE
    const mauQuery = `SELECT COUNT(DISTINCT blob1) AS mau
      FROM device_usage
      WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
        AND timestamp < toDateTime('${formatDateCF(end_date)}')
        ${orgFilter}`

    // Query 2: Active apps from APP_LOG
    const appsQuery = `SELECT COUNT(DISTINCT index1) AS active_apps
      FROM app_log
      WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
        AND timestamp < toDateTime('${formatDateCF(end_date)}')
        AND blob2 = 'get'`

    // Query 3: Total bandwidth from BANDWIDTH_USAGE
    const bandwidthQuery = `SELECT sum(double1) AS total_bandwidth
      FROM bandwidth_usage
      WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
        AND timestamp < toDateTime('${formatDateCF(end_date)}')`

    // Query 4: Device platform distribution from DEVICE_INFO
    const platformQuery = `SELECT
        sum(if(double1 = 0, 1, 0)) AS android_devices,
        sum(if(double1 = 1, 1, 0)) AS ios_devices,
        sum(if(double1 = 2, 1, 0)) AS electron_devices,
        COUNT(DISTINCT blob1) AS total_devices
      FROM device_info
      WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
        AND timestamp < toDateTime('${formatDateCF(end_date)}')`

    // Query 5: Active organizations count
    const orgsQuery = `SELECT COUNT(DISTINCT blob2) AS active_orgs
      FROM device_usage
      WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
        AND timestamp < toDateTime('${formatDateCF(end_date)}')
        AND blob2 != ''`

    // Query 6: Success rate from VERSION_USAGE
    const successRateQuery = `SELECT
      sum(if(blob3 = 'install', 1, 0)) AS installs,
      sum(if(blob3 = 'fail', 1, 0)) AS fails
    FROM version_usage
    WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
      AND timestamp < toDateTime('${formatDateCF(end_date)}')`

    const [mauResult, appsResult, bandwidthResult, platformResult, orgsResult, successResult] = await Promise.all([
      c.env.DEVICE_USAGE ? runQueryToCFA<{ mau: number }>(c, mauQuery) : Promise.resolve([{ mau: 0 }]),
      c.env.APP_LOG ? runQueryToCFA<{ active_apps: number }>(c, appsQuery) : Promise.resolve([{ active_apps: 0 }]),
      c.env.BANDWIDTH_USAGE ? runQueryToCFA<{ total_bandwidth: number }>(c, bandwidthQuery) : Promise.resolve([{ total_bandwidth: 0 }]),
      c.env.DEVICE_INFO ? runQueryToCFA<{ android_devices: number, ios_devices: number, electron_devices: number, total_devices: number }>(c, platformQuery) : Promise.resolve([{ android_devices: 0, ios_devices: 0, electron_devices: 0, total_devices: 0 }]),
      c.env.DEVICE_USAGE ? runQueryToCFA<{ active_orgs: number }>(c, orgsQuery) : Promise.resolve([{ active_orgs: 0 }]),
      c.env.VERSION_USAGE ? runQueryToCFA<{ installs: number, fails: number }>(c, successRateQuery) : Promise.resolve([{ installs: 0, fails: 0 }]),
    ])

    // Log results for debugging
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Admin platform overview query results',
      mauResult,
      appsResult,
      bandwidthResult,
      platformResult,
      orgsResult,
      successResult,
      start_date,
      end_date,
    })

    // Calculate success rate in JavaScript
    const installs = successResult[0]?.installs || 0
    const fails = successResult[0]?.fails || 0
    const total = installs + fails
    const success_rate = total > 0 ? (installs / total) * 100 : 0

    return {
      mau: mauResult[0]?.mau || 0,
      active_apps: appsResult[0]?.active_apps || 0,
      active_orgs: orgsResult[0]?.active_orgs || 0,
      success_rate,
      total_bandwidth: bandwidthResult[0]?.total_bandwidth || 0,
      android_devices: platformResult[0]?.android_devices || 0,
      ios_devices: platformResult[0]?.ios_devices || 0,
      electron_devices: platformResult[0]?.electron_devices || 0,
      total_devices: platformResult[0]?.total_devices || 0,
      period_start: start_date,
      period_end: end_date,
    }
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error in getAdminPlatformOverview', error: serializeError(e) })
    return null
  }
}

/**
 * Get per-organization metrics for admin dashboard
 * Returns MAU, bandwidth, and update counts grouped by organization
 */
export async function getAdminOrgMetrics(
  c: Context,
  start_date: string,
  end_date: string,
  limit = 100,
): Promise<AdminOrgMetrics[]> {
  if (!c.env.DEVICE_USAGE)
    return []

  const safeLimit = normalizeAnalyticsLimit(limit, 100)

  const query = `SELECT
    blob2 AS org_id,
    COUNT(DISTINCT blob1) AS mau,
    COUNT(DISTINCT index1) AS apps_count
  FROM device_usage
  WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
    AND timestamp < toDateTime('${formatDateCF(end_date)}')
    AND blob2 != ''
  GROUP BY org_id
  ORDER BY mau DESC
  LIMIT ${safeLimit}`

  cloudlog({ requestId: c.get('requestId'), message: 'getAdminOrgMetrics query', query })

  try {
    const orgMau = await runQueryToCFA<{ org_id: string, mau: number, apps_count: number }>(c, query)

    // Get bandwidth per org
    if (c.env.BANDWIDTH_USAGE) {
      const periodStart = formatDateCF(start_date)
      const periodEnd = formatDateCF(end_date)
      const deviceOrgQuery = `SELECT
        blob1 AS device_id,
        argMax(blob2, timestamp) AS org_id
      FROM device_usage
      WHERE timestamp >= toDateTime('${periodStart}')
        AND timestamp < toDateTime('${periodEnd}')
        AND blob2 != ''
      GROUP BY blob1`
      const bandwidthByDeviceQuery = `SELECT
        blob1 AS device_id,
        sum(double1) AS bandwidth,
        COUNT() AS updates
      FROM bandwidth_usage
      WHERE timestamp >= toDateTime('${periodStart}')
        AND timestamp < toDateTime('${periodEnd}')
      GROUP BY blob1`

      const [deviceOrgRows, bandwidthByDeviceRows] = await Promise.all([
        runQueryToCFA<{ device_id: string, org_id: string }>(c, deviceOrgQuery),
        runQueryToCFA<{ device_id: string, bandwidth: number, updates: number }>(c, bandwidthByDeviceQuery),
      ])

      const orgByDevice = new Map(deviceOrgRows.map(row => [row.device_id, row.org_id]))
      const bandwidthByOrg = new Map<string, { bandwidth: number, updates: number }>()
      for (const row of bandwidthByDeviceRows) {
        const orgId = orgByDevice.get(row.device_id)
        if (!orgId)
          continue
        const current = bandwidthByOrg.get(orgId) ?? { bandwidth: 0, updates: 0 }
        current.bandwidth += row.bandwidth || 0
        current.updates += row.updates || 0
        bandwidthByOrg.set(orgId, current)
      }

      return orgMau.map(org => ({
        org_id: org.org_id,
        mau: org.mau,
        apps_count: org.apps_count,
        bandwidth: bandwidthByOrg.get(org.org_id)?.bandwidth || 0,
        updates: bandwidthByOrg.get(org.org_id)?.updates || 0,
      }))
    }

    return orgMau.map(org => ({
      org_id: org.org_id,
      mau: org.mau,
      apps_count: org.apps_count,
      bandwidth: 0,
      updates: 0,
    }))
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error in getAdminOrgMetrics', error: serializeError(e), query })
    return []
  }
}

/**
 * Get MAU trend over time for admin dashboard
 * Returns daily unique device counts, optionally filtered by org_id
 */
export async function getAdminMauTrend(
  c: Context,
  start_date: string,
  end_date: string,
  org_id?: string,
): Promise<AdminMauTrend[]> {
  if (!c.env.DEVICE_USAGE)
    return []

  const orgFilter = org_id ? `AND blob2 = '${escapeSqlString(org_id)}'` : ''

  const query = `SELECT
    formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
    COUNT(DISTINCT blob1) AS mau
  FROM device_usage
  WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
    AND timestamp < toDateTime('${formatDateCF(end_date)}')
    ${orgFilter}
  GROUP BY date
  ORDER BY date ASC`

  cloudlog({ requestId: c.get('requestId'), message: 'getAdminMauTrend query', query })

  try {
    const result = await runQueryToCFA<AdminMauTrend>(c, query)
    return result
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error in getAdminMauTrend', error: serializeError(e), query })
    return []
  }
}

/**
 * Get success rate trend over time for admin dashboard
 * Returns daily install vs fail counts with calculated success rate
 */
export async function getAdminSuccessRateTrend(
  c: Context,
  start_date: string,
  end_date: string,
  app_id?: string,
): Promise<AdminSuccessRateTrend[]> {
  if (!c.env.VERSION_USAGE)
    return []

  const appFilter = app_id ? `AND blob1 = '${escapeSqlString(app_id)}'` : ''

  const query = `SELECT
    formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
    sum(if(blob3 = 'install', 1, 0)) AS installs,
    sum(if(blob3 = 'fail', 1, 0)) AS fails
  FROM version_usage
  WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
    AND timestamp < toDateTime('${formatDateCF(end_date)}')
    ${appFilter}
  GROUP BY date
  ORDER BY date ASC`

  cloudlog({ requestId: c.get('requestId'), message: 'getAdminSuccessRateTrend query', query })

  try {
    const rawResult = await runQueryToCFA<{ date: string, installs: number, fails: number }>(c, query)
    // Calculate success_rate in JavaScript for each day
    const result: AdminSuccessRateTrend[] = rawResult.map(row => ({
      date: row.date,
      installs: row.installs,
      fails: row.fails,
      success_rate: (row.installs + row.fails) > 0 ? (row.installs / (row.installs + row.fails)) * 100 : 0,
    }))
    return result
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error in getAdminSuccessRateTrend', error: serializeError(e), query })
    return []
  }
}

/**
 * Get app activity trend over time (active apps per day)
 * Queries APP_LOG to count distinct apps with activity
 */
export async function getAdminAppsTrend(
  c: Context,
  start_date: string,
  end_date: string,
): Promise<AdminAppsTrend[]> {
  if (!c.env.APP_LOG)
    return []

  const query = `SELECT
    formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
    COUNT(DISTINCT index1) AS apps_created
  FROM app_log
  WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
    AND timestamp < toDateTime('${formatDateCF(end_date)}')
  GROUP BY date
  ORDER BY date ASC`

  cloudlog({ requestId: c.get('requestId'), message: 'getAdminAppsTrend query', query })

  try {
    const result = await runQueryToCFA<AdminAppsTrend>(c, query)
    return result
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error in getAdminAppsTrend', error: serializeError(e), query })
    return []
  }
}

/**
 * Get bundle uploads trend over time (unique versions uploaded per day)
 * Queries VERSION_USAGE to count distinct version uploads
 */
export async function getAdminBundlesTrend(
  c: Context,
  start_date: string,
  end_date: string,
): Promise<AdminBundlesTrend[]> {
  if (!c.env.VERSION_USAGE)
    return []

  const query = `SELECT
    formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
    COUNT(DISTINCT blob2) AS bundles_created
  FROM version_usage
  WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
    AND timestamp < toDateTime('${formatDateCF(end_date)}')
  GROUP BY date
  ORDER BY date ASC`

  cloudlog({ requestId: c.get('requestId'), message: 'getAdminBundlesTrend query', query })

  try {
    const result = await runQueryToCFA<AdminBundlesTrend>(c, query)
    return result
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error in getAdminBundlesTrend', error: serializeError(e), query })
    return []
  }
}

/**
 * Get deployments trend over time (channel_devices updates)
 * Queries APP_LOG for deployment events
 */
// Admin Storage Trend (from BANDWIDTH_USAGE - daily total file size)
export interface AdminStorageTrend {
  date: string
  storage_bytes: number
}

export async function getAdminStorageTrend(
  c: Context,
  start_date: string,
  end_date: string,
  app_id?: string,
): Promise<AdminStorageTrend[]> {
  if (!c.env.BANDWIDTH_USAGE)
    return []

  const appFilter = app_id ? `AND index1 = '${escapeSqlString(app_id)}'` : ''

  const query = `SELECT
  formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
  sum(double1) AS storage_bytes
FROM bandwidth_usage
WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
  AND timestamp < toDateTime('${formatDateCF(end_date)}')
  ${appFilter}
GROUP BY date
ORDER BY date ASC`

  cloudlog({ requestId: c.get('requestId'), message: 'getAdminStorageTrend query', query })

  try {
    const result = await runQueryToCFA<AdminStorageTrend>(c, query)
    return result.map(row => ({
      date: row.date,
      storage_bytes: Number(row.storage_bytes) || 0,
    }))
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error in getAdminStorageTrend', error: serializeError(e) })
    return []
  }
}

// Admin Bandwidth Trend (from BANDWIDTH_USAGE - daily total bandwidth)
export interface AdminBandwidthTrend {
  date: string
  bandwidth_bytes: number
}

export async function getAdminBandwidthTrend(
  c: Context,
  start_date: string,
  end_date: string,
  app_id?: string,
): Promise<AdminBandwidthTrend[]> {
  if (!c.env.BANDWIDTH_USAGE)
    return []

  const appFilter = app_id ? `AND index1 = '${escapeSqlString(app_id)}'` : ''

  const query = `SELECT
  formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS date,
  sum(double1) AS bandwidth_bytes
FROM bandwidth_usage
WHERE timestamp >= toDateTime('${formatDateCF(start_date)}')
  AND timestamp < toDateTime('${formatDateCF(end_date)}')
  ${appFilter}
GROUP BY date
ORDER BY date ASC`

  cloudlog({ requestId: c.get('requestId'), message: 'getAdminBandwidthTrend query', query })

  try {
    const result = await runQueryToCFA<AdminBandwidthTrend>(c, query)
    return result.map(row => ({
      date: row.date,
      bandwidth_bytes: Number(row.bandwidth_bytes) || 0,
    }))
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error in getAdminBandwidthTrend', error: serializeError(e) })
    return []
  }
}

// Plugin Version Breakdown
export interface PluginVersionBreakdown {
  [version: string]: number // percentage (0-100)
}

export interface PluginVersionTopApp {
  app_id: string
  device_count: number
  share: number
}

export interface PluginVersionLadderEntry {
  version: string
  device_count: number
  percent: number
  top_apps: PluginVersionTopApp[]
}

export interface PluginBreakdownRow {
  plugin_version: string
  app_id: string
  device_count: number | string
}

export interface PluginBreakdownResult {
  version_breakdown: PluginVersionBreakdown // Full version breakdown (e.g., {"6.2.5": 45.2})
  major_breakdown: PluginVersionBreakdown // Major version breakdown (e.g., {"6": 75.3})
  version_ladder: PluginVersionLadderEntry[]
}

export function buildPluginBreakdownResult(result: PluginBreakdownRow[]): PluginBreakdownResult {
  const emptyResult: PluginBreakdownResult = { version_breakdown: {}, major_breakdown: {}, version_ladder: [] }
  if (result.length === 0)
    return emptyResult

  const versionCounts = new Map<string, number>()
  const versionAppCounts = new Map<string, Map<string, number>>()
  for (const row of result) {
    const version = row.plugin_version
    const appId = row.app_id
    const deviceCount = Number(row.device_count) || 0
    if (!(version && appId && deviceCount > 0))
      continue

    versionCounts.set(version, (versionCounts.get(version) || 0) + deviceCount)
    const appCounts = versionAppCounts.get(version) ?? new Map<string, number>()
    appCounts.set(appId, (appCounts.get(appId) || 0) + deviceCount)
    versionAppCounts.set(version, appCounts)
  }

  const total = Array.from(versionCounts.values()).reduce((sum, count) => sum + count, 0)

  if (total === 0)
    return emptyResult

  const version_breakdown: PluginVersionBreakdown = {}
  const majorCounts = new Map<string, number>()

  for (const [version, count] of versionCounts) {
    const percentage = Number(((count / total) * 100).toFixed(2))
    if (percentage > 0)
      version_breakdown[version] = percentage

    const major = version.split('.')[0]
    if (major)
      majorCounts.set(major, (majorCounts.get(major) || 0) + count)
  }

  const major_breakdown: PluginVersionBreakdown = {}
  for (const [major, count] of majorCounts) {
    const percentage = Number(((count / total) * 100).toFixed(2))
    if (percentage > 0)
      major_breakdown[major] = percentage
  }

  const version_ladder = Array.from(versionCounts.entries())
    .sort(([versionA, countA], [versionB, countB]) => countB - countA || versionA.localeCompare(versionB))
    .slice(0, 20)
    .map(([version, count]) => {
      const appCounts = versionAppCounts.get(version) ?? new Map<string, number>()
      const top_apps = Array.from(appCounts.entries())
        .sort(([appA, countA], [appB, countB]) => countB - countA || appA.localeCompare(appB))
        .slice(0, 3)
        .map(([app_id, device_count]) => ({
          app_id,
          device_count,
          share: Number(((device_count / count) * 100).toFixed(2)),
        }))

      return {
        version,
        device_count: count,
        percent: Number(version_breakdown[version]) || 0,
        top_apps,
      }
    })

  return { version_breakdown, major_breakdown, version_ladder }
}

/**
 * Get plugin version breakdown for global stats
 * Returns percentage breakdown of plugin versions installed on devices (last 30 days)
 */
export async function getPluginBreakdownCF(c: Context, referenceDate?: Date): Promise<PluginBreakdownResult> {
  const emptyResult: PluginBreakdownResult = { version_breakdown: {}, major_breakdown: {}, version_ladder: [] }
  if (!c.env.DEVICE_INFO)
    return emptyResult

  const { startExpression, endExpression } = getLastMonthAnalyticsWindow(referenceDate)

  // Query latest plugin_version per app/device pair, then aggregate by version and app.
  const query = `SELECT
    plugin_version,
    app_id,
    count() AS device_count
  FROM (
    SELECT
      argMax(index1, timestamp) AS app_id,
      argMax(blob3, timestamp) AS plugin_version,
      blob1 AS device_id
    FROM device_info
    WHERE timestamp >= ${startExpression}
      AND timestamp < ${endExpression}
      AND blob3 != ''
    GROUP BY index1, blob1
  )
  WHERE plugin_version != ''
    AND app_id != ''
  GROUP BY plugin_version, app_id`

  cloudlog({ requestId: c.get('requestId'), message: 'getPluginBreakdownCF query', query })

  try {
    const result = await runQueryToCFA<PluginBreakdownRow>(c, query)
    return buildPluginBreakdownResult(result)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error in getPluginBreakdownCF', error: serializeError(e) })
    return emptyResult
  }
}

const PUBLIC_FAILURE_ACTIONS = ['set_fail', 'update_fail', 'download_fail', 'windows_path_fail', 'canonical_path_fail', 'directory_path_fail', 'unzip_fail', 'low_mem_fail', 'download_manifest_file_fail', 'download_manifest_checksum_fail', 'download_manifest_brotli_fail', 'finish_download_fail', 'manifest_path_fail', 'decrypt_fail', 'insufficient_disk_space', 'cannotGetBundle', 'checksum_fail', 'blocked_by_server_url', 'backend_refusal'] as const

export interface PublicBreakdownMetric {
  key: string
  share: number
  success_rate: number | null
  top_failure: { reason: string, share: number } | null
}

export interface PublicLiveUpdateMetrics {
  success_rate: number
  daily: Array<{ date: string, success_rate: number }>
  failures: Array<{ reason: string, share: number }>
  platforms: PublicBreakdownMetric[]
  countries: PublicBreakdownMetric[]
  updater_versions: PublicBreakdownMetric[]
}

const PUBLIC_MIN_DIMENSION_OUTCOMES = 50
const PUBLIC_TOP_COUNTRIES = 12
const PUBLIC_TOP_VERSIONS = 10

/** Public /data metrics are percentage-only — never expose raw counts. */
function roundPublicPercent(value: number) {
  return Number(value.toFixed(1))
}

function rawShare(part: number, total: number) {
  return total > 0 ? (part / total) * 100 : 0
}

function buildBreakdownMetrics(
  shareRows: Array<{ key: string, devices: number }>,
  outcomeRows: Array<{ key: string, successes: number, failures: number }>,
  failureRows: Array<{ key: string, action: string, devices: number }>,
  limit: number,
): PublicBreakdownMetric[] {
  const shareTotal = shareRows.reduce((sum, row) => sum + (Number(row.devices) || 0), 0)
  const outcomesByKey = new Map<string, { successes: number, failures: number }>()
  for (const row of outcomeRows) {
    const key = String(row.key || '').trim()
    if (!key)
      continue
    outcomesByKey.set(key, {
      successes: Number(row.successes) || 0,
      failures: Number(row.failures) || 0,
    })
  }
  const failuresByKey = new Map<string, Array<{ reason: string, devices: number }>>()
  for (const row of failureRows) {
    const key = String(row.key || '').trim()
    if (!key)
      continue
    const list = failuresByKey.get(key) ?? []
    list.push({ reason: row.action, devices: Number(row.devices) || 0 })
    failuresByKey.set(key, list)
  }

  // Rank/limit on raw volume first, then round percentages for the public payload.
  return shareRows
    .map((row) => {
      const key = String(row.key || '').trim()
      const devices = Number(row.devices) || 0
      const outcomes = outcomesByKey.get(key)
      const totalOutcomes = outcomes ? outcomes.successes + outcomes.failures : 0
      const success_rate = totalOutcomes >= PUBLIC_MIN_DIMENSION_OUTCOMES
        ? roundPublicPercent((outcomes!.successes / totalOutcomes) * 100)
        : null
      const dimFailures = failuresByKey.get(key) ?? []
      const failureTotal = dimFailures.reduce((sum, item) => sum + item.devices, 0)
      const top = [...dimFailures].sort((a, b) => b.devices - a.devices)[0]
      return {
        key,
        devices,
        success_rate,
        top_failure: top && failureTotal
          ? { reason: top.reason, share: roundPublicPercent(rawShare(top.devices, failureTotal)) }
          : null,
      }
    })
    .filter(row => row.key && row.devices > 0)
    .sort((a, b) => b.devices - a.devices || (b.success_rate ?? -1) - (a.success_rate ?? -1))
    .slice(0, limit)
    .map(({ key, devices, success_rate, top_failure }) => ({
      key,
      share: roundPublicPercent(rawShare(devices, shareTotal)),
      success_rate,
      top_failure,
    }))
}

export async function getPublicLiveUpdateMetricsCF(c: Context, referenceDate = new Date()): Promise<PublicLiveUpdateMetrics> {
  if (!c.env.APP_LOG || !c.env.DEVICE_USAGE || !c.env.DEVICE_INFO || !getEnv(c, 'CF_ANALYTICS_TOKEN') || !getEnv(c, 'CF_ACCOUNT_ANALYTICS_ID'))
    throw new Error('Public live update metric bindings are unavailable')

  const end = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate()))
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 30)
  const window = `timestamp >= toDateTime('${formatDateCF(start)}') AND timestamp < toDateTime('${formatDateCF(end)}')`
  const failureActions = PUBLIC_FAILURE_ACTIONS.map(action => `'${action}'`).join(', ')
  const day = `formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d')`
  const outcomeBase = `SELECT ${day} AS date, index1 AS app_id, blob1 AS device_id, max(if(blob2 = 'set', 1, 0)) AS succeeded, max(if(blob2 IN (${failureActions}), 1, 0)) AS failed, argMax(blob5, timestamp) AS platform, argMax(blob6, timestamp) AS country, argMax(blob7, timestamp) AS plugin_version FROM app_log WHERE ${window} AND (blob2 = 'set' OR blob2 IN (${failureActions})) GROUP BY date, app_id, device_id`
  const outcomesQuery = `SELECT date, sum(succeeded) AS successes, sum(if(succeeded = 0, failed, 0)) AS failures FROM (${outcomeBase}) GROUP BY date`
  const failuresQuery = `SELECT action, count() AS devices FROM (SELECT ${day} AS date, blob2 AS action, index1 AS app_id, blob1 AS device_id FROM app_log WHERE ${window} AND blob2 IN (${failureActions}) GROUP BY date, action, app_id, device_id) GROUP BY action`
  const platformsShareQuery = `SELECT platform, count() AS devices FROM (SELECT double1 AS platform, index1 AS app_id, blob1 AS device_id FROM device_usage WHERE ${window} AND double1 IN (0.0, 1.0, 2.0) GROUP BY platform, app_id, device_id) GROUP BY platform`
  const platformsOutcomeQuery = `SELECT platform AS key, sum(succeeded) AS successes, sum(if(succeeded = 0, failed, 0)) AS failures FROM (${outcomeBase}) WHERE platform IN ('ios', 'android', 'electron') GROUP BY platform`
  const platformsFailureQuery = `SELECT platform AS key, action, count() AS devices FROM (SELECT ${day} AS date, index1 AS app_id, blob1 AS device_id, blob2 AS action, argMax(blob5, timestamp) AS platform FROM app_log WHERE ${window} AND blob2 IN (${failureActions}) GROUP BY date, app_id, device_id, action) WHERE platform IN ('ios', 'android', 'electron') GROUP BY platform, action`
  const countriesShareQuery = `SELECT country AS key, count() AS devices FROM (SELECT index1 AS app_id, blob1 AS device_id, argMax(blob10, timestamp) AS country FROM device_info WHERE ${window} AND blob10 != '' GROUP BY app_id, device_id) WHERE country != '' GROUP BY country`
  const countriesOutcomeQuery = `SELECT country AS key, sum(succeeded) AS successes, sum(if(succeeded = 0, failed, 0)) AS failures FROM (${outcomeBase}) WHERE country != '' GROUP BY country`
  const countriesFailureQuery = `SELECT country AS key, action, count() AS devices FROM (SELECT ${day} AS date, index1 AS app_id, blob1 AS device_id, blob2 AS action, argMax(blob6, timestamp) AS country FROM app_log WHERE ${window} AND blob2 IN (${failureActions}) GROUP BY date, app_id, device_id, action) WHERE country != '' GROUP BY country, action`
  const versionsShareQuery = `SELECT version AS key, count() AS devices FROM (SELECT index1 AS app_id, blob1 AS device_id, argMax(blob3, timestamp) AS version FROM device_info WHERE ${window} AND blob3 != '' GROUP BY app_id, device_id) WHERE version != '' GROUP BY version`
  const versionsOutcomeQuery = `SELECT plugin_version AS key, sum(succeeded) AS successes, sum(if(succeeded = 0, failed, 0)) AS failures FROM (${outcomeBase}) WHERE plugin_version != '' GROUP BY plugin_version`
  const versionsFailureQuery = `SELECT plugin_version AS key, action, count() AS devices FROM (SELECT ${day} AS date, index1 AS app_id, blob1 AS device_id, blob2 AS action, argMax(blob7, timestamp) AS plugin_version FROM app_log WHERE ${window} AND blob2 IN (${failureActions}) GROUP BY date, app_id, device_id, action) WHERE plugin_version != '' GROUP BY plugin_version, action`

  try {
    const [
      outcomeRows,
      failureRows,
      platformShareRows,
      platformOutcomeRows,
      platformFailureRows,
      countryShareRows,
      countryOutcomeRows,
      countryFailureRows,
      versionShareRows,
      versionOutcomeRows,
      versionFailureRows,
    ] = await Promise.all([
      runQueryToCFA<{ date: string, successes: number, failures: number }>(c, outcomesQuery),
      runQueryToCFA<{ action: string, devices: number }>(c, failuresQuery),
      runQueryToCFA<{ platform: number, devices: number }>(c, platformsShareQuery),
      runQueryToCFA<{ key: string, successes: number, failures: number }>(c, platformsOutcomeQuery),
      runQueryToCFA<{ key: string, action: string, devices: number }>(c, platformsFailureQuery),
      runQueryToCFA<{ key: string, devices: number }>(c, countriesShareQuery),
      runQueryToCFA<{ key: string, successes: number, failures: number }>(c, countriesOutcomeQuery),
      runQueryToCFA<{ key: string, action: string, devices: number }>(c, countriesFailureQuery),
      runQueryToCFA<{ key: string, devices: number }>(c, versionsShareQuery),
      runQueryToCFA<{ key: string, successes: number, failures: number }>(c, versionsOutcomeQuery),
      runQueryToCFA<{ key: string, action: string, devices: number }>(c, versionsFailureQuery),
    ])
    const daily = outcomeRows.map((row) => {
      const successes = Number(row.successes) || 0
      const failures = Number(row.failures) || 0
      const outcomes = successes + failures
      return { date: row.date, success_rate: outcomes ? roundPublicPercent((successes / outcomes) * 100) : 0 }
    }).sort((a, b) => a.date.localeCompare(b.date))
    const totalSuccesses = outcomeRows.reduce((sum, row) => sum + (Number(row.successes) || 0), 0)
    const totalFailures = outcomeRows.reduce((sum, row) => sum + (Number(row.failures) || 0), 0)
    const totalOutcomes = totalSuccesses + totalFailures
    const success_rate = totalOutcomes ? roundPublicPercent((totalSuccesses / totalOutcomes) * 100) : 0
    const failureTotal = failureRows.reduce((sum, row) => sum + (Number(row.devices) || 0), 0)
    const failures = [...failureRows]
      .map(row => ({ reason: row.action, devices: Number(row.devices) || 0 }))
      .sort((a, b) => b.devices - a.devices)
      .slice(0, 8)
      .map(row => ({
        reason: row.reason,
        share: failureTotal ? roundPublicPercent(rawShare(row.devices, failureTotal)) : 0,
      }))

    const platformShareMapped = platformShareRows.map((row) => {
      const platform = Number(row.platform)
      const key = platform === 0 ? 'android' : platform === 1 ? 'ios' : platform === 2 ? 'electron' : ''
      return { key, devices: Number(row.devices) || 0 }
    }).filter(row => row.key)

    return {
      success_rate,
      daily,
      failures,
      platforms: buildBreakdownMetrics(platformShareMapped, platformOutcomeRows, platformFailureRows, 3),
      countries: buildBreakdownMetrics(countryShareRows, countryOutcomeRows, countryFailureRows, PUBLIC_TOP_COUNTRIES),
      updater_versions: buildBreakdownMetrics(versionShareRows, versionOutcomeRows, versionFailureRows, PUBLIC_TOP_VERSIONS),
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading public live update metrics', error: serializeError(error) })
    throw error
  }
}
