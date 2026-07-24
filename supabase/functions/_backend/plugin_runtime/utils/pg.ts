import type { SQL } from 'drizzle-orm'
import type { Context } from 'hono'
import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { getRuntimeKey } from 'hono/adapter'
// @ts-types="npm:@types/pg"
import { Pool } from 'pg'
import { backgroundTask, existInEnv, getEnv } from '../utils/utils.ts'
import { CacheHelper } from './cache.ts'
import { getAdminOnboardingTelemetry } from './cloudflare.ts'
import { getAdminOnboardingActivationMetrics } from './onboardingFunnel.ts'
import type { AdminOnboardingActivationCohort } from './onboardingFunnel.ts'
import { getChannelSelfOverride, isChannelSelfStoreEnabled } from './channelSelfStore.ts'
import { DISPOSABLE_EMAIL_DOMAINS, PERSONAL_EMAIL_DOMAINS } from './emailClassification.ts'
import { getClientDbRegionSB } from './geolocation.ts'
import { REQUIRED_GLOBAL_STATS_SHARDS } from './global_stats.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import * as schema from './postgres_schema.ts'
import { withOptionalManifestSelect } from './queryHelpers.ts'
import { getRolloutDecision } from './rollout.ts'
import { shouldRequireReadReplica, shouldSkipDirectHyperdriveFallback } from './supabase_write_guard.ts'

const REPLICATION_LAG_THRESHOLD_SECONDS = 180
const REPLICATION_LAG_CACHE_TTL_SECONDS = 60
const REPLICATION_LAG_CACHE_TTL_MS = REPLICATION_LAG_CACHE_TTL_SECONDS * 1000

type ReplicationStatus = 'ok' | 'lagging' | 'unknown'
interface ChannelLookupResult { id: number, name: string, allow_device_self_set: boolean, public: boolean, owner_org: string }
type PlanAction = 'mau' | 'storage' | 'bandwidth'
type ReadReplicaHyperdriveBinding
  = | 'HYPERDRIVE_CAPGO_READ_AS_JAPAN'
    | 'HYPERDRIVE_CAPGO_READ_AS_INDIA'
    | 'HYPERDRIVE_CAPGO_READ_NA'
    | 'HYPERDRIVE_CAPGO_READ_EU'
    | 'HYPERDRIVE_CAPGO_READ_OC'
    | 'HYPERDRIVE_CAPGO_READ_SA'
    | 'HYPERDRIVE_CAPGO_READ_ME'
    | 'HYPERDRIVE_CAPGO_READ_AF'
    | 'HYPERDRIVE_CAPGO_READ_HK'

interface ReplicationLagStatus {
  status: ReplicationStatus
  max_lag_seconds: number | null
}

interface ReplicationLagCacheEntry extends ReplicationLagStatus {
  expiresAt: number
}

const replicationLagMemoryCache = new Map<string, ReplicationLagCacheEntry>()
const replicationLagInflight = new Map<string, Promise<ReplicationLagStatus>>()

const READ_REPLICA_ROUTES: { region: string, binding: ReadReplicaHyperdriveBinding }[] = [
  { region: 'AS_JAPAN', binding: 'HYPERDRIVE_CAPGO_READ_AS_JAPAN' },
  { region: 'AS_INDIA', binding: 'HYPERDRIVE_CAPGO_READ_AS_INDIA' },
  { region: 'NA', binding: 'HYPERDRIVE_CAPGO_READ_NA' },
  { region: 'EU', binding: 'HYPERDRIVE_CAPGO_READ_EU' },
  { region: 'OC', binding: 'HYPERDRIVE_CAPGO_READ_OC' },
  { region: 'SA', binding: 'HYPERDRIVE_CAPGO_READ_SA' },
  { region: 'ME', binding: 'HYPERDRIVE_CAPGO_READ_ME' },
  { region: 'AF', binding: 'HYPERDRIVE_CAPGO_READ_AF' },
  { region: 'HK', binding: 'HYPERDRIVE_CAPGO_READ_HK' },
]

const PLAN_EXCEEDED_COLUMNS: Record<PlanAction, string> = {
  mau: 'mau_exceeded',
  storage: 'storage_exceeded',
  bandwidth: 'bandwidth_exceeded',
}

export function buildPlanValidationExpression(
  actions: PlanAction[],
  ownerColumn: typeof schema.app_versions.owner_org | typeof schema.apps.owner_org,
) {
  const extraConditions = actions.map(action => ` AND ${PLAN_EXCEEDED_COLUMNS[action]} = false`).join('')
  const customerIdSubquery = sql<string | null>`(
    SELECT ${schema.orgs.customer_id}
    FROM ${schema.orgs}
    WHERE ${schema.orgs.id} = ${ownerColumn}
  )`
  // IMPORTANT: read replicas replicate table data but not views/functions.
  // Keep this expression replica-safe by relying on a replicated org flag.
  // has_usage_credits means the org currently has positive, unexpired credits.
  //
  // Backward compatibility for replicas that haven't replicated the column yet:
  // read via `to_jsonb(row)->>'has_usage_credits'` so the query still parses
  // even if the column doesn't exist. Missing column fails closed.
  //
  // Keep the subscription branch action-specific. is_good_plan also includes
  // build_time, which must not block update/upload paths when their own metrics fit.
  const hasCreditsExpression = sql`EXISTS (
    SELECT 1
    FROM ${schema.orgs}
    WHERE ${schema.orgs.id} = ${ownerColumn}
      AND COALESCE((to_jsonb(orgs) ->> 'has_usage_credits')::boolean, false) = true
  )`
  return sql<boolean>`(${hasCreditsExpression}) OR EXISTS (
    SELECT 1
    FROM ${schema.stripe_info}
    WHERE ${schema.stripe_info.customer_id} = (
      ${customerIdSubquery}
    )
    AND (
      (${schema.stripe_info.trial_at}::date > CURRENT_DATE)
      OR (
        ${schema.stripe_info.status} = 'succeeded'
        ${sql.raw(extraConditions)}
      )
    )
  ) OR (${customerIdSubquery} IS NULL)`
}

export function selectOne(pgClient: ReturnType<typeof getPgClient>) {
  // Use pg Pool directly to avoid Drizzle's prepared statement handling
  // which doesn't work with Supabase pooler in transaction mode
  return pgClient.query('SELECT 1')
}

function fixSupabaseHost(host: string): string {
  if (host.includes('postgres:postgres@supabase_db_')) {
    // Supabase adds a prefix to the hostname that breaks connection in local docker
    // e.g. "supabase_db_NAME:5432" -> "db:5432"
    const url = URL.parse(host)!
    url.hostname = url.hostname.split('_')[1]
    return url.href
  }
  return host
}

function getReplicationLagCacheKey(c: Context): string {
  return String(c.get('databaseSource') ?? c.res.headers.get('X-Database-Source') ?? 'unknown')
}

function getFreshReplicationLagMemoryEntry(cacheKey: string, now = Date.now()): ReplicationLagStatus | null {
  const cached = replicationLagMemoryCache.get(cacheKey)
  if (!cached)
    return null
  if (cached.expiresAt <= now) {
    replicationLagMemoryCache.delete(cacheKey)
    return null
  }
  return {
    status: cached.status,
    max_lag_seconds: cached.max_lag_seconds,
  }
}

function setReplicationLagMemoryEntry(cacheKey: string, status: ReplicationLagStatus, expiresAt = Date.now() + REPLICATION_LAG_CACHE_TTL_MS) {
  replicationLagMemoryCache.set(cacheKey, {
    ...status,
    expiresAt,
  })
}

function toReplicationLagSeconds(value: unknown): number | null {
  if (value === null || value === undefined)
    return null
  const lagSeconds = Number(value)
  return Number.isFinite(lagSeconds) ? lagSeconds : null
}

/**
 * Query replication lag from the REPLICA database using pg_stat_subscription.
 * Uses the existing pool - no new connections.
 */
async function queryReplicaLag(c: Context, pool: Pool): Promise<ReplicationLagStatus> {
  try {
    const query = `
      SELECT MAX(EXTRACT(EPOCH FROM (now() - last_msg_receipt_time))) AS lag_seconds
      FROM pg_stat_subscription
      WHERE last_msg_receipt_time IS NOT NULL
    `

    const result = await pool.query(query)
    const lagSeconds = toReplicationLagSeconds(result.rows[0]?.lag_seconds)

    let status: ReplicationStatus = 'unknown'
    if (lagSeconds !== null) {
      status = lagSeconds > REPLICATION_LAG_THRESHOLD_SECONDS ? 'lagging' : 'ok'
    }

    cloudlog({ requestId: c.get('requestId'), message: 'Replica lag queried', status, lagSeconds })

    return {
      status,
      max_lag_seconds: lagSeconds,
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error querying replica lag', error })
    return {
      status: 'unknown',
      max_lag_seconds: null,
    }
  }
}

async function getCachedReplicaLag(c: Context, pool: Pool): Promise<ReplicationLagStatus> {
  const cacheKey = getReplicationLagCacheKey(c)
  const memoryEntry = getFreshReplicationLagMemoryEntry(cacheKey)
  if (memoryEntry)
    return memoryEntry

  const existingQuery = replicationLagInflight.get(cacheKey)
  if (existingQuery)
    return existingQuery

  const cacheHelper = new CacheHelper(c)
  const cacheRequest = cacheHelper.buildRequest('/cache/replication-lag', { source: cacheKey })
  const cachedEntry = await cacheHelper.matchJson<ReplicationLagCacheEntry>(cacheRequest)

  if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
    const cachedStatus = {
      status: cachedEntry.status,
      max_lag_seconds: cachedEntry.max_lag_seconds,
    }
    setReplicationLagMemoryEntry(cacheKey, cachedStatus, cachedEntry.expiresAt)
    return cachedStatus
  }

  const existingQueryAfterCache = replicationLagInflight.get(cacheKey)
  if (existingQueryAfterCache)
    return existingQueryAfterCache

  const query = queryReplicaLag(c, pool)
    .then(async (status) => {
      const expiresAt = Date.now() + REPLICATION_LAG_CACHE_TTL_MS
      setReplicationLagMemoryEntry(cacheKey, status, expiresAt)
      await cacheHelper.putJson(cacheRequest, { ...status, expiresAt }, REPLICATION_LAG_CACHE_TTL_SECONDS)
      return status
    })
    .finally(() => {
      replicationLagInflight.delete(cacheKey)
    })

  replicationLagInflight.set(cacheKey, query)
  return query
}

/**
 * Set replication lag headers on hot plugin responses using a 60-second cache.
 */
export async function setReplicationLagHeader(c: Context, pool: Pool): Promise<void> {
  const status = await getCachedReplicaLag(c, pool)
  safeSetResponseHeader(c, 'X-Replication-Lag', status.status)
  if (status.max_lag_seconds !== null) {
    safeSetResponseHeader(c, 'X-Replication-Lag-Seconds', String(Math.round(status.max_lag_seconds)))
  }
}

/**
 * Best-effort response header setter.
 *
 * In Cloudflare Workers, we sometimes run background tasks via `waitUntil()`
 * after the response has started streaming. Hono's `c.header()` clones the
 * Response and reuses the body stream; if the stream is already used/locked
 * this can throw (e.g. "ReadableStream is disturbed").
 */
function safeSetResponseHeader(c: Context, name: string, value: string): void {
  try {
    const res = c.res
    if (res?.bodyUsed)
      return
    const body = res?.body as unknown as { locked?: boolean } | null
    if (body?.locked)
      return
  }
  catch {
    return
  }

  try {
    c.header(name, value)
  }
  catch {
    // Best-effort only: avoid crashing background tasks due to header mutation.
  }
}

/**
 * Store the selected DB source in the context (for logging) and try to also
 * expose it via a response header when still safe to mutate headers.
 */
function setDatabaseSource(c: Context, source: string): void {
  try {
    c.set('databaseSource', source)
  }
  catch {
    // Ignore: mostly useful for logging in request-scoped context.
  }
  safeSetResponseHeader(c, 'X-Database-Source', source)
}

function getReadOnlyDatabaseURL(c: Context, dbRegion: string | undefined): string | null {
  const selectedRoute = READ_REPLICA_ROUTES.find(route => route.region === dbRegion && c.env[route.binding])
  if (!selectedRoute)
    return null

  setDatabaseSource(c, selectedRoute.binding)
  cloudlog({ requestId: c.get('requestId'), message: `Using ${selectedRoute.binding} for read-only` })
  return c.env[selectedRoute.binding].connectionString
}

function isLocalWorkerEnv(c: Context): boolean {
  return existInEnv(c, 'ENV_NAME') && getEnv(c, 'ENV_NAME').endsWith('-local')
}

function getLocalReadOnlyDatabaseURL(c: Context): string | null {
  if (!isLocalWorkerEnv(c) || !existInEnv(c, 'LOCAL_READ_REPLICA_SUPABASE_DB_URL'))
    return null

  setDatabaseSource(c, 'local_read_replica')
  cloudlog({ requestId: c.get('requestId'), message: 'Using LOCAL_READ_REPLICA_SUPABASE_DB_URL for read-only' })
  return fixSupabaseHost(getEnv(c, 'LOCAL_READ_REPLICA_SUPABASE_DB_URL'))
}

export function getDatabaseURL(c: Context, readOnly = false): string {
  const dbRegion = getClientDbRegionSB(c)

  // For read-only queries, use region to avoid Network latency
  if (readOnly) {
    const readOnlyDatabaseURL = getReadOnlyDatabaseURL(c, dbRegion)
    if (readOnlyDatabaseURL)
      return readOnlyDatabaseURL

    const localReadOnlyDatabaseURL = getLocalReadOnlyDatabaseURL(c)
    if (localReadOnlyDatabaseURL)
      return localReadOnlyDatabaseURL
  }

  if (readOnly && shouldRequireReadReplica(c)) {
    cloudlog({ requestId: c.get('requestId'), message: 'Read replica is required for this endpoint' })
    throw new Error('Read replica is required for this endpoint')
  }

  if (c.env.HYPERDRIVE_CAPGO_DIRECT_EU && !shouldSkipDirectHyperdriveFallback(c)) {
    setDatabaseSource(c, 'HYPERDRIVE_CAPGO_DIRECT_EU')
    cloudlog({ requestId: c.get('requestId'), message: `Using HYPERDRIVE_CAPGO_DIRECT_EU for ${readOnly ? 'read-only' : 'read-write'}` })
    return c.env.HYPERDRIVE_CAPGO_DIRECT_EU.connectionString
  }

  if (c.env.HYPERDRIVE_CAPGO_DIRECT_EU) {
    cloudlog({ requestId: c.get('requestId'), message: 'Skipping HYPERDRIVE_CAPGO_DIRECT_EU fallback for this endpoint' })
  }

  // Main DB write poller EU region in supabase
  if (existInEnv(c, 'MAIN_SUPABASE_DB_URL')) {
    setDatabaseSource(c, 'sb_pooler_main')
    cloudlog({ requestId: c.get('requestId'), message: 'Using MAIN_SUPABASE_DB_URL for read-write' })
    return getEnv(c, 'MAIN_SUPABASE_DB_URL')
  }

  // Default Supabase direct connection used for testing or if no other option is available
  setDatabaseSource(c, 'direct')
  cloudlog({ requestId: c.get('requestId'), message: 'Using Direct Supabase for read-write' })
  return fixSupabaseHost(getEnv(c, 'SUPABASE_DB_URL'))
}

export function getPgClient(c: Context, readOnly = false) {
  const dbUrl = getDatabaseURL(c, readOnly)
  const requestId = c.get('requestId')
  const appName = c.res.headers.get('X-Worker-Source') ?? 'unknown source'
  const dbName = String(c.get('databaseSource') ?? c.res.headers.get('X-Database-Source') ?? 'unknown source')
  cloudlog({ requestId, message: 'SUPABASE_DB_URL selected', dbName, appName, readOnly })

  const isPooler = dbName.startsWith('sb_pooler')
  const options = {
    connectionString: dbUrl,
    max: 4,
    application_name: `${appName}-${dbName}`,
    idleTimeoutMillis: 20000, // Increase from 2 to 20 seconds
    connectionTimeoutMillis: 10000, // Add explicit connect timeout
    maxLifetimeMillis: 30 * 60 * 1000, // 30 minutes
    // PgBouncer/Supabase pooler doesn't support the 'options' startup parameter
    options: readOnly && !isPooler ? '-c default_transaction_read_only=on' : undefined,
  }

  const pool = new Pool(options)

  // Hook to log when connections are removed from the pool
  pool.on('remove', () => {
    cloudlog({ requestId, message: 'PG Connection Removed from Pool' })
  })

  pool.on('error', (err: Error) => {
    cloudlogErr({ requestId, message: 'PG Pool Error', error: err })
  })

  return pool
}

