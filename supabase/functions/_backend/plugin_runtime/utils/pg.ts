import type { SQL } from 'drizzle-orm'
import type { Context } from 'hono'
import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { getRuntimeKey } from 'hono/adapter'
// @ts-types="npm:@types/pg"
import { Client, Pool } from 'pg'
import { backgroundTask, existInEnv, getEnv } from '../utils/utils.ts'
import { CacheHelper } from './cache.ts'
import { getChannelSelfOverride, isChannelSelfStoreEnabled } from './channelSelfStore.ts'
import { getClientDbRegionSB } from './geolocation.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { serializePostgresError, serializePostgresLogValue } from './postgres_error.ts'
import * as schema from './postgres_schema.ts'
import { withOptionalManifestSelect } from './queryHelpers.ts'
import { resolveRolloutDecision } from './rollout.ts'
import { shouldRequireReadReplica, shouldSkipDirectHyperdriveFallback } from './supabase_write_guard.ts'

/**
 * Plugin PG client handle. On Hyperdrive (workerd) this is a per-request `Client`;
 * elsewhere it is a short-lived `Pool`.
 *
 * @see https://developers.cloudflare.com/hyperdrive/get-started/
 * @see https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/
 */
export type PluginPgClient = Client | Pool

/** Hyperdrive owns Worker↔origin cleanup; do not call `.end()` on these clients. */
const skipEndClients = new WeakSet<object>()

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
// Scoped per request: awaiting a lag probe started by another request can
// hang once that request's I/O context ends.
const replicationLagInflightByRequest = new WeakMap<Context, Map<string, Promise<ReplicationLagStatus>>>()

function getReplicationLagInflight(c: Context) {
  let inflight = replicationLagInflightByRequest.get(c)
  if (!inflight) {
    inflight = new Map()
    replicationLagInflightByRequest.set(c, inflight)
  }
  return inflight
}

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

export function selectOne(pgClient: PluginPgClient) {
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
async function queryReplicaLag(c: Context, pool: PluginPgClient): Promise<ReplicationLagStatus> {
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

async function getCachedReplicaLag(c: Context, pool: PluginPgClient): Promise<ReplicationLagStatus> {
  const cacheKey = getReplicationLagCacheKey(c)
  const replicationLagInflight = getReplicationLagInflight(c)
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
export async function setReplicationLagHeader(c: Context, pool: PluginPgClient): Promise<void> {
  // Hot path: only use in-memory lag. Cold Cache API / DB probe runs in background
  // so a miss cannot add another Hyperdrive RTT to /updates P999.
  const cacheKey = getReplicationLagCacheKey(c)
  const memoryEntry = getFreshReplicationLagMemoryEntry(cacheKey)
  if (memoryEntry) {
    safeSetResponseHeader(c, 'X-Replication-Lag', memoryEntry.status)
    if (memoryEntry.max_lag_seconds !== null) {
      safeSetResponseHeader(c, 'X-Replication-Lag-Seconds', String(Math.round(memoryEntry.max_lag_seconds)))
    }
    return
  }

  safeSetResponseHeader(c, 'X-Replication-Lag', 'unknown')
  backgroundTask(c, getCachedReplicaLag(c, pool))
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
  return c.env[selectedRoute.binding].connectionString
}

function isLocalWorkerEnv(c: Context): boolean {
  return existInEnv(c, 'ENV_NAME') && getEnv(c, 'ENV_NAME').endsWith('-local')
}

function getLocalReadOnlyDatabaseURL(c: Context): string | null {
  if (!isLocalWorkerEnv(c) || !existInEnv(c, 'LOCAL_READ_REPLICA_SUPABASE_DB_URL'))
    return null

  setDatabaseSource(c, 'local_read_replica')
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
    throw new Error('Read replica is required for this endpoint')
  }

  if (c.env.HYPERDRIVE_CAPGO_DIRECT_EU && !shouldSkipDirectHyperdriveFallback(c)) {
    setDatabaseSource(c, 'HYPERDRIVE_CAPGO_DIRECT_EU')
    return c.env.HYPERDRIVE_CAPGO_DIRECT_EU.connectionString
  }

  if (c.env.HYPERDRIVE_CAPGO_DIRECT_EU) {
  }

  // Main DB write poller EU region in supabase
  if (existInEnv(c, 'MAIN_SUPABASE_DB_URL')) {
    setDatabaseSource(c, 'sb_pooler_main')
    return getEnv(c, 'MAIN_SUPABASE_DB_URL')
  }

  // Default Supabase direct connection used for testing or if no other option is available
  setDatabaseSource(c, 'direct')
  return fixSupabaseHost(getEnv(c, 'SUPABASE_DB_URL'))
}

/** True when dbUrl is one of this Worker's Hyperdrive binding connection strings. */
function isHyperdriveConnectionString(c: Context, dbUrl: string): boolean {
  const env = c.env as Record<string, { connectionString?: string } | undefined> | undefined
  if (!env)
    return false
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('HYPERDRIVE_') || !value?.connectionString)
      continue
    if (value.connectionString === dbUrl)
      return true
  }
  return false
}