export function getDrizzleClient(db: ReturnType<typeof getPgClient>, options?: { logger?: boolean }) {
  // Keep SQL logging on by default for API/trigger diagnostics.
  // Plugin hot paths pass `{ logger: false }` to avoid per-request log CPU/volume.
  return drizzle({ client: db, logger: options?.logger ?? true })
}

// Helper to extract detailed error information from pg errors
export function logPgError(c: Context, functionName: string, error: unknown) {
  const e = error as Error & {
    code?: string
    errno?: number
    syscall?: string
    address?: string
    port?: number
    severity?: string
    detail?: string
    hint?: string
    position?: string
    routine?: string
    file?: string
    line?: string
    column?: string
  }

  cloudlogErr({
    requestId: c.get('requestId'),
    message: `${functionName} - PostgreSQL Error`,
    error: {
      // Basic error info
      message: e.message,
      name: e.name,
      stack: e.stack,

      // PostgreSQL-specific error codes
      code: e.code, // e.g., '57P01' for connection termination, 'ECONNREFUSED', 'ETIMEDOUT'
      severity: e.severity,
      detail: e.detail,
      hint: e.hint,

      // Network-level errors
      errno: e.errno, // System error number
      syscall: e.syscall, // System call that failed (e.g., 'connect', 'read', 'write')
      address: e.address, // IP address
      port: e.port, // Port number

      // Query position info
      position: e.position,
      routine: e.routine,

      // File info for debugging
      file: e.file,
      line: e.line,
      column: e.column,
    },
  })
}

export function closeClient(c: Context, db: ReturnType<typeof getPgClient>) {
  // cloudlog(c.get('requestId'), 'Closing client', client)
  if (getRuntimeKey() !== 'workerd')
    return backgroundTask(c, db.end())
  return undefined
}

export function getAlias() {
  const versionAlias = alias(schema.app_versions, 'version')
  const rolloutVersionAlias = alias(schema.app_versions, 'rollout_version')
  const channelDevicesAlias = alias(schema.channel_devices, 'channel_devices')
  const channelAlias = alias(schema.channels, 'channels')
  return { versionAlias, rolloutVersionAlias, channelDevicesAlias, channelAlias }
}

function getVersionSelect(
  versionAlias: any,
  prefix: string,
  includeMetadata = false,
  channelVersionColumn?: any,
) {
  const versionSelect: any = {
    id: sql<number | null>`${versionAlias.id}`.as(`${prefix}id`),
    name: channelVersionColumn
      ? sql<string>`CASE WHEN ${channelVersionColumn} IS NULL THEN 'builtin' ELSE ${versionAlias.name} END`.as(`${prefix}name`)
      : sql<string>`${versionAlias.name}`.as(`${prefix}name`),
    checksum: sql<string | null>`${versionAlias.checksum}`.as(`${prefix}checksum`),
    session_key: sql<string | null>`${versionAlias.session_key}`.as(`${prefix}session_key`),
    key_id: sql<string | null>`${versionAlias.key_id}`.as(`${prefix}key_id`),
    storage_provider: sql<string>`COALESCE(${versionAlias.storage_provider}, 'r2')`.as(`${prefix}storage_provider`),
    external_url: sql<string | null>`${versionAlias.external_url}`.as(`${prefix}external_url`),
    min_update_version: sql<string | null>`${versionAlias.min_update_version}`.as(`${prefix}minUpdateVersion`),
    manifest_count: sql<number>`${versionAlias.manifest_count}`.as(`${prefix}manifest_count`),
    r2_path: sql`${versionAlias.r2_path}`.mapWith(versionAlias.r2_path).as(`${prefix}r2_path`),
  }

  if (includeMetadata) {
    versionSelect.link = sql<string | null>`${versionAlias.link}`.as(`${prefix}link`)
    versionSelect.comment = sql<string | null>`${versionAlias.comment}`.as(`${prefix}comment`)
  }

  return versionSelect
}

function getSchemaUpdatesAlias(includeMetadata = false) {
  const { versionAlias, rolloutVersionAlias, channelDevicesAlias, channelAlias } = getAlias()
  const versionSelect = getVersionSelect(versionAlias, 'v', includeMetadata, channelAlias.version)
  const rolloutVersionSelect = getVersionSelect(rolloutVersionAlias, 'rv', includeMetadata)
  const channelSelect = {
    id: channelAlias.id,
    name: channelAlias.name,
    app_id: channelAlias.app_id,
    allow_dev: channelAlias.allow_dev,
    allow_prod: channelAlias.allow_prod,
    allow_emulator: channelAlias.allow_emulator,
    allow_device: channelAlias.allow_device,
    disable_auto_update_under_native: channelAlias.disable_auto_update_under_native,
    disable_auto_update: channelAlias.disable_auto_update,
    ios: channelAlias.ios,
    android: channelAlias.android,
    electron: channelAlias.electron,
    allow_device_self_set: channelAlias.allow_device_self_set,
    public: channelAlias.public,
    rollout_version: channelAlias.rollout_version,
    rollout_percentage_bps: channelAlias.rollout_percentage_bps,
    rollout_enabled: channelAlias.rollout_enabled,
    rollout_id: channelAlias.rollout_id,
    rollout_paused_at: channelAlias.rollout_paused_at,
    rollout_pause_reason: channelAlias.rollout_pause_reason,
    rollout_cache_ttl_seconds: channelAlias.rollout_cache_ttl_seconds,
  }
  const manifestSelect = sql<{ file_name: string, file_hash: string, s3_path: string }[]>`COALESCE(json_agg(
        json_build_object(
          'file_name', ${schema.manifest.file_name},
          'file_hash', ${schema.manifest.file_hash},
          's3_path', ${schema.manifest.s3_path}
        )
      ) FILTER (WHERE ${schema.manifest.file_name} IS NOT NULL), '[]'::json)`
  return { versionSelect, rolloutVersionSelect, channelDevicesAlias, channelAlias, channelSelect, manifestSelect, versionAlias, rolloutVersionAlias }
}

function activeChannelVersionJoin(
  channelVersionColumn: any,
  versionAlias: any,
  channelAppIdColumn?: any,
) {
  const conditions = [
    eq(channelVersionColumn, versionAlias.id),
    or(eq(versionAlias.deleted, false), eq(versionAlias.name, 'builtin')),
  ]

  if (channelAppIdColumn)
    conditions.push(eq(versionAlias.app_id, channelAppIdColumn))

  return and(...conditions)
}

export function requestInfosChannelDevicePostgres(
  c: Context,
  app_id: string,
  device_id: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  includeManifest: boolean,
  includeMetadata = false,
) {
  const { versionSelect, channelDevicesAlias, channelAlias, channelSelect, manifestSelect, versionAlias } = getSchemaUpdatesAlias(includeMetadata)
  const baseSelect = {
    channel_devices: {
      device_id: channelDevicesAlias.device_id,
      app_id: sql<string>`${channelDevicesAlias.app_id}`.as('cd_app_id'),
    },
    version: versionSelect,
    channels: channelSelect,
  }
  const selectShape = withOptionalManifestSelect(baseSelect, includeManifest, manifestSelect)

  const baseQuery = drizzleClient
    .select(selectShape)
    .from(channelDevicesAlias)
    .innerJoin(channelAlias, eq(channelDevicesAlias.channel_id, channelAlias.id))
    .leftJoin(versionAlias, activeChannelVersionJoin(channelAlias.version, versionAlias))

  const channelDevice = (includeManifest
    ? baseQuery.leftJoin(schema.manifest, eq(schema.manifest.app_version_id, versionAlias.id))
    : baseQuery)
    .where(and(
      eq(channelDevicesAlias.device_id, device_id),
      eq(channelDevicesAlias.app_id, app_id),
      or(isNull(channelAlias.version), isNotNull(versionAlias.id)),
    ))
    .groupBy(channelDevicesAlias.device_id, channelDevicesAlias.app_id, channelAlias.id, versionAlias.id)
    .limit(1)
  cloudlog({ requestId: c.get('requestId'), message: 'channelDevice Query:', channelDeviceQuery: channelDevice.toSQL() })

  return channelDevice.then(data => data.at(0))
}

export async function getEffectiveDeviceChannelNamePostgres(
  c: Context,
  app_id: string,
  device_id: string,
  fallbackChannelName: string | null | undefined,
  platform: string,
  hasChannelDeviceOverrides: boolean,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
) {
  const fallback = typeof fallbackChannelName === 'string' && fallbackChannelName.trim() !== ''
    ? fallbackChannelName.trim()
    : null
  const { channelDevicesAlias, channelAlias } = getAlias()
  const platformQuery = platform === 'android' ? channelAlias.android : platform === 'electron' ? channelAlias.electron : channelAlias.ios

  const getChannelById = async (channelId: number) => {
    const channelQuery = drizzleClient
      .select({ id: channelAlias.id, name: channelAlias.name })
      .from(channelAlias)
      .where(and(
        eq(channelAlias.app_id, app_id),
        eq(channelAlias.id, channelId),
        eq(platformQuery, true),
        or(
          eq(channelAlias.public, true),
          eq(channelAlias.allow_device_self_set, true),
        ),
      ))
      .limit(1)

    cloudlog({ requestId: c.get('requestId'), message: 'stats channel self override Query:', channelQuery: channelQuery.toSQL() })
    const channel = await channelQuery.then(data => data.at(0))
    return channel?.name ? channel : null
  }

  if (isChannelSelfStoreEnabled(c as any)) {
    const storedOverride = await getChannelSelfOverride(c as any, app_id, device_id.toLowerCase())
    if (storedOverride?.channel_id.id) {
      const channel = await getChannelById(storedOverride.channel_id.id)
      if (channel?.name)
        return channel
    }
  }

  if (hasChannelDeviceOverrides) {
    const channelQuery = drizzleClient
      .select({ id: channelAlias.id, name: channelAlias.name })
      .from(channelDevicesAlias)
      .innerJoin(channelAlias, and(eq(channelDevicesAlias.channel_id, channelAlias.id), eq(channelAlias.app_id, app_id)))
      .where(and(eq(channelDevicesAlias.device_id, device_id), eq(channelDevicesAlias.app_id, app_id)))
      .limit(1)

    cloudlog({ requestId: c.get('requestId'), message: 'stats channel override Query:', channelQuery: channelQuery.toSQL() })
    const channel = await channelQuery.then(data => data.at(0))
    if (channel?.name)
      return channel
  }
  const getChannelByName = async (channelName: string | null) => {
    const channelQuery = drizzleClient
      .select({ id: channelAlias.id, name: channelAlias.name })
      .from(channelAlias)
      .where(
        channelName
          ? and(
              eq(channelAlias.app_id, app_id),
              eq(channelAlias.name, channelName),
              eq(platformQuery, true),
              or(
                eq(channelAlias.public, true),
                eq(channelAlias.allow_device_self_set, true),
              ),
            )
          : and(
              eq(channelAlias.public, true),
              eq(channelAlias.app_id, app_id),
              eq(platformQuery, true),
            ),
      )
      .orderBy(channelAlias.name, channelAlias.id)
      .limit(1)

    cloudlog({ requestId: c.get('requestId'), message: 'stats channel Query:', channelQuery: channelQuery.toSQL(), fallbackChannelName: channelName })
    const channel = await channelQuery.then(data => data.at(0))
    return channel?.name ? channel : null
  }

  if (fallback) {
    const channelName = await getChannelByName(fallback)
    if (channelName)
      return channelName
  }

  return getChannelByName(null)
}

export function requestInfosChannelByIdPostgres(
  c: Context,
  app_id: string,
  channelId: number,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  includeManifest: boolean,
  includeMetadata = false,
) {
  const { versionSelect, channelAlias, channelSelect, manifestSelect, versionAlias } = getSchemaUpdatesAlias(includeMetadata)
  const baseSelect = {
    version: versionSelect,
    channels: channelSelect,
  }
  const selectShape = withOptionalManifestSelect(baseSelect, includeManifest, manifestSelect)

  const baseQuery = drizzleClient
    .select(selectShape)
    .from(channelAlias)
    .innerJoin(versionAlias, activeChannelVersionJoin(channelAlias.version, versionAlias))

  const channel = (includeManifest
    ? baseQuery.leftJoin(schema.manifest, eq(schema.manifest.app_version_id, versionAlias.id))
    : baseQuery)
    .where(and(
      eq(channelAlias.app_id, app_id),
      eq(channelAlias.id, channelId),
    ))
    .groupBy(channelAlias.id, versionAlias.id)
    .limit(1)
  cloudlog({ requestId: c.get('requestId'), message: 'channel self override Query:', channelSelfOverrideQuery: channel.toSQL() })

  return channel.then(data => data.at(0))
}

export function requestInfosChannelPostgres(
  c: Context,
  platform: string,
  app_id: string,
  defaultChannel: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  includeManifest: boolean,
  includeMetadata = false,
) {
  const { versionSelect, channelAlias, channelSelect, manifestSelect, versionAlias } = getSchemaUpdatesAlias(includeMetadata)
  let platformQuery = channelAlias.ios
  if (platform === 'android')
    platformQuery = channelAlias.android
  else if (platform === 'electron')
    platformQuery = channelAlias.electron
  const baseSelect = {
    version: versionSelect,
    channels: channelSelect,
  }
  const selectShape = withOptionalManifestSelect(baseSelect, includeManifest, manifestSelect)

  const baseQuery = drizzleClient
    .select(selectShape)
    .from(channelAlias)
    .leftJoin(versionAlias, activeChannelVersionJoin(channelAlias.version, versionAlias))

  const channelQuery = (includeManifest
    ? baseQuery.leftJoin(schema.manifest, eq(schema.manifest.app_version_id, versionAlias.id))
    : baseQuery)
    .where(and(
      defaultChannel
        ? and(
            eq(channelAlias.app_id, app_id),
            eq(channelAlias.name, defaultChannel),
            eq(platformQuery, true),
            or(
              eq(channelAlias.public, true),
              eq(channelAlias.allow_device_self_set, true),
            ),
          )
        : and(
            eq(channelAlias.public, true),
            eq(channelAlias.app_id, app_id),
            eq(platformQuery, true),
          ),
      or(isNull(channelAlias.version), isNotNull(versionAlias.id)),
    ))
    .groupBy(channelAlias.id, versionAlias.id)
    .orderBy(channelAlias.name, channelAlias.id)
    .limit(1)
  cloudlog({ requestId: c.get('requestId'), message: 'channel Query:', channelQuery: channelQuery.toSQL() })
  const channel = channelQuery.then(data => data.at(0))

  return channel
}

export function requestManifestEntriesPostgres(
  c: Context,
  versionId: number,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
) {
  const manifestQuery = drizzleClient
    .select({
      file_name: schema.manifest.file_name,
      file_hash: schema.manifest.file_hash,
      s3_path: schema.manifest.s3_path,
    })
    .from(schema.manifest)
    .where(eq(schema.manifest.app_version_id, versionId))

  cloudlog({ requestId: c.get('requestId'), message: 'rollout manifest Query:', manifestQuery: manifestQuery.toSQL() })
  return manifestQuery
}

export function requestInfosChannelByIdPostgresRollout(
  c: Context,
  app_id: string,
  channelId: number,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  includeMetadata = false,
) {
  const { versionSelect, rolloutVersionSelect, channelAlias, channelSelect, versionAlias, rolloutVersionAlias } = getSchemaUpdatesAlias(includeMetadata)
  const channel = drizzleClient
    .select({
      version: versionSelect,
      rolloutVersion: rolloutVersionSelect,
      channels: channelSelect,
    })
    .from(channelAlias)
    .leftJoin(versionAlias, activeChannelVersionJoin(channelAlias.version, versionAlias))
    .leftJoin(rolloutVersionAlias, activeChannelVersionJoin(channelAlias.rollout_version, rolloutVersionAlias, channelAlias.app_id))
    .where(and(
      eq(channelAlias.app_id, app_id),
      eq(channelAlias.id, channelId),
      or(isNull(channelAlias.version), isNotNull(versionAlias.id)),
    ))
    .limit(1)

  cloudlog({ requestId: c.get('requestId'), message: 'channel self override rollout Query:', channelSelfOverrideQuery: channel.toSQL() })
  return channel.then(data => data.at(0))
}

export function requestInfosChannelDevicePostgresRollout(
  c: Context,
  app_id: string,
  device_id: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  includeMetadata = false,
) {
  const { versionSelect, rolloutVersionSelect, channelDevicesAlias, channelAlias, channelSelect, versionAlias, rolloutVersionAlias } = getSchemaUpdatesAlias(includeMetadata)
  const channelDevice = drizzleClient
    .select({
      version: versionSelect,
      rolloutVersion: rolloutVersionSelect,
      channels: channelSelect,
    })
    .from(channelDevicesAlias)
    .innerJoin(channelAlias, eq(channelDevicesAlias.channel_id, channelAlias.id))
    .leftJoin(versionAlias, activeChannelVersionJoin(channelAlias.version, versionAlias))
    .leftJoin(rolloutVersionAlias, activeChannelVersionJoin(channelAlias.rollout_version, rolloutVersionAlias, channelAlias.app_id))
    .where(and(
      eq(channelDevicesAlias.device_id, device_id),
      eq(channelDevicesAlias.app_id, app_id),
      or(isNull(channelAlias.version), isNotNull(versionAlias.id)),
    ))
    .limit(1)

  cloudlog({ requestId: c.get('requestId'), message: 'channelDevice rollout Query:', channelDeviceQuery: channelDevice.toSQL() })
  return channelDevice.then(data => data.at(0))
}

export function requestInfosChannelPostgresRollout(
  c: Context,
  platform: string,
  app_id: string,
  defaultChannel: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  includeMetadata = false,
) {
  const { versionSelect, rolloutVersionSelect, channelAlias, channelSelect, versionAlias, rolloutVersionAlias } = getSchemaUpdatesAlias(includeMetadata)
  const platformQuery = platform === 'android' ? channelAlias.android : platform === 'electron' ? channelAlias.electron : channelAlias.ios

  const channelFilter = defaultChannel
    ? and(
        eq(channelAlias.app_id, app_id),
        eq(channelAlias.name, defaultChannel),
        eq(platformQuery, true),
        or(
          eq(channelAlias.public, true),
          eq(channelAlias.allow_device_self_set, true),
        ),
      )
    : and(
        eq(channelAlias.public, true),
        eq(channelAlias.app_id, app_id),
        eq(platformQuery, true),
      )

  const channelQuery = drizzleClient
    .select({
      version: versionSelect,
      rolloutVersion: rolloutVersionSelect,
      channels: channelSelect,
    })
    .from(channelAlias)
    .leftJoin(versionAlias, activeChannelVersionJoin(channelAlias.version, versionAlias))
    .leftJoin(rolloutVersionAlias, activeChannelVersionJoin(channelAlias.rollout_version, rolloutVersionAlias, channelAlias.app_id))
    .where(and(
      channelFilter,
      or(isNull(channelAlias.version), isNotNull(versionAlias.id)),
    ))
    .orderBy(channelAlias.name, channelAlias.id)
    .limit(1)

  cloudlog({ requestId: c.get('requestId'), message: 'channel rollout Query:', channelQuery: channelQuery.toSQL() })
  return channelQuery.then(data => data.at(0))
}

async function resolveRolloutChannelDataPostgres(
  c: Context,
  channelData: any,
  appId: string,
  deviceId: string,
  currentVersionName: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  includeManifest: boolean,
) {
  if (!channelData)
    return channelData

  const stableVersion = channelData.version
  const rolloutVersion = channelData.rolloutVersion
  let selectedVersion = stableVersion

  if (rolloutVersion?.id && channelData.channels?.rollout_version) {
    const decision = await getRolloutDecision(c, {
      appId,
      channelId: channelData.channels.id,
      currentVersionName,
      deviceId,
      rolloutCacheTtlSeconds: channelData.channels.rollout_cache_ttl_seconds,
      rolloutEnabled: channelData.channels.rollout_enabled,
      rolloutId: channelData.channels.rollout_id,
      rolloutPausedAt: channelData.channels.rollout_paused_at,
      rolloutPercentageBps: channelData.channels.rollout_percentage_bps,
      rolloutVersionId: rolloutVersion.id,
      rolloutVersionName: rolloutVersion.name,
    })

    if (decision.selected)
      selectedVersion = rolloutVersion

    cloudlog({ requestId: c.get('requestId'), message: 'rollout decision', appId, channelId: channelData.channels.id, selected: decision.selected, reason: decision.reason })
  }

  const manifestEntries = includeManifest && selectedVersion?.manifest_count > 0
    ? await requestManifestEntriesPostgres(c, selectedVersion.id, drizzleClient)
    : []

  return {
    ...channelData,
    version: selectedVersion,
    manifestEntries,
  }
}

interface RequestInfosPostgresOptions {
  c: Context
  platform: string
  app_id: string
  device_id: string
  defaultChannel: string
  drizzleClient: ReturnType<typeof getDrizzleClient>
  channelDeviceCount?: number | null
  manifestBundleCount?: number | null
  rolloutChannelCount?: number | null
  rolloutPausedVersionNames?: string[] | null
  currentVersionName: string
  includeMetadata?: boolean
  channelSelfOverrideChannelId?: number | null
}

export function requestInfosPostgres(options: RequestInfosPostgresOptions) {
  const {
    c,
    platform,
    app_id,
    device_id,
    defaultChannel,
    drizzleClient,
    channelDeviceCount,
    manifestBundleCount,
    rolloutChannelCount,
    rolloutPausedVersionNames,
    currentVersionName,
    includeMetadata = false,
    channelSelfOverrideChannelId,
  } = options
  const shouldQueryChannelOverride = channelDeviceCount === undefined || channelDeviceCount === null ? true : channelDeviceCount > 0
  const shouldFetchManifest = manifestBundleCount === undefined || manifestBundleCount === null ? true : manifestBundleCount > 0
  const isPausedRolloutVersion = Array.isArray(rolloutPausedVersionNames) && rolloutPausedVersionNames.includes(currentVersionName)
  const shouldUseRolloutPath = (rolloutChannelCount ?? 0) > 0 || isPausedRolloutVersion

  if (!shouldUseRolloutPath) {
    let channelDevice: ReturnType<typeof requestInfosChannelByIdPostgres> | ReturnType<typeof requestInfosChannelDevicePostgres> | Promise<null>

    if (typeof channelSelfOverrideChannelId === 'number') {
      channelDevice = requestInfosChannelByIdPostgres(c, app_id, channelSelfOverrideChannelId, drizzleClient, shouldFetchManifest, includeMetadata)
    }
    else if (shouldQueryChannelOverride) {
      channelDevice = requestInfosChannelDevicePostgres(c, app_id, device_id, drizzleClient, shouldFetchManifest, includeMetadata)
    }
    else {
      cloudlog({ requestId: c.get('requestId'), message: 'Skipping channel device override query' })
      channelDevice = Promise.resolve(null)
    }
    const channel = requestInfosChannelPostgres(c, platform, app_id, defaultChannel, drizzleClient, shouldFetchManifest, includeMetadata)

    return Promise.all([channelDevice, channel])
      .then(([channelOverride, channelData]) => ({ channelData, channelOverride }))
      .catch((e) => {
        logPgError(c, 'requestInfosPostgres', e)
        throw e
      })
  }

  let channelDevice: ReturnType<typeof requestInfosChannelByIdPostgresRollout> | ReturnType<typeof requestInfosChannelDevicePostgresRollout> | Promise<null>
  if (typeof channelSelfOverrideChannelId === 'number') {
    channelDevice = requestInfosChannelByIdPostgresRollout(c, app_id, channelSelfOverrideChannelId, drizzleClient, includeMetadata)
  }
  else if (shouldQueryChannelOverride) {
    channelDevice = requestInfosChannelDevicePostgresRollout(c, app_id, device_id, drizzleClient, includeMetadata)
  }
  else {
    cloudlog({ requestId: c.get('requestId'), message: 'Skipping channel device override rollout query' })
    channelDevice = Promise.resolve(null)
  }
  const channel = requestInfosChannelPostgresRollout(c, platform, app_id, defaultChannel, drizzleClient, includeMetadata)

  return Promise.all([channelDevice, channel])
    .then(async ([channelOverride, channelData]) => {
      const resolvedChannelOverride = await resolveRolloutChannelDataPostgres(c, channelOverride, app_id, device_id, currentVersionName, drizzleClient, shouldFetchManifest)
      const resolvedChannelData = resolvedChannelOverride
        ? channelData
        : await resolveRolloutChannelDataPostgres(c, channelData, app_id, device_id, currentVersionName, drizzleClient, shouldFetchManifest)
      return { channelOverride: resolvedChannelOverride, channelData: resolvedChannelData }
    })
    .catch((e) => {
      logPgError(c, 'requestInfosPostgres', e)
      throw e
    })
}

export interface AppOwnerPostgresResult {
  owner_org: string
  orgs: { created_by: string, id: string, management_email: string }
  plan_valid: boolean
  channel_device_count: number
  manifest_bundle_count: number
  rollout_channel_count: number
  rollout_paused_version_names: string[]
  expose_metadata: boolean
  allow_device_custom_id: boolean
  block_provider_infra_requests: boolean
}

export async function getAppOwnerPostgres(
  c: Context,
  appId: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  actions: PlanAction[] = [],
): Promise<AppOwnerPostgresResult | null> {
  try {
    if (actions.length === 0)
      return null
    const orgAlias = alias(schema.orgs, 'orgs')
    const planExpression = buildPlanValidationExpression(actions, schema.apps.owner_org)

    const appOwner = await drizzleClient
      .select({
        owner_org: schema.apps.owner_org,
        plan_valid: planExpression,
        channel_device_count: schema.apps.channel_device_count,
        manifest_bundle_count: schema.apps.manifest_bundle_count,
        rollout_channel_count: schema.apps.rollout_channel_count,
        rollout_paused_version_names: schema.apps.rollout_paused_version_names,
        expose_metadata: schema.apps.expose_metadata,
        allow_device_custom_id: schema.apps.allow_device_custom_id,
        block_provider_infra_requests: schema.apps.block_provider_infra_requests,
        orgs: {
          created_by: orgAlias.created_by,
          id: orgAlias.id,
          management_email: orgAlias.management_email,
        },
      })
      .from(schema.apps)
      .where(eq(schema.apps.app_id, appId))
      .leftJoin(orgAlias, eq(schema.apps.owner_org, orgAlias.id))
      .limit(1)
      .then(data => data[0])

    if (!appOwner)
      return null

    if (!appOwner.orgs?.id || !appOwner.orgs.created_by || !appOwner.orgs.management_email) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'App owner org missing on read replica; preserving cloud app classification from apps row',
        appId,
        ownerOrg: appOwner.owner_org,
      })
      return {
        ...appOwner,
        orgs: {
          created_by: appOwner.orgs?.created_by ?? '',
          id: appOwner.owner_org,
          management_email: appOwner.orgs?.management_email ?? '',
        },
      }
    }

    return appOwner as AppOwnerPostgresResult
  }
  catch (e: unknown) {
    logPgError(c, 'getAppOwnerPostgres', e)
    return null
  }
}

export type AppBlockProviderInfraRequestsLookup =
  | { status: 'found', blockProviderInfraRequests: boolean }
  | { status: 'missing' }
  | { status: 'error' }