/**
 * Create a DB client for this request.
 *
 * Hyperdrive connection lifecycle (explicit Cloudflare contract):
 * @see https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/
 * - New `pg.Client` inside each request. Never create/cache Client/Pool in global scope.
 * - `await client.connect()`, then query.
 * - Do **not** call `client.end()` / `pool.end()`: "Workers-to-Hyperdrive connections
 *   are automatically cleaned up when the request ends"; origin pool stays open.
 *
 * Non-Hyperdrive (local/direct/pooler): `Pool` + explicit `closeClient`/`end()`.
 */
export async function getPgClient(c: Context, readOnly = false): Promise<PluginPgClient> {
  const dbUrl = getDatabaseURL(c, readOnly)
  const requestId = c.get('requestId')
  const appName = c.res.headers.get('X-Worker-Source') ?? 'unknown source'
  const dbName = String(c.get('databaseSource') ?? c.res.headers.get('X-Database-Source') ?? 'unknown source')
  const isPooler = dbName.startsWith('sb_pooler')
  const readOnlyOptions = readOnly && !isPooler ? '-c default_transaction_read_only=on' : undefined
  const isWorkerd = getRuntimeKey() === 'workerd'
  // Match on the actual connection string (not just databaseSource metadata) so the
  // Hyperdrive Client contract cannot silently become Pool+end() if c.set is missed.
  const useHyperdriveClient = isWorkerd && isHyperdriveConnectionString(c, dbUrl)

  if (useHyperdriveClient) {
    const client = new Client({
      connectionString: dbUrl,
      application_name: `${appName}-${dbName}`,
      connectionTimeoutMillis: 10000,
      // PgBouncer/Supabase pooler doesn't support the 'options' startup parameter
      options: readOnlyOptions,
    })
    client.on('error', (err: Error) => {
      cloudlogErr({ requestId, message: 'PG Client Error', databaseSource: dbName, error: serializePostgresError(err) })
    })
    await client.connect()
    skipEndClients.add(client)
    return client
  }

  const pool = new Pool({
    connectionString: dbUrl,
    max: isWorkerd ? 1 : 4,
    application_name: `${appName}-${dbName}`,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 10000,
    maxLifetimeSeconds: 30 * 60,
    // PgBouncer/Supabase pooler doesn't support the 'options' startup parameter
    options: readOnlyOptions,
  })

  pool.on('error', (err: Error) => {
    cloudlogErr({ requestId, message: 'PG Pool Error', databaseSource: dbName, error: serializePostgresError(err) })
  })

  return pool
}

export function getDrizzleClient(db: PluginPgClient, options?: { logger?: boolean }) {
  // Keep SQL logging on by default for API/trigger diagnostics.
  // Plugin hot paths pass `{ logger: false }` to avoid per-request log CPU/volume.
  return drizzle({ client: db, logger: options?.logger ?? true })
}