export async function getAppBlockProviderInfraRequestsPostgres(
  c: Context,
  appId: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<AppBlockProviderInfraRequestsLookup> {
  try {
    const app = await drizzleClient
      .select({
        block_provider_infra_requests: schema.apps.block_provider_infra_requests,
      })
      .from(schema.apps)
      .where(eq(schema.apps.app_id, appId))
      .limit(1)
      .then(data => data[0])

    if (!app)
      return { status: 'missing' }

    return { status: 'found', blockProviderInfraRequests: app.block_provider_infra_requests }
  }
  catch (e: unknown) {
    logPgError(c, 'getAppBlockProviderInfraRequestsPostgres', e)
    return { status: 'error' }
  }
}

export async function getAppVersionPostgres(
  c: Context,
  appId: string,
  versionName: string,
  allowedDeleted: boolean | undefined,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<{ id: number, owner_org: string } | null> {
  try {
    const deletedConditions: ReturnType<typeof eq>[] = []
    if (allowedDeleted !== undefined)
      deletedConditions.push(eq(schema.app_versions.deleted, allowedDeleted))

    const appVersion = await drizzleClient
      .select({
        id: schema.app_versions.id,
        owner_org: schema.app_versions.owner_org,
      })
      .from(schema.app_versions)
      .where(and(
        eq(schema.app_versions.app_id, appId),
        eq(schema.app_versions.name, versionName),
        ...deletedConditions,
      ))
      .limit(1)
      .then(data => data[0])
    return appVersion
  }
  catch (e: unknown) {
    logPgError(c, 'getAppVersionPostgres', e)
    return null
  }
}

export async function getAppVersionsByAppIdPg(
  c: Context,
  appId: string,
  versionName: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  actions: PlanAction[] = [],
): Promise<{ id: number, owner_org: string, name: string, plan_valid: boolean }[]> {
  try {
    if (actions.length === 0)
      return []
    const planExpression = buildPlanValidationExpression(actions, schema.app_versions.owner_org)
    const versions = await drizzleClient
      .select({
        id: schema.app_versions.id,
        owner_org: schema.app_versions.owner_org,
        name: schema.app_versions.name,
        plan_valid: planExpression,
      })
      .from(schema.app_versions)
      .where(and(
        eq(schema.app_versions.app_id, appId),
        or(eq(schema.app_versions.name, versionName), eq(schema.app_versions.name, 'builtin')),
      ))
      .limit(2)
    return versions
  }
  catch (e: unknown) {
    logPgError(c, 'getAppVersionsByAppIdPg', e)
    return []
  }
}

export async function getChannelDeviceOverridePg(
  c: Context,
  appId: string,
  deviceId: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<{ app_id: string, device_id: string, channel_id: { id: number, allow_device_self_set: boolean, name: string } } | null> {
  try {
    const result = await drizzleClient
      .select({
        app_id: schema.channel_devices.app_id,
        device_id: schema.channel_devices.device_id,
        channel_id: schema.channels.id,
        allow_device_self_set: schema.channels.allow_device_self_set,
        name: schema.channels.name,
      })
      .from(schema.channel_devices)
      .leftJoin(schema.channels, eq(schema.channel_devices.channel_id, schema.channels.id))
      .where(and(
        eq(schema.channel_devices.app_id, appId),
        eq(schema.channel_devices.device_id, deviceId),
      ))
      .limit(1)
      .then(data => data[0])

    if (!result)
      return null

    // If channel_devices exists but channel doesn't, return null (orphaned record)
    if (!result.channel_id || result.allow_device_self_set === null || !result.name)
      return null

    return {
      app_id: result.app_id,
      device_id: result.device_id,
      channel_id: {
        id: result.channel_id,
        allow_device_self_set: result.allow_device_self_set!,
        name: result.name,
      },
    }
  }
  catch (e: unknown) {
    logPgError(c, 'getChannelDeviceOverridePg', e)
    return null
  }
}

async function getChannelByPg(
  c: Context,
  appId: string,
  channelFilter: SQL,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  logName: string,
): Promise<ChannelLookupResult | null> {
  try {
    return await drizzleClient
      .select({
        id: schema.channels.id,
        name: schema.channels.name,
        allow_device_self_set: schema.channels.allow_device_self_set,
        public: schema.channels.public,
        owner_org: schema.channels.owner_org,
      })
      .from(schema.channels)
      .where(and(
        eq(schema.channels.app_id, appId),
        channelFilter,
      ))
      .limit(1)
      .then(data => data[0])
  }
  catch (e: unknown) {
    logPgError(c, logName, e)
    return null
  }
}

export async function getChannelByNamePg(
  c: Context,
  appId: string,
  channelName: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<ChannelLookupResult | null> {
  return getChannelByPg(c, appId, eq(schema.channels.name, channelName), drizzleClient, 'getChannelByNamePg')
}

export async function getChannelByIdPg(
  c: Context,
  appId: string,
  channelId: number,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<ChannelLookupResult | null> {
  return getChannelByPg(c, appId, eq(schema.channels.id, channelId), drizzleClient, 'getChannelByIdPg')
}

export async function getMainChannelsPg(
  c: Context,
  appId: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<{ name: string, ios: boolean, android: boolean, electron: boolean }[]> {
  try {
    const channels = await drizzleClient
      .select({
        name: schema.channels.name,
        ios: schema.channels.ios,
        android: schema.channels.android,
        electron: schema.channels.electron,
      })
      .from(schema.channels)
      .where(and(
        eq(schema.channels.app_id, appId),
        eq(schema.channels.public, true),
      ))
    return channels
  }
  catch (e: unknown) {
    logPgError(c, 'getMainChannelsPg', e)
    return []
  }
}

export async function deleteChannelDevicePg(
  c: Context,
  appId: string,
  deviceId: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<boolean> {
  try {
    await drizzleClient
      .delete(schema.channel_devices)
      .where(and(
        eq(schema.channel_devices.app_id, appId),
        eq(schema.channel_devices.device_id, deviceId),
      ))
    return true
  }
  catch (e: unknown) {
    logPgError(c, 'deleteChannelDevicePg', e)
    return false
  }
}

export async function upsertChannelDevicePg(
  c: Context,
  data: { device_id: string, channel_id: number, app_id: string, owner_org: string },
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<boolean> {
  try {
    await drizzleClient
      .insert(schema.channel_devices)
      .values({
        device_id: data.device_id,
        channel_id: data.channel_id,
        app_id: data.app_id,
        owner_org: data.owner_org,
      })
      .onConflictDoUpdate({
        target: [schema.channel_devices.device_id, schema.channel_devices.app_id],
        set: {
          channel_id: data.channel_id,
          updated_at: new Date(),
        },
      })
    return true
  }
  catch (e: unknown) {
    logPgError(c, 'upsertChannelDevicePg', e)
    return false
  }
}

export async function getChannelsPg(
  c: Context,
  appId: string,
  condition: { defaultChannel?: string } | { public: boolean },
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<{ id: number, name: string, ios: boolean, android: boolean, electron: boolean, public: boolean }[]> {
  try {
    const whereConditions = [eq(schema.channels.app_id, appId)]

    if ('defaultChannel' in condition && condition.defaultChannel) {
      whereConditions.push(eq(schema.channels.name, condition.defaultChannel))
    }
    else if ('public' in condition) {
      whereConditions.push(eq(schema.channels.public, condition.public))
    }

    const channels = await drizzleClient
      .select({
        id: schema.channels.id,
        name: schema.channels.name,
        ios: schema.channels.ios,
        android: schema.channels.android,
        electron: schema.channels.electron,
        public: schema.channels.public,
      })
      .from(schema.channels)
      .where(and(...whereConditions))
    return channels
  }
  catch (e: unknown) {
    logPgError(c, 'getChannelsPg', e)
    return []
  }
}

export async function getAppByIdPg(
  c: Context,
  appId: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  actions: PlanAction[] = [],
): Promise<{ owner_org: string, plan_valid: boolean } | null> {
  try {
    if (actions.length === 0)
      return null
    const planExpression = buildPlanValidationExpression(actions, schema.apps.owner_org)
    const app = await drizzleClient
      .select({
        owner_org: schema.apps.owner_org,
        plan_valid: planExpression,
      })
      .from(schema.apps)
      .where(eq(schema.apps.app_id, appId))
      .limit(1)
      .then(data => data[0])
    return app
  }
  catch (e: unknown) {
    logPgError(c, 'getAppByIdPg', e)
    return null
  }
}

export async function getCompatibleChannelsPg(
  c: Context,
  appId: string,
  platform: 'ios' | 'android' | 'electron',
  isEmulator: boolean,
  isProd: boolean,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<{ id: number, name: string, allow_device_self_set: boolean, allow_emulator: boolean, allow_device: boolean, allow_dev: boolean, allow_prod: boolean, ios: boolean, android: boolean, electron: boolean, public: boolean }[]> {
  try {
    const deviceCondition = isEmulator
      ? eq(schema.channels.allow_emulator, true)
      : eq(schema.channels.allow_device, true)
    const buildCondition = isProd
      ? eq(schema.channels.allow_prod, true)
      : eq(schema.channels.allow_dev, true)
    let platformColumn = schema.channels.android
    if (platform === 'ios')
      platformColumn = schema.channels.ios
    else if (platform === 'electron')
      platformColumn = schema.channels.electron
    const channels = await drizzleClient
      .select({
        id: schema.channels.id,
        name: schema.channels.name,
        allow_device_self_set: schema.channels.allow_device_self_set,
        allow_emulator: schema.channels.allow_emulator,
        allow_device: schema.channels.allow_device,
        allow_dev: schema.channels.allow_dev,
        allow_prod: schema.channels.allow_prod,
        ios: schema.channels.ios,
        android: schema.channels.android,
        electron: schema.channels.electron,
        public: schema.channels.public,
      })
      .from(schema.channels)
      .where(and(
        eq(schema.channels.app_id, appId),
        or(eq(schema.channels.allow_device_self_set, true), eq(schema.channels.public, true)),
        deviceCondition,
        buildCondition,
        eq(platformColumn, true),
      ))
    return channels
  }
  catch (e: unknown) {
    logPgError(c, 'getCompatibleChannelsPg', e)
    return []
  }
}

// Admin Deployments Trend (from Supabase channel_devices table)
export interface AdminDeploymentsTrend {
  date: string
  deployments: number
}

export async function getAdminDeploymentsTrend(
  c: Context,
  start_date: string,
  end_date: string,
  app_id?: string,
): Promise<AdminDeploymentsTrend[]> {
  try {
    const pgClient = getPgClient(c, true) // Read-only query
    const drizzleClient = getDrizzleClient(pgClient)

    const appFilter = app_id ? sql`AND app_id = ${app_id}` : sql``

    const query = sql`
      SELECT
        DATE(created_at) AS date,
        COUNT(*)::int AS deployments
      FROM channel_devices
      WHERE created_at >= ${start_date}::timestamp
        AND created_at < ${end_date}::timestamp
        ${appFilter}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `

    const result = await drizzleClient.execute(query)

    const data: AdminDeploymentsTrend[] = result.rows.map((row: any) => ({
      date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date,
      deployments: Number(row.deployments),
    }))

    cloudlog({ requestId: c.get('requestId'), message: 'getAdminDeploymentsTrend result', resultCount: data.length })

    return data
  }
  catch (e: unknown) {
    logPgError(c, 'getAdminDeploymentsTrend', e)
    return []
  }
}

// Admin Global Stats Trend (from Supabase global_stats table)
export interface AdminGlobalStatsTrend {
  date: string
  apps: number
  apps_created: number
  apps_with_cli_onboarding_builds_24h: number
  apps_with_manual_builds_24h: number
  app_build_onboarding_finalized: boolean
  apps_active: number
  users: number
  users_active: number
  paying: number
  org_conversion_rate: number
  plan_total_conversion_rate: number
  plan_solo_conversion_rate: number
  plan_maker_conversion_rate: number
  plan_team_conversion_rate: number
  plan_enterprise_conversion_rate: number
  trial: number
  not_paying: number
  updates: number
  updates_external: number
  success_rate: number
  bundle_storage_gb: number
  plan_solo: number
  plan_maker: number
  plan_team: number
  plan_enterprise: number
  registers_today: number
  demo_apps_created: number
  devices_last_month: number
  devices_last_month_ios: number
  devices_last_month_android: number
  stars: number
  need_upgrade: number
  above_plan_with_credits: number | null
  above_plan_without_credits: number | null
  paying_yearly: number
  paying_monthly: number
  new_paying_orgs: number
  canceled_orgs: number
  upgraded_orgs: number
  upgrade_rate_12m: number
  trial_extended_orgs: number
  trial_extended_subscribed_orgs: number
  past_due_orgs: number
  past_due_orgs_average_days: number
  active_canceled_orgs: number
  active_past_due_orgs: number
  mrr: number
  previous_mrr: number
  previous_mrr_solo: number
  previous_mrr_maker: number
  previous_mrr_team: number
  previous_mrr_enterprise: number
  nrr: number
  churn_revenue: number
  churn_revenue_solo: number
  churn_revenue_maker: number
  churn_revenue_team: number
  churn_revenue_enterprise: number
  total_revenue: number
  revenue_solo: number
  revenue_maker: number
  revenue_team: number
  revenue_enterprise: number
  average_ltv: number
  shortest_ltv: number
  longest_ltv: number
  credits_bought: number
  credits_consumed: number
  builds_total: number
  builds_ios: number
  builds_android: number
  builds_success_total: number
  builds_success_ios: number
  builds_success_android: number
  builds_last_month: number
  builds_last_month_ios: number
  builds_last_month_android: number
  build_minutes_day_ios: number
  build_minutes_day_android: number
  builds_day_ios: number
  builds_day_android: number
  build_total_seconds_day_ios: number
  build_total_seconds_day_android: number
  build_avg_seconds_day_ios: number
  build_avg_seconds_day_android: number
  build_count_day_ios: number
  build_count_day_android: number
  builder_active_paying_clients_60d: number
  live_updates_active_paying_clients_60d: number
  paying_orgs_subscription: number
  paying_orgs_credits: number
  paying_orgs_total: number
}

export async function getAdminGlobalStatsTrend(
  c: Context,
  start_date: string,
  end_date: string,
): Promise<AdminGlobalStatsTrend[]> {
  try {
    // Admin global stats are low traffic and depend on recently migrated
    // global_stats columns. Use primary DB so replica schema/data drift does not
    // silently blank the dashboard.
    const pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)

    // Extract just the date portion (YYYY-MM-DD) from ISO timestamps
    const startDateOnly = start_date.split('T')[0]
    const endDateOnly = end_date.split('T')[0]
    const requiredCompletedShardsJson = JSON.stringify(REQUIRED_GLOBAL_STATS_SHARDS)

    // Keep in-progress placeholder snapshots hidden until all core shards complete.
    const query = sql`
      WITH completed_stats AS (
        SELECT *
        FROM global_stats
        WHERE completed_shards @> ${requiredCompletedShardsJson}::jsonb
      ),
      core_completed_stats AS (
        SELECT date_id
        FROM global_stats
        WHERE completed_shards @> '["core"]'::jsonb
      ),
      stats AS (
        SELECT
        gs.date_id AS date,
        gs.apps::int AS apps,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'apps_created', '')::int, 0)::int AS apps_created,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'apps_with_cli_onboarding_builds_24h', '')::int, 0)::int AS apps_with_cli_onboarding_builds_24h,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'apps_with_manual_builds_24h', '')::int, 0)::int AS apps_with_manual_builds_24h,
        (onboarding_next.date_id IS NOT NULL)::boolean AS app_build_onboarding_finalized,
        gs.apps_active::int AS apps_active,
        gs.users::int AS users,
        gs.users_active::int AS users_active,
        gs.paying::int AS paying,
        gs.org_conversion_rate::float AS org_conversion_rate,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'plan_total_conversion_rate', '')::float, 0)::float AS plan_total_conversion_rate,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'plan_solo_conversion_rate', '')::float, 0)::float AS plan_solo_conversion_rate,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'plan_maker_conversion_rate', '')::float, 0)::float AS plan_maker_conversion_rate,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'plan_team_conversion_rate', '')::float, 0)::float AS plan_team_conversion_rate,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'plan_enterprise_conversion_rate', '')::float, 0)::float AS plan_enterprise_conversion_rate,
        gs.trial::int AS trial,
        gs.not_paying::int AS not_paying,
        gs.updates::int AS updates,
        gs.updates_external::int AS updates_external,
        gs.success_rate::float AS success_rate,
        gs.bundle_storage_gb::float AS bundle_storage_gb,
        gs.plan_solo::int AS plan_solo,
        gs.plan_maker::int AS plan_maker,
        gs.plan_team::int AS plan_team,
        gs.plan_enterprise::int AS plan_enterprise,
        gs.registers_today::int AS registers_today,
        COALESCE(gs.demo_apps_created, 0)::int AS demo_apps_created,
        gs.devices_last_month::int AS devices_last_month,
        COALESCE(gs.devices_last_month_ios, 0)::int AS devices_last_month_ios,
        COALESCE(gs.devices_last_month_android, 0)::int AS devices_last_month_android,
        gs.stars::int AS stars,
        gs.need_upgrade::int AS need_upgrade,
        NULLIF(to_jsonb(gs) ->> 'above_plan_with_credits', '')::int AS above_plan_with_credits,
        NULLIF(to_jsonb(gs) ->> 'above_plan_without_credits', '')::int AS above_plan_without_credits,
        gs.paying_yearly::int AS paying_yearly,
        gs.paying_monthly::int AS paying_monthly,
        gs.new_paying_orgs::int AS new_paying_orgs,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'past_due_orgs', '')::int, 0)::int AS past_due_orgs,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'past_due_orgs_average_days', '')::float, 0)::float AS past_due_orgs_average_days,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'active_canceled_orgs', '')::int, 0)::int AS active_canceled_orgs,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'active_past_due_orgs', '')::int, 0)::int AS active_past_due_orgs,
        gs.canceled_orgs::int AS canceled_orgs,
        COALESCE(gs.upgraded_orgs, 0)::int AS upgraded_orgs,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'upgrade_rate_12m', '')::float, 0)::float AS upgrade_rate_12m,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'trial_extended_orgs', '')::int, 0)::int AS trial_extended_orgs,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'trial_extended_subscribed_orgs', '')::int, 0)::int AS trial_extended_subscribed_orgs,
        gs.mrr::float AS mrr,
        COALESCE(prev.mrr, 0)::float AS previous_mrr,
        (COALESCE(prev.revenue_solo, 0)::float / 12)::float AS previous_mrr_solo,
        (COALESCE(prev.revenue_maker, 0)::float / 12)::float AS previous_mrr_maker,
        (COALESCE(prev.revenue_team, 0)::float / 12)::float AS previous_mrr_team,
        (COALESCE(prev.revenue_enterprise, 0)::float / 12)::float AS previous_mrr_enterprise,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'nrr', '')::float, 100)::float AS nrr,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'churn_revenue', '')::float, 0)::float AS churn_revenue,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'churn_revenue_solo', '')::float, 0)::float AS churn_revenue_solo,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'churn_revenue_maker', '')::float, 0)::float AS churn_revenue_maker,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'churn_revenue_team', '')::float, 0)::float AS churn_revenue_team,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'churn_revenue_enterprise', '')::float, 0)::float AS churn_revenue_enterprise,
        gs.total_revenue::float AS total_revenue,
        gs.revenue_solo::float AS revenue_solo,
        gs.revenue_maker::float AS revenue_maker,
        gs.revenue_team::float AS revenue_team,
        gs.revenue_enterprise::float AS revenue_enterprise,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'average_ltv', '')::float, 0)::float AS average_ltv,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'shortest_ltv', '')::float, 0)::float AS shortest_ltv,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'longest_ltv', '')::float, 0)::float AS longest_ltv,
        COALESCE(gs.credits_bought, 0)::float AS credits_bought,
        COALESCE(gs.credits_consumed, 0)::float AS credits_consumed,
        COALESCE(gs.builds_total, 0)::int AS builds_total,
        COALESCE(gs.builds_ios, 0)::int AS builds_ios,
        COALESCE(gs.builds_android, 0)::int AS builds_android,
        COALESCE(gs.builds_success_total, 0)::int AS builds_success_total,
        COALESCE(gs.builds_success_ios, 0)::int AS builds_success_ios,
        COALESCE(gs.builds_success_android, 0)::int AS builds_success_android,
        COALESCE(gs.builds_last_month, 0)::int AS builds_last_month,
        COALESCE(gs.builds_last_month_ios, 0)::int AS builds_last_month_ios,
        COALESCE(gs.builds_last_month_android, 0)::int AS builds_last_month_android,
        COALESCE(
          NULLIF(to_jsonb(gs) ->> 'build_minutes_day_ios', '')::float,
          COALESCE(NULLIF(to_jsonb(gs) ->> 'build_total_seconds_day_ios', '')::bigint, 0)::float / 60,
          0
        )::float AS build_minutes_day_ios,
        COALESCE(
          NULLIF(to_jsonb(gs) ->> 'build_minutes_day_android', '')::float,
          COALESCE(NULLIF(to_jsonb(gs) ->> 'build_total_seconds_day_android', '')::bigint, 0)::float / 60,
          0
        )::float AS build_minutes_day_android,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'builds_day_ios', '')::int, NULLIF(to_jsonb(gs) ->> 'build_count_day_ios', '')::int, 0)::int AS builds_day_ios,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'builds_day_android', '')::int, NULLIF(to_jsonb(gs) ->> 'build_count_day_android', '')::int, 0)::int AS builds_day_android,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'build_total_seconds_day_ios', '')::bigint, ROUND(COALESCE(NULLIF(to_jsonb(gs) ->> 'build_minutes_day_ios', '')::float, 0) * 60)::bigint, 0)::bigint AS build_total_seconds_day_ios,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'build_total_seconds_day_android', '')::bigint, ROUND(COALESCE(NULLIF(to_jsonb(gs) ->> 'build_minutes_day_android', '')::float, 0) * 60)::bigint, 0)::bigint AS build_total_seconds_day_android,
        COALESCE(
          NULLIF(to_jsonb(gs) ->> 'build_avg_seconds_day_ios', '')::float,
          CASE
            WHEN COALESCE(NULLIF(to_jsonb(gs) ->> 'builds_day_ios', '')::int, 0) > 0
              THEN (COALESCE(NULLIF(to_jsonb(gs) ->> 'build_minutes_day_ios', '')::float, 0) * 60) / COALESCE(NULLIF(to_jsonb(gs) ->> 'builds_day_ios', '')::int, 0)
            ELSE 0
          END,
          0
        )::float AS build_avg_seconds_day_ios,
        COALESCE(
          NULLIF(to_jsonb(gs) ->> 'build_avg_seconds_day_android', '')::float,
          CASE
            WHEN COALESCE(NULLIF(to_jsonb(gs) ->> 'builds_day_android', '')::int, 0) > 0
              THEN (COALESCE(NULLIF(to_jsonb(gs) ->> 'build_minutes_day_android', '')::float, 0) * 60) / COALESCE(NULLIF(to_jsonb(gs) ->> 'builds_day_android', '')::int, 0)
            ELSE 0
          END,
          0
        )::float AS build_avg_seconds_day_android,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'build_count_day_ios', '')::int, NULLIF(to_jsonb(gs) ->> 'builds_day_ios', '')::int, 0)::int AS build_count_day_ios,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'build_count_day_android', '')::int, NULLIF(to_jsonb(gs) ->> 'builds_day_android', '')::int, 0)::int AS build_count_day_android,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'builder_active_paying_clients_60d', '')::int, 0)::int AS builder_active_paying_clients_60d,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'live_updates_active_paying_clients_60d', '')::int, 0)::int AS live_updates_active_paying_clients_60d,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'paying_orgs_subscription', '')::int, gs.paying::int, 0)::int AS paying_orgs_subscription,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'paying_orgs_credits', '')::int, 0)::int AS paying_orgs_credits,
        COALESCE(NULLIF(to_jsonb(gs) ->> 'paying_orgs_total', '')::int, gs.paying::int, 0)::int AS paying_orgs_total
      FROM completed_stats gs
      LEFT JOIN completed_stats prev ON prev.date_id = (
        CASE
          WHEN gs.date_id ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN
            CASE
              WHEN to_char(to_date(gs.date_id, 'YYYY-MM-DD'), 'YYYY-MM-DD') = gs.date_id
                THEN (to_date(gs.date_id, 'YYYY-MM-DD') - 1)::text
              ELSE NULL
            END
          ELSE NULL
        END
      )
      LEFT JOIN core_completed_stats onboarding_next ON onboarding_next.date_id = (
        CASE
          WHEN gs.date_id ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN
            CASE
              WHEN to_char(to_date(gs.date_id, 'YYYY-MM-DD'), 'YYYY-MM-DD') = gs.date_id
                THEN (to_date(gs.date_id, 'YYYY-MM-DD') + 1)::text
              ELSE NULL
            END
          ELSE NULL
        END
      )
      WHERE CASE
          WHEN gs.date_id ~ '^\\d{4}-\\d{2}-\\d{2}$'
            THEN to_char(to_date(gs.date_id, 'YYYY-MM-DD'), 'YYYY-MM-DD') = gs.date_id
          ELSE false
        END
        AND gs.date_id <= ${endDateOnly}
      )
      SELECT *
      FROM stats
      WHERE date >= ${startDateOnly}
      ORDER BY date ASC
    `

    const result = await drizzleClient.execute(query)
    const data: AdminGlobalStatsTrend[] = result.rows.map((row: any) => ({
      date: normalizeAdminStatsDate(row.date),
      apps: Number(row.apps) || 0,
      apps_created: Number(row.apps_created) || 0,
      apps_with_cli_onboarding_builds_24h: Number(row.apps_with_cli_onboarding_builds_24h) || 0,
      apps_with_manual_builds_24h: Number(row.apps_with_manual_builds_24h) || 0,
      app_build_onboarding_finalized: row.app_build_onboarding_finalized === true || row.app_build_onboarding_finalized === 'true',
      apps_active: Number(row.apps_active) || 0,
      users: Number(row.users) || 0,
      users_active: Number(row.users_active) || 0,
      paying: Number(row.paying) || 0,
      org_conversion_rate: Number(row.org_conversion_rate) || 0,
      plan_total_conversion_rate: Number(row.plan_total_conversion_rate) || 0,
      plan_solo_conversion_rate: Number(row.plan_solo_conversion_rate) || 0,
      plan_maker_conversion_rate: Number(row.plan_maker_conversion_rate) || 0,
      plan_team_conversion_rate: Number(row.plan_team_conversion_rate) || 0,
      plan_enterprise_conversion_rate: Number(row.plan_enterprise_conversion_rate) || 0,
      trial: Number(row.trial) || 0,
      not_paying: Number(row.not_paying) || 0,
      updates: Number(row.updates) || 0,
      updates_external: Number(row.updates_external) || 0,
      success_rate: Number(row.success_rate) || 0,
      bundle_storage_gb: Number(row.bundle_storage_gb) || 0,
      plan_solo: Number(row.plan_solo) || 0,
      plan_maker: Number(row.plan_maker) || 0,
      plan_team: Number(row.plan_team) || 0,
      plan_enterprise: Number(row.plan_enterprise) || 0,
      registers_today: Number(row.registers_today) || 0,
      demo_apps_created: Number(row.demo_apps_created) || 0,
      devices_last_month: Number(row.devices_last_month) || 0,
      devices_last_month_ios: Number(row.devices_last_month_ios) || 0,
      devices_last_month_android: Number(row.devices_last_month_android) || 0,
      stars: Number(row.stars) || 0,
      need_upgrade: Number(row.need_upgrade) || 0,
      above_plan_with_credits: row.above_plan_with_credits === null ? null : Number(row.above_plan_with_credits) || 0,
      above_plan_without_credits: row.above_plan_without_credits === null ? null : Number(row.above_plan_without_credits) || 0,
      paying_yearly: Number(row.paying_yearly) || 0,
      past_due_orgs: Number(row.past_due_orgs) || 0,
      past_due_orgs_average_days: Number(row.past_due_orgs_average_days) || 0,
      active_canceled_orgs: Number(row.active_canceled_orgs) || 0,
      active_past_due_orgs: Number(row.active_past_due_orgs) || 0,
      paying_monthly: Number(row.paying_monthly) || 0,
      new_paying_orgs: Number(row.new_paying_orgs) || 0,
      canceled_orgs: Number(row.canceled_orgs) || 0,
      upgraded_orgs: Number(row.upgraded_orgs) || 0,
      upgrade_rate_12m: Number(row.upgrade_rate_12m) || 0,
      trial_extended_orgs: Number(row.trial_extended_orgs) || 0,
      trial_extended_subscribed_orgs: Number(row.trial_extended_subscribed_orgs) || 0,
      mrr: Number(row.mrr) || 0,
      previous_mrr: Number(row.previous_mrr) || 0,
      previous_mrr_solo: Number(row.previous_mrr_solo) || 0,
      previous_mrr_maker: Number(row.previous_mrr_maker) || 0,
      previous_mrr_team: Number(row.previous_mrr_team) || 0,
      previous_mrr_enterprise: Number(row.previous_mrr_enterprise) || 0,
      nrr: Number(row.nrr) || 0,
      churn_revenue: Number(row.churn_revenue) || 0,
      churn_revenue_solo: Number(row.churn_revenue_solo) || 0,
      churn_revenue_maker: Number(row.churn_revenue_maker) || 0,
      churn_revenue_team: Number(row.churn_revenue_team) || 0,
      churn_revenue_enterprise: Number(row.churn_revenue_enterprise) || 0,
      total_revenue: Number(row.total_revenue) || 0,
      revenue_solo: Number(row.revenue_solo) || 0,
      revenue_maker: Number(row.revenue_maker) || 0,
      revenue_team: Number(row.revenue_team) || 0,
      revenue_enterprise: Number(row.revenue_enterprise) || 0,
      average_ltv: Number(row.average_ltv) || 0,
      shortest_ltv: Number(row.shortest_ltv) || 0,
      longest_ltv: Number(row.longest_ltv) || 0,
      credits_bought: Number(row.credits_bought) || 0,
      credits_consumed: Number(row.credits_consumed) || 0,
      builds_total: Number(row.builds_total) || 0,
      builds_ios: Number(row.builds_ios) || 0,
      builds_android: Number(row.builds_android) || 0,
      builds_success_total: Number(row.builds_success_total) || 0,
      builds_success_ios: Number(row.builds_success_ios) || 0,
      builds_success_android: Number(row.builds_success_android) || 0,
      builds_last_month: Number(row.builds_last_month) || 0,
      builds_last_month_ios: Number(row.builds_last_month_ios) || 0,
      builds_last_month_android: Number(row.builds_last_month_android) || 0,
      build_minutes_day_ios: Number(row.build_minutes_day_ios) || 0,
      build_minutes_day_android: Number(row.build_minutes_day_android) || 0,
      builds_day_ios: Number(row.builds_day_ios) || 0,
      builds_day_android: Number(row.builds_day_android) || 0,
      build_total_seconds_day_ios: Number(row.build_total_seconds_day_ios) || 0,
      build_total_seconds_day_android: Number(row.build_total_seconds_day_android) || 0,
      build_avg_seconds_day_ios: Number(row.build_avg_seconds_day_ios) || 0,
      build_avg_seconds_day_android: Number(row.build_avg_seconds_day_android) || 0,
      build_count_day_ios: Number(row.build_count_day_ios) || 0,
      build_count_day_android: Number(row.build_count_day_android) || 0,
      builder_active_paying_clients_60d: Number(row.builder_active_paying_clients_60d) || 0,
      live_updates_active_paying_clients_60d: Number(row.live_updates_active_paying_clients_60d) || 0,
      paying_orgs_subscription: Number(row.paying_orgs_subscription) || 0,
      paying_orgs_credits: Number(row.paying_orgs_credits) || 0,
      paying_orgs_total: Number(row.paying_orgs_total) || 0,
    }))

    if (data.length > 0) {
      const latestIndex = data.length - 1
      if (data[latestIndex].users <= 0) {
        const liveRegisteredUsers = await getLiveRegisteredUsersCount(c)
        if (liveRegisteredUsers > 0)
          data[latestIndex].users = liveRegisteredUsers
      }

      const livePayingBreakdown = await getAdminPayingOrgBreakdown(c)
      data[latestIndex] = {
        ...data[latestIndex],
        paying_orgs_subscription: livePayingBreakdown.paying_orgs_subscription || data[latestIndex].paying_orgs_subscription,
        paying_orgs_credits: livePayingBreakdown.paying_orgs_credits || data[latestIndex].paying_orgs_credits,
        paying_orgs_total: livePayingBreakdown.paying_orgs_total || data[latestIndex].paying_orgs_total,
      }
    }

    cloudlog({ requestId: c.get('requestId'), message: 'getAdminGlobalStatsTrend result', resultCount: data.length })

    return data
  }
  catch (e: unknown) {
    logPgError(c, 'getAdminGlobalStatsTrend', e)
    throw e
  }
}

export interface AdminEmailTypeBreakdown {
  totals: {
    professional: number
    personal: number
    disposable: number
    total: number
  }
  trend: Array<{
    date: string
    professional: number
    personal: number
    disposable: number
    total: number
  }>
}

interface AdminUtcDateRange {
  startDay: Date
  seriesEndDay: Date
  endExclusive: Date
}

export function normalizeAdminStatsDate(value: unknown): string {
  if (value instanceof Date)
    return value.toISOString().split('T')[0]

  const rawValue = String(value ?? '').trim()
  if (!rawValue)
    return ''

  if (/^\d{4}-\d{2}-\d{2}$/.test(rawValue))
    return rawValue

  const parsed = new Date(rawValue)
  if (!Number.isNaN(parsed.getTime()))
    return parsed.toISOString().split('T')[0]

  return rawValue.slice(0, 10)
}

async function getLiveRegisteredUsersCount(c: Context): Promise<number> {
  const pgClient = getPgClient(c)
  const drizzleClient = getDrizzleClient(pgClient)

  try {
    const result = await drizzleClient.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM public.users u
      WHERE u.created_via_invite = false
    `)

    return Number((result.rows[0] as { count?: number | string | null } | undefined)?.count) || 0
  }
  catch (error) {
    logPgError(c, 'getLiveRegisteredUsersCount', error)
    return 0
  }
  finally {
    await closeClient(c, pgClient)
  }
}

export interface AdminPayingOrgBreakdown {
  paying_orgs_subscription: number
  paying_orgs_credits: number
  paying_orgs_total: number
}

export async function getAdminPayingOrgBreakdown(c: Context): Promise<AdminPayingOrgBreakdown> {
  const emptyResult: AdminPayingOrgBreakdown = {
    paying_orgs_subscription: 0,
    paying_orgs_credits: 0,
    paying_orgs_total: 0,
  }

  const pgClient = getPgClient(c)
  const drizzleClient = getDrizzleClient(pgClient)

  try {
    const result = await drizzleClient.execute(sql`
      WITH active_subscriptions AS (
        SELECT DISTINCT ON (si.customer_id)
          si.customer_id
        FROM public.stripe_info si
        INNER JOIN public.plans p ON p.stripe_id = si.product_id
        WHERE si.is_good_plan = true
          AND si.status IN (
            'succeeded'::public.stripe_status,
            'canceled'::public.stripe_status,
            'deleted'::public.stripe_status
          )
          AND (si.canceled_at IS NULL OR si.canceled_at > NOW())
          AND si.subscription_anchor_end > NOW()
        ORDER BY si.customer_id, si.created_at DESC
      ),
      subscription_orgs AS (
        SELECT DISTINCT o.id AS org_id
        FROM public.orgs o
        INNER JOIN active_subscriptions active ON active.customer_id = o.customer_id
      ),
      credit_orgs AS (
        SELECT DISTINCT ucb.org_id
        FROM public.usage_credit_balances ucb
        WHERE COALESCE(ucb.available_credits, 0) > 0
      )
      SELECT
        (SELECT COUNT(*)::int FROM subscription_orgs) AS paying_orgs_subscription,
        (SELECT COUNT(*)::int FROM credit_orgs) AS paying_orgs_credits,
        (
          SELECT COUNT(*)::int
          FROM (
            SELECT org_id FROM subscription_orgs
            UNION
            SELECT org_id FROM credit_orgs
          ) paid_orgs
        ) AS paying_orgs_total
    `)

    const row = result.rows[0] as {
      paying_orgs_subscription?: number | string | null
      paying_orgs_credits?: number | string | null
      paying_orgs_total?: number | string | null
    } | undefined

    return {
      paying_orgs_subscription: Number(row?.paying_orgs_subscription) || 0,
      paying_orgs_credits: Number(row?.paying_orgs_credits) || 0,
      paying_orgs_total: Number(row?.paying_orgs_total) || 0,
    }
  }
  catch (error) {
    logPgError(c, 'getAdminPayingOrgBreakdown', error)
    return emptyResult
  }
  finally {
    await closeClient(c, pgClient)
  }
}

function getAdminUtcDateRange(start_date: string, end_date: string): AdminUtcDateRange {
  const startTimestamp = new Date(start_date)
  const endTimestamp = new Date(end_date)
  const startDay = new Date(Date.UTC(startTimestamp.getUTCFullYear(), startTimestamp.getUTCMonth(), startTimestamp.getUTCDate()))
  const endDay = new Date(Date.UTC(endTimestamp.getUTCFullYear(), endTimestamp.getUTCMonth(), endTimestamp.getUTCDate()))
  const endIsExactUtcDayBoundary = endTimestamp.getTime() === endDay.getTime()
  const seriesEndDay = new Date(endDay)

  if (endIsExactUtcDayBoundary)
    seriesEndDay.setUTCDate(seriesEndDay.getUTCDate() - 1)

  return {
    startDay,
    seriesEndDay,
    endExclusive: endIsExactUtcDayBoundary
      ? endTimestamp
      : new Date(endDay.getTime() + 24 * 60 * 60 * 1000),
  }
}

export async function getAdminEmailTypeBreakdown(
  c: Context,
  start_date: string,
  end_date: string,
): Promise<AdminEmailTypeBreakdown> {
  const emptyResult: AdminEmailTypeBreakdown = {
    totals: {
      professional: 0,
      personal: 0,
      disposable: 0,
      total: 0,
    },
    trend: [],
  }

  try {
    const pgClient = getPgClient(c, true)
    const drizzleClient = getDrizzleClient(pgClient)
    const { startDay, seriesEndDay, endExclusive } = getAdminUtcDateRange(start_date, end_date)

    const personalDomainsSql = sql.join(PERSONAL_EMAIL_DOMAINS.map(domain => sql`${domain}`), sql`, `)
    const disposableDomainsSql = sql.join(DISPOSABLE_EMAIL_DOMAINS.map(domain => sql`${domain}`), sql`, `)

    const query = sql`
      WITH date_series AS (
        SELECT generate_series(
          ${startDay.toISOString()}::timestamptz::date,
          ${seriesEndDay.toISOString()}::timestamptz::date,
          interval '1 day'
        )::date AS date
      ),
      normalized_users AS (
        SELECT
          (u.created_at AT TIME ZONE 'UTC')::date AS date,
          split_part(lower(trim(u.email)), '@', 2) AS domain
        FROM public.users u
        WHERE u.created_at >= ${startDay.toISOString()}::timestamptz
          AND u.created_at < ${endExclusive.toISOString()}::timestamptz
          AND POSITION('@' IN u.email) > 0
      ),
      classified_users AS (
        SELECT
          nu.date,
          CASE
            WHEN nu.domain IN (${disposableDomainsSql}) THEN 'disposable'
            WHEN nu.domain IN (${personalDomainsSql}) THEN 'personal'
            ELSE 'professional'
          END AS email_type
        FROM normalized_users nu
      ),
      daily_counts AS (
        SELECT
          ds.date,
          COUNT(*) FILTER (WHERE cu.email_type = 'professional')::int AS professional,
          COUNT(*) FILTER (WHERE cu.email_type = 'personal')::int AS personal,
          COUNT(*) FILTER (WHERE cu.email_type = 'disposable')::int AS disposable
        FROM date_series ds
        LEFT JOIN classified_users cu ON cu.date = ds.date
        GROUP BY ds.date
      )
      SELECT
        dc.date::text AS date,
        dc.professional,
        dc.personal,
        dc.disposable,
        (dc.professional + dc.personal + dc.disposable)::int AS total
      FROM daily_counts dc
      ORDER BY dc.date ASC
    `

    const result = await drizzleClient.execute(query)

    const trend = result.rows.map((row: any) => ({
      date: row.date,
      professional: Number(row.professional) || 0,
      personal: Number(row.personal) || 0,
      disposable: Number(row.disposable) || 0,
      total: Number(row.total) || 0,
    }))

    const totals = trend.reduce((acc, row) => {
      acc.professional += row.professional
      acc.personal += row.personal
      acc.disposable += row.disposable
      acc.total += row.total
      return acc
    }, {
      professional: 0,
      personal: 0,
      disposable: 0,
      total: 0,
    })

    cloudlog({
      requestId: c.get('requestId'),
      message: 'getAdminEmailTypeBreakdown result',
      totalRows: trend.length,
      totals,
    })

    return {
      totals,
      trend,
    }
  }
  catch (e: unknown) {
    logPgError(c, 'getAdminEmailTypeBreakdown', e)
    return emptyResult
  }
}

export interface AdminCustomerCountryBreakdown {
  total_organizations: number
  countries: Array<{
    country_code: string
    organizations: number
    percentage: number
  }>
}

export async function getAdminCustomerCountryBreakdown(
  c: Context,
  start_date: string,
  end_date: string,
): Promise<AdminCustomerCountryBreakdown> {
  const emptyResult: AdminCustomerCountryBreakdown = {
    total_organizations: 0,
    countries: [],
  }

  try {
    const pgClient = getPgClient(c, false)
    const drizzleClient = getDrizzleClient(pgClient)
    const { startDay, endExclusive } = getAdminUtcDateRange(start_date, end_date)

    const query = sql`
      WITH country_counts AS (
        SELECT
          UPPER(BTRIM(si.customer_country)) AS country_code,
          COUNT(*)::int AS organizations
        FROM orgs o
        INNER JOIN stripe_info si ON si.customer_id = o.customer_id
        WHERE o.created_at >= ${startDay.toISOString()}::timestamptz
          AND o.created_at < ${endExclusive.toISOString()}::timestamptz
          AND si.customer_country IS NOT NULL
          AND UPPER(BTRIM(si.customer_country)) ~ '^[A-Z]{2}$'
        GROUP BY UPPER(BTRIM(si.customer_country))
      ),
      totals AS (
        SELECT COALESCE(SUM(cc.organizations), 0)::int AS total_organizations
        FROM country_counts cc
      )
      SELECT
        cc.country_code,
        cc.organizations,
        CASE
          WHEN totals.total_organizations > 0
            THEN ROUND((cc.organizations::numeric / totals.total_organizations::numeric) * 100, 2)
          ELSE 0
        END::float AS percentage,
        totals.total_organizations
      FROM country_counts cc
      CROSS JOIN totals
      ORDER BY cc.organizations DESC, cc.country_code ASC
    `

    const result = await drizzleClient.execute(query)

    const countries = result.rows.map((row: any) => ({
      country_code: row.country_code,
      organizations: Number(row.organizations) || 0,
      percentage: Number(row.percentage) || 0,
    }))

    const totalOrganizations = Number((result.rows[0] as any)?.total_organizations) || 0

    cloudlog({
      requestId: c.get('requestId'),
      message: 'getAdminCustomerCountryBreakdown result',
      totalOrganizations,
      countryCount: countries.length,
    })

    return {
      total_organizations: totalOrganizations,
      countries,
    }
  }
  catch (e: unknown) {
    logPgError(c, 'getAdminCustomerCountryBreakdown', e)
    return emptyResult
  }
}

export interface AdminPluginBreakdown {
  date: string | null
  devices_last_month: number
  devices_last_month_ios: number
  devices_last_month_android: number
  version_breakdown: Record<string, number>
  major_breakdown: Record<string, number>
  version_ladder: AdminPluginVersionLadderEntry[]
  trend: Array<{
    date: string
    version_breakdown: Record<string, number>
    major_breakdown: Record<string, number>
  }>
}

export interface AdminPluginVersionTopApp {
  app_id: string
  device_count: number
  share: number
}

export interface AdminPluginVersionLadderEntry {
  version: string
  device_count: number
  percent: number
  top_apps: AdminPluginVersionTopApp[]
}

function parseBreakdownJson(value: unknown): Record<string, number> {
  if (!value)
    return {}
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, number>
    }
    catch {
      return {}
    }
  }
  if (typeof value === 'object')
    return value as Record<string, number>
  return {}
}

function parsePluginTopApps(value: unknown): AdminPluginVersionTopApp[] {
  if (!value)
    return []

  let rawValue: unknown = value
  if (typeof value === 'string') {
    try {
      rawValue = JSON.parse(value) as unknown
    }
    catch {
      return []
    }
  }

  if (!Array.isArray(rawValue))
    return []

  return rawValue
    .map((item) => {
      if (!(item && typeof item === 'object'))
        return null

      const app = item as Record<string, unknown>
      const appId = typeof app.app_id === 'string' ? app.app_id : ''
      const deviceCount = Number(app.device_count) || 0
      const share = Number(app.share) || 0

      return {
        app_id: appId,
        device_count: deviceCount,
        share,
      }
    })
    .filter((app): app is AdminPluginVersionTopApp => !!app && app.app_id.length > 0 && app.device_count > 0)
}

function parsePluginVersionLadderJson(value: unknown): AdminPluginVersionLadderEntry[] {
  if (!value)
    return []

  let rawValue: unknown = value
  if (typeof value === 'string') {
    try {
      rawValue = JSON.parse(value) as unknown
    }
    catch {
      return []
    }
  }

  if (!Array.isArray(rawValue))
    return []

  return rawValue
    .map((item) => {
      if (!(item && typeof item === 'object'))
        return null

      const entry = item as Record<string, unknown>
      const version = typeof entry.version === 'string' ? entry.version : ''
      const deviceCount = Number(entry.device_count) || 0
      const percent = Number(entry.percent) || 0

      return {
        version,
        device_count: deviceCount,
        percent,
        top_apps: parsePluginTopApps(entry.top_apps),
      }
    })
    .filter((entry): entry is AdminPluginVersionLadderEntry => !!entry && entry.version.length > 0 && entry.device_count > 0)
}

function normalizeTimestamp(value: unknown): string | null {
  if (!value)
    return null
  if (value instanceof Date)
    return value.toISOString()
  if (typeof value !== 'string' && typeof value !== 'number')
    return null

  const rawValue = String(value)
  let parsed = new Date(rawValue)
  if (Number.isNaN(parsed.getTime())) {
    const normalizedValue = rawValue
      .replace(' ', 'T')
      .replace(/([+-]\d{2})$/, '$1:00')
    parsed = new Date(normalizedValue)
  }
  if (Number.isNaN(parsed.getTime()))
    return null

  return parsed.toISOString()
}

export interface AdminOrganizationInsightRow {
  org_id: string
  org_name: string
  management_email: string
  plan_name: string | null
  billing_type: 'monthly' | 'yearly' | null
  upload_count: number
  build_count: number
  failed_update_count: number
  install_count: number
  update_attempt_count: number
  needs_attention: boolean
  fail_rate: number
  mau: number
  members_count: number
  apps_count: number
  last_upload_at: string | null
  last_build_at: string | null
  paid_at: string | null
  registered_at: string
}

export interface AdminOrganizationInsightsResult {
  organizations: AdminOrganizationInsightRow[]
  total: number
  plan_options: string[]
}

interface AdminOrganizationInsightsFilters {
  limit?: number
  offset?: number
  plan_name?: string
  billing_type?: 'monthly' | 'yearly'
  paid_only?: boolean
  search?: string
}

const ADMIN_ORG_ATTENTION_FAIL_RATE_PERCENT = 20
const ADMIN_ORG_ATTENTION_MIN_FAILED_UPDATES = 2
const ADMIN_ORG_ATTENTION_MIN_UPDATE_ATTEMPTS = 10

/**
 * Fetches admin organization rows with selected-period usage rollups.
 * Uses daily_* preprocessed tables for MAU, update failures, and build counts;
 * raw tables are only used for org metadata, bundle upload counts, and latest timestamps.
 */
export async function getAdminOrganizationInsights(
  c: Context,
  start_date: string,
  end_date: string,
  filters: AdminOrganizationInsightsFilters = {},
): Promise<AdminOrganizationInsightsResult> {
  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const safeLimit = Math.max(1, Math.min(Math.floor(filters.limit ?? 50), 500))
    const safeOffset = Math.max(0, Math.floor(filters.offset ?? 0))
    const startDateOnly = start_date.split('T')[0]
    const endDateOnly = end_date.split('T')[0]
    const trimmedPlanName = filters.plan_name?.trim()
    const trimmedSearch = filters.search?.trim()

    const billingTypeExpression = sql`
      CASE
        WHEN si.price_id = p.price_y_id THEN 'yearly'
        WHEN si.price_id = p.price_m_id THEN 'monthly'
        WHEN si.subscription_anchor_start IS NOT NULL
          AND si.subscription_anchor_end IS NOT NULL
          AND si.subscription_anchor_end::timestamp - si.subscription_anchor_start::timestamp >= INTERVAL '330 days'
          THEN 'yearly'
        WHEN si.subscription_anchor_start IS NOT NULL
          AND si.subscription_anchor_end IS NOT NULL
          THEN 'monthly'
        ELSE NULL
      END
    `
    const planFilter = trimmedPlanName ? sql`AND p.name = ${trimmedPlanName}` : sql``
    const billingFilter = filters.billing_type ? sql`AND ${billingTypeExpression} = ${filters.billing_type}` : sql``
    const paidFilter = filters.paid_only ? sql`AND si.status = 'succeeded'` : sql``
    const searchFilter = trimmedSearch
      ? sql`AND (
          o.name ILIKE ${`%${trimmedSearch}%`}
          OR o.management_email ILIKE ${`%${trimmedSearch}%`}
          OR o.id::text = ${trimmedSearch}
        )`
      : sql``

    const dataQuery = sql`
      WITH filtered_orgs_all AS (
        SELECT
          o.id AS org_id,
          o.name AS org_name,
          o.management_email,
          o.created_at AS registered_at,
          si.paid_at,
          p.name AS plan_name,
          ${billingTypeExpression} AS billing_type
        FROM orgs o
        LEFT JOIN stripe_info si ON si.customer_id = o.customer_id
        LEFT JOIN plans p ON p.stripe_id = si.product_id
        WHERE true
          ${planFilter}
          ${billingFilter}
          ${paidFilter}
          ${searchFilter}
      ),
      version_usage_totals AS (
        SELECT
          a.owner_org AS org_id,
          COALESCE(SUM(COALESCE(dv.fail, 0)), 0)::bigint AS failed_update_count,
          COALESCE(SUM(COALESCE(dv.install, 0)), 0)::bigint AS install_count
        FROM filtered_orgs_all filtered
        INNER JOIN apps a ON a.owner_org = filtered.org_id
        INNER JOIN daily_version dv ON dv.app_id = a.app_id
        WHERE dv.date >= ${startDateOnly}::date
          AND dv.date <= ${endDateOnly}::date
        GROUP BY a.owner_org
      ),
      version_usage_rank AS (
        SELECT
          vut.org_id,
          vut.failed_update_count,
          vut.install_count,
          (vut.install_count + vut.failed_update_count)::bigint AS update_attempt_count,
          CASE
            WHEN vut.install_count + vut.failed_update_count > 0
              THEN (vut.failed_update_count::float / (vut.install_count + vut.failed_update_count)::float) * 100
            ELSE 0
          END::float AS fail_rate
        FROM version_usage_totals vut
      ),
      filtered_orgs_scored AS (
        SELECT
          filtered.org_id,
          filtered.org_name,
          filtered.management_email,
          filtered.registered_at,
          filtered.paid_at,
          filtered.plan_name,
          filtered.billing_type,
          COALESCE(vur.failed_update_count, 0)::bigint AS failed_update_count,
          COALESCE(vur.install_count, 0)::bigint AS install_count,
          COALESCE(vur.update_attempt_count, 0)::bigint AS update_attempt_count,
          COALESCE(vur.fail_rate, 0)::float AS fail_rate,
          (
            COALESCE(vur.fail_rate, 0) >= ${ADMIN_ORG_ATTENTION_FAIL_RATE_PERCENT}
            AND COALESCE(vur.failed_update_count, 0) >= ${ADMIN_ORG_ATTENTION_MIN_FAILED_UPDATES}
            AND COALESCE(vur.update_attempt_count, 0) >= ${ADMIN_ORG_ATTENTION_MIN_UPDATE_ATTEMPTS}
          )::boolean AS needs_attention
        FROM filtered_orgs_all filtered
        LEFT JOIN version_usage_rank vur ON vur.org_id = filtered.org_id
      ),
      filtered_orgs AS (
        SELECT *
        FROM filtered_orgs_scored
        ORDER BY
          needs_attention DESC,
          CASE
            WHEN needs_attention THEN fail_rate
            ELSE NULL
          END DESC,
          registered_at DESC NULLS LAST,
          org_id
        LIMIT ${safeLimit}
        OFFSET ${safeOffset}
      ),
      apps_by_org AS (
        SELECT
          a.owner_org AS org_id,
          COUNT(*)::int AS apps_count
        FROM apps a
        INNER JOIN filtered_orgs filtered ON filtered.org_id = a.owner_org
        GROUP BY a.owner_org
      ),
      members_by_org AS (
        SELECT
          ou.org_id,
          COUNT(DISTINCT ou.user_id)::int AS members_count
        FROM org_users ou
        INNER JOIN filtered_orgs filtered ON filtered.org_id = ou.org_id
        WHERE ou.is_invite IS NOT TRUE
        GROUP BY ou.org_id
      ),
      mau_by_org AS (
        SELECT
          a.owner_org AS org_id,
          COALESCE(SUM(dm.mau), 0)::bigint AS mau
        FROM filtered_orgs filtered
        INNER JOIN apps a ON a.owner_org = filtered.org_id
        INNER JOIN daily_mau dm ON dm.app_id = a.app_id
        WHERE dm.date >= ${startDateOnly}::date
          AND dm.date <= ${endDateOnly}::date
        GROUP BY a.owner_org
      ),
      build_usage_by_org AS (
        SELECT
          a.owner_org AS org_id,
          COALESCE(SUM(dbt.build_count), 0)::bigint AS build_count
        FROM filtered_orgs filtered
        INNER JOIN apps a ON a.owner_org = filtered.org_id
        INNER JOIN daily_build_time dbt ON dbt.app_id = a.app_id
        WHERE dbt.date >= ${startDateOnly}::date
          AND dbt.date <= ${endDateOnly}::date
        GROUP BY a.owner_org
      ),
      bundle_uploads_by_org AS (
        SELECT
          av.owner_org AS org_id,
          COUNT(*) FILTER (
            WHERE av.created_at >= ${start_date}::timestamp
              AND av.created_at < ${end_date}::timestamp
          )::int AS upload_count,
          MAX(av.created_at) AS last_upload_at
        FROM app_versions av
        INNER JOIN filtered_orgs filtered ON filtered.org_id = av.owner_org
        WHERE av.name NOT IN ('builtin', 'unknown')
        GROUP BY av.owner_org
      ),
      last_builds_by_org AS (
        SELECT
          bl.org_id,
          MAX(bl.created_at) AS last_build_at
        FROM build_logs bl
        INNER JOIN filtered_orgs filtered ON filtered.org_id = bl.org_id
        GROUP BY bl.org_id
      )
      SELECT
        filtered.org_id,
        filtered.org_name,
        filtered.management_email,
        filtered.plan_name,
        filtered.billing_type,
        COALESCE(buo.upload_count, 0)::int AS upload_count,
        COALESCE(bu.build_count, 0)::bigint AS build_count,
        filtered.failed_update_count,
        filtered.install_count,
        filtered.update_attempt_count,
        filtered.needs_attention,
        filtered.fail_rate,
        COALESCE(mau.mau, 0)::bigint AS mau,
        COALESCE(members.members_count, 0)::int AS members_count,
        COALESCE(apps.apps_count, 0)::int AS apps_count,
        buo.last_upload_at,
        lb.last_build_at,
        filtered.paid_at,
        filtered.registered_at
      FROM filtered_orgs filtered
      LEFT JOIN apps_by_org apps ON apps.org_id = filtered.org_id
      LEFT JOIN members_by_org members ON members.org_id = filtered.org_id
      LEFT JOIN mau_by_org mau ON mau.org_id = filtered.org_id
      LEFT JOIN build_usage_by_org bu ON bu.org_id = filtered.org_id
      LEFT JOIN bundle_uploads_by_org buo ON buo.org_id = filtered.org_id
      LEFT JOIN last_builds_by_org lb ON lb.org_id = filtered.org_id
      ORDER BY
        filtered.needs_attention DESC,
        CASE
          WHEN filtered.needs_attention THEN filtered.fail_rate
          ELSE NULL
        END DESC,
        filtered.registered_at DESC NULLS LAST,
        filtered.org_id
    `

    const countQuery = sql`
      SELECT COUNT(*)::int AS total
      FROM orgs o
      LEFT JOIN stripe_info si ON si.customer_id = o.customer_id
      LEFT JOIN plans p ON p.stripe_id = si.product_id
      WHERE true
        ${planFilter}
        ${billingFilter}
        ${paidFilter}
        ${searchFilter}
    `

    const planOptionsQuery = sql`
      SELECT DISTINCT name
      FROM plans
      WHERE name IS NOT NULL AND name != ''
      ORDER BY name ASC
    `

    const [result, countResult, planOptionsResult] = await Promise.all([
      drizzleClient.execute(dataQuery),
      drizzleClient.execute(countQuery),
      drizzleClient.execute(planOptionsQuery),
    ])

    const organizations: AdminOrganizationInsightRow[] = result.rows.map((row: any) => ({
      org_id: row.org_id,
      org_name: row.org_name,
      management_email: row.management_email,
      plan_name: row.plan_name ?? null,
      billing_type: row.billing_type ?? null,
      upload_count: Number(row.upload_count) || 0,
      build_count: Number(row.build_count) || 0,
      failed_update_count: Number(row.failed_update_count) || 0,
      install_count: Number(row.install_count) || 0,
      update_attempt_count: Number(row.update_attempt_count) || 0,
      needs_attention: row.needs_attention === true,
      fail_rate: Number(row.fail_rate) || 0,
      mau: Number(row.mau) || 0,
      members_count: Number(row.members_count) || 0,
      apps_count: Number(row.apps_count) || 0,
      last_upload_at: normalizeTimestamp(row.last_upload_at),
      last_build_at: normalizeTimestamp(row.last_build_at),
      paid_at: normalizeTimestamp(row.paid_at),
      registered_at: normalizeTimestamp(row.registered_at) ?? '',
    }))

    const total = Number((countResult.rows[0] as any)?.total) || 0
    const plan_options = planOptionsResult.rows
      .map((row: any) => String(row.name || '').trim())
      .filter(Boolean)

    cloudlog({ requestId: c.get('requestId'), message: 'getAdminOrganizationInsights result', resultCount: organizations.length, total })

    return { organizations, total, plan_options }
  }
  catch (e: unknown) {
    logPgError(c, 'getAdminOrganizationInsights', e)
    return { organizations: [], total: 0, plan_options: [] }
  }
  finally {
    if (pgClient)
      await closeClient(c, pgClient)
  }
}

// Admin Cancelled Organizations List
export interface AdminCancelledOrganizationRow {
  org_id: string
  org_name: string
  management_email: string
  canceled_at: string
  customer_id: string
  subscription_id: string | null
  churn_reason: string | null
  plan_name: string | null
  billing_type: 'monthly' | 'yearly' | null
  subscription_or_signup_date: string
}

export interface AdminCancelledOrganizationsResult {
  organizations: AdminCancelledOrganizationRow[]
  total: number
}

/**
 * Fetches organizations that recently canceled, ordered by most recent cancellation.
 */
export async function getAdminCancelledOrganizations(
  c: Context,
  start_date?: string,
  end_date?: string,
  limit: number = 20,
  offset: number = 0,
): Promise<AdminCancelledOrganizationsResult> {
  try {
    const pgClient = getPgClient(c, true)
    const drizzleClient = getDrizzleClient(pgClient)

    const dateFilter = start_date && end_date
      ? sql`AND si.canceled_at >= ${start_date}::timestamp AND si.canceled_at < ${end_date}::timestamp`
      : sql``

    // The admin dashboard intentionally falls back to creator signup date when
    // no first payment timestamp exists, and finally to org creation if the
    // creator row is missing.
    const query = sql`
      SELECT
        o.id AS org_id,
        o.name AS org_name,
        o.management_email,
        si.canceled_at,
        si.customer_id,
        si.churn_reason,
        si.subscription_id,
        p.name AS plan_name,
        CASE
          WHEN si.price_id = p.price_y_id THEN 'yearly'
          WHEN si.price_id = p.price_m_id THEN 'monthly'
          WHEN si.subscription_anchor_start IS NOT NULL
            AND si.subscription_anchor_end IS NOT NULL
            AND si.subscription_anchor_end::timestamp - si.subscription_anchor_start::timestamp >= INTERVAL '330 days'
            THEN 'yearly'
          WHEN si.subscription_anchor_start IS NOT NULL
            AND si.subscription_anchor_end IS NOT NULL
            THEN 'monthly'
          ELSE NULL
        END AS billing_type,
        COALESCE(si.paid_at, u.created_at, o.created_at) AS subscription_or_signup_date
      FROM orgs o
      INNER JOIN stripe_info si ON si.customer_id = o.customer_id
      LEFT JOIN plans p ON p.stripe_id = si.product_id
      LEFT JOIN users u ON u.id = o.created_by
      WHERE si.canceled_at IS NOT NULL
        ${dateFilter}
      ORDER BY si.canceled_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `

    const countQuery = sql`
      SELECT COUNT(*)::int AS total
      FROM orgs o
      INNER JOIN stripe_info si ON si.customer_id = o.customer_id
      WHERE si.canceled_at IS NOT NULL
        ${dateFilter}
    `

    const [result, countResult] = await Promise.all([
      drizzleClient.execute(query),
      drizzleClient.execute(countQuery),
    ])

    const organizations: AdminCancelledOrganizationRow[] = result.rows.map((row: any) => ({
      org_id: row.org_id,
      org_name: row.org_name,
      management_email: row.management_email,
      canceled_at: normalizeTimestamp(row.canceled_at) ?? '',
      churn_reason: row.churn_reason ?? null,
      customer_id: row.customer_id,
      subscription_id: row.subscription_id,
      plan_name: row.plan_name ?? null,
      billing_type: row.billing_type ?? null,
      subscription_or_signup_date: normalizeTimestamp(row.subscription_or_signup_date) ?? '',
    }))

    const total = Number((countResult.rows[0] as any)?.total) || 0

    cloudlog({ requestId: c.get('requestId'), message: 'getAdminCancelledOrganizations result', resultCount: organizations.length, total })

    return { organizations, total }
  }
  catch (e: unknown) {
    logPgError(c, 'getAdminCancelledOrganizations', e)
    return { organizations: [], total: 0 }
  }
}

export interface AdminTrialOrganization {
  org_id: string
  org_name: string
  management_email: string
  plan_name: string | null
  trial_end_date: string
  days_remaining: number
  trial_extension_count: number
  created_at: string
  last_bundle_upload_at: string | null
}

export interface AdminTrialOrganizationsResult {
  organizations: AdminTrialOrganization[]
  total: number
}

/**
 * Fetches organizations currently in their trial period for the admin dashboard.
 * Returns a paginated list of trial organizations ordered by days remaining (ascending),
 * so organizations expiring soon appear first.
 *
 * Trial organizations are those where:
 * - trial_at date is today or in the future (>= CURRENT_DATE)
 * - status is NULL (new org, no payment attempted) or not 'succeeded' (no active subscription)
 */
export async function getAdminTrialOrganizations(
  c: Context,
  limit: number = 20,
  offset: number = 0,
): Promise<AdminTrialOrganizationsResult> {
  try {
    // The admin dashboard needs plans.name, and plans is not replicated to
    // read replicas.
    const pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)

    // Query to get trial organizations ordered by days remaining (ascending - expiring soon first)
    // Filter logic:
    // - trial_at >= CURRENT_DATE: includes trials expiring today (days_remaining = 0)
    // - status IS NULL: new organizations that haven't attempted payment yet
    // - status not 'succeeded': organizations without an active subscription
    const query = sql`
      WITH latest_bundle_uploads AS (
        SELECT
          a.owner_org,
          MAX(av.created_at) AS last_bundle_upload_at
        FROM apps a
        INNER JOIN app_versions av ON av.app_id = a.app_id
        WHERE av.name NOT IN ('builtin', 'unknown')
        GROUP BY a.owner_org
      )
      SELECT
        o.id AS org_id,
        o.name AS org_name,
        o.management_email,
        p.name AS plan_name,
        si.trial_at AS trial_end_date,
        GREATEST(0, (si.trial_at::date - CURRENT_DATE)) AS days_remaining,
        CASE
          WHEN si.trial_at::date - o.created_at::date > 15
            THEN ((si.trial_at::date - o.created_at::date - 15) / 15)
          ELSE 0
        END AS trial_extension_count,
        o.created_at,
        lbu.last_bundle_upload_at
      FROM orgs o
      INNER JOIN stripe_info si ON si.customer_id = o.customer_id
      LEFT JOIN plans p ON p.stripe_id = si.product_id
      LEFT JOIN latest_bundle_uploads lbu ON lbu.owner_org = o.id
      WHERE si.trial_at::date >= CURRENT_DATE
        AND (si.status IS NULL OR si.status != 'succeeded')
      ORDER BY days_remaining ASC, o.created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `

    // Count query for pagination
    const countQuery = sql`
      SELECT COUNT(*)::int AS total
      FROM orgs o
      INNER JOIN stripe_info si ON si.customer_id = o.customer_id
      WHERE si.trial_at::date >= CURRENT_DATE
        AND (si.status IS NULL OR si.status != 'succeeded')
    `

    const [result, countResult] = await Promise.all([
      drizzleClient.execute(query),
      drizzleClient.execute(countQuery),
    ])

    const organizations: AdminTrialOrganization[] = result.rows.map((row: any) => ({
      org_id: row.org_id,
      org_name: row.org_name,
      management_email: row.management_email,
      plan_name: row.plan_name ?? null,
      trial_end_date: normalizeTimestamp(row.trial_end_date) ?? '',
      days_remaining: Number(row.days_remaining),
      trial_extension_count: Number(row.trial_extension_count) || 0,
      created_at: normalizeTimestamp(row.created_at) ?? '',
      last_bundle_upload_at: normalizeTimestamp(row.last_bundle_upload_at),
    }))

    const total = Number((countResult.rows[0] as any)?.total) || 0

    cloudlog({ requestId: c.get('requestId'), message: 'getAdminTrialOrganizations result', resultCount: organizations.length, total })

    return { organizations, total }
  }
  catch (e: unknown) {
    logPgError(c, 'getAdminTrialOrganizations', e)
    return { organizations: [], total: 0 }
  }
}

export interface AdminTrialPlanBreakdown {
  totals: Array<{
    plan_name: string
    total: number
  }>
  trend: Array<{
    date: string
    total: number
    plans: Record<string, number>
  }>
}

function createAdminTrialPlanTrendDay(date: string): AdminTrialPlanBreakdown['trend'][number] {
  return { date, total: 0, plans: {} }
}

export async function getAdminTrialPlanBreakdown(
  c: Context,
  start_date: string,
  end_date: string,
): Promise<AdminTrialPlanBreakdown> {
  const emptyResult: AdminTrialPlanBreakdown = {
    totals: [],
    trend: [],
  }

  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    // The admin dashboard needs plans.name, and plans is not available on every read replica.
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const { startDay, seriesEndDay, endExclusive } = getAdminUtcDateRange(start_date, end_date)

    const query = sql`
      WITH date_series AS (
        SELECT generate_series(
          ${startDay.toISOString()}::timestamptz::date,
          ${seriesEndDay.toISOString()}::timestamptz::date,
          interval '1 day'
        )::date AS date
      ),
      daily_trials AS (
        SELECT
          (o.created_at AT TIME ZONE 'UTC')::date AS date,
          COALESCE(NULLIF(BTRIM(p.name), ''), 'Unknown') AS plan_name,
          COUNT(DISTINCT o.id)::int AS trials
        FROM orgs o
        INNER JOIN stripe_info si ON si.customer_id = o.customer_id
        LEFT JOIN plans p ON p.stripe_id = si.product_id
        WHERE o.created_at >= ${startDay.toISOString()}::timestamptz
          AND o.created_at < ${endExclusive.toISOString()}::timestamptz
          AND si.trial_at IS NOT NULL
        GROUP BY (o.created_at AT TIME ZONE 'UTC')::date, COALESCE(NULLIF(BTRIM(p.name), ''), 'Unknown')
      ),
      plan_names AS (
        SELECT BTRIM(name) AS plan_name
        FROM plans
        WHERE BTRIM(name) != ''
        UNION
        SELECT plan_name
        FROM daily_trials
      ),
      filled AS (
        SELECT
          ds.date,
          plan_name_set.plan_name,
          COALESCE(dt.trials, 0)::int AS trials
        FROM date_series ds
        CROSS JOIN plan_names plan_name_set
        LEFT JOIN daily_trials dt ON dt.date = ds.date AND dt.plan_name = plan_name_set.plan_name
      )
      SELECT
        date,
        plan_name,
        trials
      FROM filled
      ORDER BY date ASC, plan_name ASC
    `

    const result = await drizzleClient.execute(query)
    const totalsByPlan = new Map<string, number>()
    const trendByDate = new Map<string, { date: string, total: number, plans: Record<string, number> }>()

    for (const row of result.rows as any[]) {
      const date = row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date)
      const planName = String(row.plan_name || 'Unknown')
      const trials = Number(row.trials) || 0
      const day = trendByDate.get(date) ?? createAdminTrialPlanTrendDay(date)

      day.plans[planName] = trials
      day.total += trials
      trendByDate.set(date, day)
      totalsByPlan.set(planName, (totalsByPlan.get(planName) ?? 0) + trials)
    }

    const totals = Array.from(totalsByPlan.entries())
      .map(([plan_name, total]) => ({ plan_name, total }))
      .sort((a, b) => b.total - a.total || a.plan_name.localeCompare(b.plan_name))

    const trend = Array.from(trendByDate.values())

    cloudlog({
      requestId: c.get('requestId'),
      message: 'getAdminTrialPlanBreakdown result',
      resultCount: trend.length,
      planCount: totals.length,
    })

    return {
      totals,
      trend,
    }
  }
  catch (e: unknown) {
    logPgError(c, 'getAdminTrialPlanBreakdown', e)
    return emptyResult
  }
  finally {
    if (pgClient)
      await closeClient(c, pgClient)
  }
}

// Admin Onboarding Funnel
export interface AdminOnboardingFunnel {
  total_orgs: number
  orgs_with_app: number
  orgs_with_channel: number
  orgs_with_bundle: number
  orgs_subscribed: number
  orgs_with_production_device: number
  orgs_with_update_download: number
  activation_telemetry_available: boolean
  // Conversion rates
  app_conversion_rate: number
  channel_conversion_rate: number
  bundle_conversion_rate: number
  subscription_conversion_rate: number
  production_device_conversion_rate: number
  update_download_conversion_rate: number
  // Trend data
  trend: Array<{
    date: string
    new_orgs: number
    orgs_created_app: number
    orgs_created_channel: number
    orgs_created_bundle: number
    orgs_subscribed: number
    orgs_with_production_device: number
    orgs_with_update_download: number
  }>
}

export async function getAdminOnboardingFunnel(
  c: Context,
  start_date: string,
  end_date: string,
): Promise<AdminOnboardingFunnel> {
  try {
    // Read replicas don't include org/app/channel data, so use primary DB.
    const pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const now = new Date()

    const onboardingBundleEligibility = sql`
      a.created_at >= o.created_at
      AND a.created_at < o.created_at + interval '7 days'
      AND EXISTS (
        SELECT 1
        FROM channels c
        WHERE c.app_id = a.app_id
      )
      AND EXISTS (
        SELECT 1
        FROM app_versions av
        WHERE av.app_id = a.app_id
          AND av.name NOT IN ('builtin', 'unknown')
          AND av.created_at >= o.created_at
          AND av.created_at < o.created_at + interval '7 days'
      )
    `

    // Get total funnel counts for orgs created in the date range
    const funnelQuery = sql`
      WITH orgs_in_range AS (
        SELECT id, customer_id, created_at, created_at::date as created_date
        FROM orgs
        WHERE created_at >= ${start_date}::timestamp
          AND created_at < ${end_date}::timestamp
      ),
      orgs_with_apps AS (
        SELECT DISTINCT o.id, o.created_date
        FROM orgs_in_range o
        INNER JOIN apps a ON a.owner_org = o.id
      ),
      orgs_with_channels AS (
        SELECT DISTINCT o.id, o.created_date
        FROM orgs_in_range o
        INNER JOIN apps a ON a.owner_org = o.id
        INNER JOIN channels c ON c.app_id = a.app_id
      ),
      orgs_with_bundles AS (
        SELECT DISTINCT o.id, o.customer_id, o.created_at, o.created_date
        FROM orgs_in_range o
        INNER JOIN apps a ON a.owner_org = o.id
        WHERE ${onboardingBundleEligibility}
      ),
      orgs_subscribed AS (
        SELECT DISTINCT o.id, o.created_date
        FROM orgs_with_bundles o
        INNER JOIN stripe_info si ON si.customer_id = o.customer_id
        WHERE si.paid_at IS NOT NULL
          AND si.paid_at >= o.created_at
          AND si.paid_at < o.created_at + interval '7 days'
      )
      SELECT
        (SELECT COUNT(*)::int FROM orgs_in_range) as total_orgs,
        (SELECT COUNT(*)::int FROM orgs_with_apps) as orgs_with_app,
        (SELECT COUNT(*)::int FROM orgs_with_channels) as orgs_with_channel,
        (SELECT COUNT(*)::int FROM orgs_with_bundles) as orgs_with_bundle,
        (SELECT COUNT(*)::int FROM orgs_subscribed) as orgs_subscribed
    `

    const funnelResult = await drizzleClient.execute(funnelQuery)
    const funnelRow = funnelResult.rows[0] as any || {}

    const totalOrgs = Number(funnelRow.total_orgs) || 0
    const orgsWithApp = Number(funnelRow.orgs_with_app) || 0
    const orgsWithChannel = Number(funnelRow.orgs_with_channel) || 0
    const orgsWithBundle = Number(funnelRow.orgs_with_bundle) || 0
    const orgsSubscribed = Number(funnelRow.orgs_subscribed) || 0

    // Get daily trend data
    const trendQuery = sql`
      WITH date_series AS (
        SELECT generate_series(
          ${start_date}::timestamptz::date,
          (${end_date}::timestamptz::date - 1),
          '1 day'::interval
        )::date as date
      ),
      daily_orgs AS (
        SELECT created_at::date as date, COUNT(*)::int as new_orgs
        FROM orgs
        WHERE created_at >= ${start_date}::timestamp
          AND created_at < ${end_date}::timestamp
        GROUP BY created_at::date
      ),
      daily_apps AS (
        SELECT o.created_at::date as date, COUNT(DISTINCT o.id)::int as orgs_created_app
        FROM orgs o
        INNER JOIN apps a ON a.owner_org = o.id
        WHERE o.created_at >= ${start_date}::timestamp
          AND o.created_at < ${end_date}::timestamp
          AND a.created_at >= o.created_at
          AND a.created_at < o.created_at + interval '7 days'
        GROUP BY o.created_at::date
      ),
      daily_channels AS (
        SELECT o.created_at::date as date, COUNT(DISTINCT o.id)::int as orgs_created_channel
        FROM orgs o
        INNER JOIN apps a ON a.owner_org = o.id
        INNER JOIN channels c ON c.app_id = a.app_id
        WHERE o.created_at >= ${start_date}::timestamp
          AND o.created_at < ${end_date}::timestamp
          AND c.created_at >= o.created_at
          AND c.created_at < o.created_at + interval '7 days'
        GROUP BY o.created_at::date
      ),
      daily_bundles AS (
        SELECT o.created_at::date as date, COUNT(DISTINCT o.id)::int as orgs_created_bundle
        FROM orgs o
        INNER JOIN apps a ON a.owner_org = o.id
        WHERE o.created_at >= ${start_date}::timestamp
          AND o.created_at < ${end_date}::timestamp
          AND ${onboardingBundleEligibility}
        GROUP BY o.created_at::date
      ),
      daily_subscriptions AS (
        SELECT o.created_at::date as date, COUNT(DISTINCT o.id)::int as orgs_subscribed
        FROM orgs o
        INNER JOIN apps a ON a.owner_org = o.id
        INNER JOIN stripe_info si ON si.customer_id = o.customer_id
        WHERE o.created_at >= ${start_date}::timestamp
          AND o.created_at < ${end_date}::timestamp
          AND ${onboardingBundleEligibility}
          AND si.paid_at IS NOT NULL
          AND si.paid_at >= o.created_at
          AND si.paid_at < o.created_at + interval '7 days'
        GROUP BY o.created_at::date
      )
      SELECT
        ds.date,
        COALESCE(dorgs.new_orgs, 0) as new_orgs,
        COALESCE(dapps.orgs_created_app, 0) as orgs_created_app,
        COALESCE(dchannels.orgs_created_channel, 0) as orgs_created_channel,
        COALESCE(dbundles.orgs_created_bundle, 0) as orgs_created_bundle,
        COALESCE(dsubscriptions.orgs_subscribed, 0) as orgs_subscribed
      FROM date_series ds
      LEFT JOIN daily_orgs dorgs ON dorgs.date = ds.date
      LEFT JOIN daily_apps dapps ON dapps.date = ds.date
      LEFT JOIN daily_channels dchannels ON dchannels.date = ds.date
      LEFT JOIN daily_bundles dbundles ON dbundles.date = ds.date
      LEFT JOIN daily_subscriptions dsubscriptions ON dsubscriptions.date = ds.date
      ORDER BY ds.date ASC
    `

    const activationCohortQuery = sql`
      SELECT DISTINCT
        o.id as org_id,
        o.created_at as created_at,
        a.app_id as app_id
      FROM orgs o
      INNER JOIN apps a ON a.owner_org = o.id
      WHERE o.created_at >= ${start_date}::timestamp
        AND o.created_at < ${end_date}::timestamp
        AND ${onboardingBundleEligibility}
    `

    const [trendResult, activationCohortResult] = await Promise.all([
      drizzleClient.execute(trendQuery),
      drizzleClient.execute(activationCohortQuery),
    ])

    const activationCohorts: AdminOnboardingActivationCohort[] = []
    for (const row of activationCohortResult.rows as any[]) {
      const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at)
      if (!row.org_id || !row.app_id || Number.isNaN(createdAt.getTime()))
        continue

      const activationWindowEnd = new Date(createdAt)
      activationWindowEnd.setUTCDate(activationWindowEnd.getUTCDate() + 7)
      activationCohorts.push({
        org_id: String(row.org_id),
        app_id: String(row.app_id),
        created_at: createdAt,
        activation_window_end: activationWindowEnd < now ? activationWindowEnd : now,
      })
    }

    const activationTelemetry = await getAdminOnboardingTelemetry(
      c,
      activationCohorts.map(cohort => ({
        app_id: cohort.app_id,
        start_at: cohort.created_at,
        end_at: cohort.activation_window_end,
      })),
      start_date,
      now,
    )
    const activationMetrics = getAdminOnboardingActivationMetrics(activationCohorts, activationTelemetry)

    const trend = trendResult.rows.map((row: any) => {
      const date = row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date)
      const activationTrend = activationMetrics.trend_by_date.get(date)
      return {
        date,
        new_orgs: Number(row.new_orgs) || 0,
        orgs_created_app: Number(row.orgs_created_app) || 0,
        orgs_created_channel: Number(row.orgs_created_channel) || 0,
        orgs_created_bundle: Number(row.orgs_created_bundle) || 0,
        orgs_subscribed: Number(row.orgs_subscribed) || 0,
        orgs_with_production_device: activationTrend?.orgs_with_production_device ?? 0,
        orgs_with_update_download: activationTrend?.orgs_with_update_download ?? 0,
      }
    })

    const result: AdminOnboardingFunnel = {
      total_orgs: totalOrgs,
      orgs_with_app: orgsWithApp,
      orgs_with_channel: orgsWithChannel,
      orgs_with_bundle: orgsWithBundle,
      orgs_subscribed: orgsSubscribed,
      orgs_with_production_device: activationMetrics.orgs_with_production_device,
      orgs_with_update_download: activationMetrics.orgs_with_update_download,
      activation_telemetry_available: activationTelemetry.available,
      app_conversion_rate: totalOrgs > 0 ? (orgsWithApp / totalOrgs) * 100 : 0,
      channel_conversion_rate: orgsWithApp > 0 ? (orgsWithChannel / orgsWithApp) * 100 : 0,
      bundle_conversion_rate: orgsWithChannel > 0 ? (orgsWithBundle / orgsWithChannel) * 100 : 0,
      subscription_conversion_rate: orgsWithBundle > 0 ? (orgsSubscribed / orgsWithBundle) * 100 : 0,
      production_device_conversion_rate: orgsWithBundle > 0 ? (activationMetrics.orgs_with_production_device / orgsWithBundle) * 100 : 0,
      update_download_conversion_rate: activationMetrics.orgs_with_production_device > 0 ? (activationMetrics.orgs_with_update_download / activationMetrics.orgs_with_production_device) * 100 : 0,
      trend,
    }

    cloudlog({ requestId: c.get('requestId'), message: 'getAdminOnboardingFunnel result', result })

    return result
  }
  catch (e: unknown) {
    logPgError(c, 'getAdminOnboardingFunnel', e)
    return {
      total_orgs: 0,
      orgs_with_app: 0,
      orgs_with_channel: 0,
      orgs_with_bundle: 0,
      orgs_subscribed: 0,
      orgs_with_production_device: 0,
      orgs_with_update_download: 0,
      activation_telemetry_available: false,
      app_conversion_rate: 0,
      channel_conversion_rate: 0,
      bundle_conversion_rate: 0,
      subscription_conversion_rate: 0,
      production_device_conversion_rate: 0,
      update_download_conversion_rate: 0,
      trend: [],
    }
  }
}

export async function getAdminPluginBreakdown(
  c: Context,
  start_date: string,
  end_date: string,
): Promise<AdminPluginBreakdown> {
  try {
    const pgClient = getPgClient(c, true)
    const drizzleClient = getDrizzleClient(pgClient)

    const startDateOnly = start_date.split('T')[0]
    const endDateOnly = end_date.split('T')[0]

    const query = sql`
      SELECT
        date_id AS date,
        COALESCE(devices_last_month, 0)::int AS devices_last_month,
        COALESCE(devices_last_month_ios, 0)::int AS devices_last_month_ios,
        COALESCE(devices_last_month_android, 0)::int AS devices_last_month_android,
        plugin_version_breakdown,
        plugin_major_breakdown,
        plugin_version_ladder
      FROM global_stats
      WHERE date_id >= ${startDateOnly}
        AND date_id <= ${endDateOnly}
      ORDER BY date_id ASC
    `

    const result = await drizzleClient.execute(query)
    const rows = result.rows as any[]

    if (rows.length === 0) {
      return {
        date: null,
        devices_last_month: 0,
        devices_last_month_ios: 0,
        devices_last_month_android: 0,
        version_breakdown: {},
        major_breakdown: {},
        version_ladder: [],
        trend: [],
      }
    }

    const trend = rows.map((row) => {
      const date = row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date)
      return {
        date,
        version_breakdown: parseBreakdownJson(row.plugin_version_breakdown),
        major_breakdown: parseBreakdownJson(row.plugin_major_breakdown),
      }
    })
    const latestRow = rows.at(-1)!
    const latestDate = latestRow.date instanceof Date ? latestRow.date.toISOString().split('T')[0] : String(latestRow.date)
    const versionBreakdown = parseBreakdownJson(latestRow.plugin_version_breakdown)
    const majorBreakdown = parseBreakdownJson(latestRow.plugin_major_breakdown)
    const versionLadder = parsePluginVersionLadderJson(latestRow.plugin_version_ladder)

    return {
      date: latestDate,
      devices_last_month: Number(latestRow.devices_last_month) || 0,
      devices_last_month_ios: Number(latestRow.devices_last_month_ios) || 0,
      devices_last_month_android: Number(latestRow.devices_last_month_android) || 0,
      version_breakdown: versionBreakdown,
      major_breakdown: majorBreakdown,
      version_ladder: versionLadder,
      trend,
    }
  }
  catch (e: unknown) {
    logPgError(c, 'getAdminPluginBreakdown', e)
    return {
      date: null,
      devices_last_month: 0,
      devices_last_month_ios: 0,
      devices_last_month_android: 0,
      version_breakdown: {},
      major_breakdown: {},
      version_ladder: [],
      trend: [],
    }
  }
}