export function logPgError(
  c: Context,
  functionName: string,
  error: unknown,
  diagnostics: Record<string, unknown> = {},
) {
  const cf = c.req.raw.cf
  const serializedDiagnostics = serializePostgresLogValue(diagnostics)
  const callerDiagnostics = serializedDiagnostics !== null
    && typeof serializedDiagnostics === 'object'
    && !Array.isArray(serializedDiagnostics)
    ? serializedDiagnostics as Record<string, unknown>
    : { context: serializedDiagnostics }

  // This deliberately verbose payload is temporary while investigating the
  // intermittent getAppOwnerPostgres replica/Hyperdrive failure.
  cloudlogErr({
    requestId: c.get('requestId'),
    message: `${functionName} - PostgreSQL Error`,
    error: serializePostgresError(error),
    diagnostics: {
      ...callerDiagnostics,
      version: 1,
      functionName,
      databaseSource: c.get('databaseSource') ?? c.res.headers.get('X-Database-Source') ?? 'unknown',
      workerSource: c.res.headers.get('X-Worker-Source') ?? 'unknown',
      runtime: getRuntimeKey(),
      request: {
        method: c.req.method,
        path: c.req.path,
        rayId: c.req.header('cf-ray') ?? c.get('requestId'),
        userAgent: c.req.header('user-agent'),
        colo: cf?.colo,
        continent: cf?.continent,
        country: cf?.country,
      },
    },
  })
}

export function closeClient(c: Context, db: PluginPgClient) {
  // Hyperdrive: do not end() — connection-lifecycle docs say GC cleans the edge hop.
  // https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/
  if (skipEndClients.has(db))
    return

  // Non-Hyperdrive Pool: must end() or we leak sockets (the old workerd sawtooth).
  return backgroundTask(c, Promise.resolve(db.end()).catch((error: unknown) => {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'PG client end failed',
      error,
    })
  }))
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
    deleted: sql<boolean>`COALESCE(${versionAlias.deleted}, false)`.as(`${prefix}deleted`),
    deleted_at: sql<string | null>`${versionAlias.deleted_at}`.as(`${prefix}deleted_at`),
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
    update_package: channelAlias.update_package,
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
    or(
      and(eq(versionAlias.deleted, false), isNull(versionAlias.deleted_at)),
      eq(versionAlias.name, 'builtin'),
    ),
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
  const channel = channelQuery.then(data => data.at(0))

  return channel
}

const MANIFEST_ROWS_CACHE_PATH = '/.manifest-rows-v1'
// manifest_persist inserts a version's rows once, in the same transaction that
// sets manifest_count, and never rewrites them. A non-empty row set is final and
// safe to keep a day; empty sets are not cached because the insert may land later.
const MANIFEST_ROWS_CACHE_TTL_SECONDS = 86400

interface ManifestRow { file_name: string, file_hash: string, s3_path: string }

export async function requestManifestEntriesPostgres(
  c: Context,
  versionId: number,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<ManifestRow[]> {
  // Cache raw rows by version id (not final download URLs — those embed device_id).
  const helper = new CacheHelper(c)
  const cacheKey = helper.buildRequest(MANIFEST_ROWS_CACHE_PATH, { version_id: String(versionId) })
  const cached = await helper.matchJson<ManifestRow[]>(cacheKey)
  if (cached)
    return cached

  const rows = await drizzleClient
    .select({
      file_name: schema.manifest.file_name,
      file_hash: schema.manifest.file_hash,
      s3_path: schema.manifest.s3_path,
    })
    .from(schema.manifest)
    .where(eq(schema.manifest.app_version_id, versionId))

  // Cache API size limits may reject huge manifests; the put fails open.
  if (rows.length > 0)
    await backgroundTask(c, helper.putJson(cacheKey, rows, MANIFEST_ROWS_CACHE_TTL_SECONDS))
  return rows
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
    const decision = resolveRolloutDecision({
      appId,
      channelId: channelData.channels.id,
      currentVersionName,
      deviceId,
      rolloutEnabled: channelData.channels.rollout_enabled,
      rolloutId: channelData.channels.rollout_id,
      rolloutPausedAt: channelData.channels.rollout_paused_at,
      rolloutPercentageBps: channelData.channels.rollout_percentage_bps,
      rolloutVersionId: rolloutVersion.id,
      rolloutVersionName: rolloutVersion.name,
    })

    if (decision.selected)
      selectedVersion = rolloutVersion

    cloudlog({ requestId: c.get('requestId'), message: 'rollout decision', appId, channelId: channelData.channels.id, selected: decision.selected, reason: decision.reason, bucketBps: decision.bucketBps, percentageBps: decision.percentageBps })
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
  /**
   * When false, skip manifest json_agg / follow-up fetch in channel queries.
   * Used by /updates to avoid loading thousands of files before the up-to-date short-circuit.
   */
  includeManifest?: boolean
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
    includeManifest,
    rolloutChannelCount,
    rolloutPausedVersionNames,
    currentVersionName,
    includeMetadata = false,
    channelSelfOverrideChannelId,
  } = options
  const shouldQueryChannelOverride = channelDeviceCount === undefined || channelDeviceCount === null ? true : channelDeviceCount > 0
  const shouldFetchManifest = includeManifest !== false
    && (manifestBundleCount == null || manifestBundleCount > 0)
  const isPausedRolloutVersion = Array.isArray(rolloutPausedVersionNames) && rolloutPausedVersionNames.includes(currentVersionName)
  const shouldUseRolloutPath = (rolloutChannelCount ?? 0) > 0 || isPausedRolloutVersion

  if (!shouldUseRolloutPath) {
    const runPair = async (
      deviceClient: typeof drizzleClient,
      channelClient: typeof drizzleClient,
    ) => {
      let channelDevice: ReturnType<typeof requestInfosChannelByIdPostgres> | ReturnType<typeof requestInfosChannelDevicePostgres> | Promise<null>

      if (typeof channelSelfOverrideChannelId === 'number') {
        channelDevice = requestInfosChannelByIdPostgres(c, app_id, channelSelfOverrideChannelId, deviceClient, shouldFetchManifest, includeMetadata)
      }
      else if (shouldQueryChannelOverride) {
        channelDevice = requestInfosChannelDevicePostgres(c, app_id, device_id, deviceClient, shouldFetchManifest, includeMetadata)
      }
      else {
        channelDevice = Promise.resolve(null)
      }
      const channel = requestInfosChannelPostgres(c, platform, app_id, defaultChannel, channelClient, shouldFetchManifest, includeMetadata)
      const [channelOverride, channelData] = await Promise.all([channelDevice, channel])
      return { channelData, channelOverride }
    }

    return (async () => {
      try {
        // Single pg.Client serializes queries; use a second Hyperdrive client when
        // both override + default channel are needed so the two RTTs overlap.
        const needsParallelClients = shouldQueryChannelOverride || typeof channelSelfOverrideChannelId === 'number'
        if (needsParallelClients && getRuntimeKey() === 'workerd') {
          try {
            const parallelClient = await getPgClient(c, true)
            try {
              const drizzleParallel = getDrizzleClient(parallelClient, { logger: false })
              return await runPair(drizzleClient, drizzleParallel)
            }
            finally {
              await closeClient(c, parallelClient)
            }
          }
          catch {
            // Latency opt only — fall back to serial queries on the primary client.
          }
        }
        return await runPair(drizzleClient, drizzleClient)
      }
      catch (e) {
        logPgError(c, 'requestInfosPostgres', e)
        throw e
      }
    })()
  }

  let channelDevice: ReturnType<typeof requestInfosChannelByIdPostgresRollout> | ReturnType<typeof requestInfosChannelDevicePostgresRollout> | Promise<null>
  if (typeof channelSelfOverrideChannelId === 'number') {
    channelDevice = requestInfosChannelByIdPostgresRollout(c, app_id, channelSelfOverrideChannelId, drizzleClient, includeMetadata)
  }
  else if (shouldQueryChannelOverride) {
    channelDevice = requestInfosChannelDevicePostgresRollout(c, app_id, device_id, drizzleClient, includeMetadata)
  }
  else {
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
    logPgError(c, 'getAppOwnerPostgres', e, {
      appId,
      planActions: actions,
    })
    return null
  }
}

export type AppBlockProviderInfraRequestsLookup
  = | { status: 'found', blockProviderInfraRequests: boolean }
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
        // Only /channel_self writes here: self-set overrides expire after 90 days
        // without a refresh (cleanup_old_channel_devices), console/API ones never do.
        is_self_set: true,
      })
      .onConflictDoUpdate({
        target: [schema.channel_devices.device_id, schema.channel_devices.app_id],
        set: {
          channel_id: data.channel_id,
          is_self_set: true,
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
