import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { HTTPException } from 'hono/http-exception'
import { Hono } from 'hono/tiny'
import { CacheHelper } from '../utils/cache.ts'
import { escapeSqlString, formatDateCF, runQueryToCFA } from '../utils/cloudflare.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { closeClient, getPgClient, logPgError } from '../utils/pg.ts'
import { checkPermission } from '../utils/rbac.ts'
import { readDeviceVersionCounts } from '../utils/stats.ts'
import { supabaseAdmin } from '../utils/supabase.ts'

// Near-realtime view of a release rollout. Analytics Engine ingests within
// about a minute, so every expensive read sits behind a colo cache keyed per
// app: polling tabs only cost the auth + permission check per request.
// - activity (version_usage + app_log AE queries): 1 minute
// - release candidates (deploy_history + latest bundle): 1 minute
// - adoption (full device_info scan): 5 minutes
const ACTIVITY_CACHE_TTL_SECONDS = 60
const CANDIDATES_CACHE_TTL_SECONDS = 60
const ADOPTION_CACHE_TTL_SECONDS = 300
const ACTIVITY_CACHE_PATH = '/.release-live-activity'
const CANDIDATES_CACHE_PATH = '/.release-live-candidates'
const ADOPTION_CACHE_PATH = '/.release-live-adoption'
const MAX_WINDOW_MS = 72 * 60 * 60 * 1000
const MIN_WINDOW_MS = 15 * 60 * 1000
const MAX_BUCKETS = 90
const BUCKET_MINUTES_OPTIONS = [1, 5, 15, 30, 60] as const
const MAX_FAILURE_ACTIONS = 8
const RECENT_DEPLOYMENTS_LIMIT = 10

interface ReleaseLiveRequest {
  app_id: string
  channel_id?: number
  version_name?: string
}

export interface ReleaseLiveBucket {
  ts: string
  get: number
  install: number
  fail: number
}

export interface ReleaseLiveDeployment {
  version_name: string
  channel_id: number | null
  channel_name: string | null
  deployed_at: string
}

export interface ReleaseLiveResponse {
  release: ReleaseLiveDeployment & { bundle_id: number | null }
  window: {
    start: string
    end: string
    bucket_minutes: number
    truncated: boolean
  }
  totals: {
    get: number
    install: number
    fail: number
    success_rate: number | null
  }
  adoption: {
    devices_on_release: number
    total_devices: number
    percent: number | null
  }
  failures: { action: string, count: number }[]
  series: ReleaseLiveBucket[]
  recent_deployments: ReleaseLiveDeployment[]
  generated_at: string
}

export interface ReleaseLiveEmptyResponse {
  release: null
  recent_deployments: ReleaseLiveDeployment[]
}

interface ResolvedRelease {
  bundle_id: number | null
  version_name: string
  channel_id: number | null
  channel_name: string | null
  deployed_at: string
}

interface RawBucketRow {
  bucket: number | string
  get: number | string | null
  install: number | string | null
  fail: number | string | null
}

interface RawFailureRow {
  action: string
  count: number | string
}

type Relation<T> = T | T[] | null | undefined

function one<T>(value: Relation<T>): T | null {
  if (Array.isArray(value))
    return value[0] ?? null
  return value ?? null
}

function toCount(value: unknown) {
  const numeric = Number(value ?? 0)
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0
}

function computeSuccessRate(install: number, fail: number): number | null {
  const total = install + fail
  if (total <= 0)
    return null
  return Math.round((install / total) * 1000) / 10
}

function pickBucketMinutes(windowMs: number): number {
  for (const minutes of BUCKET_MINUTES_OPTIONS) {
    if (windowMs / (minutes * 60_000) <= MAX_BUCKETS)
      return minutes
  }
  return BUCKET_MINUTES_OPTIONS[BUCKET_MINUTES_OPTIONS.length - 1]
}

function resolveWindow(releaseAt: string, now = new Date()) {
  const nowMs = now.getTime()
  const releaseMs = Date.parse(releaseAt)
  const safeReleaseMs = Number.isFinite(releaseMs) ? Math.min(releaseMs, nowMs) : nowMs - MAX_WINDOW_MS
  const truncated = nowMs - safeReleaseMs > MAX_WINDOW_MS
  const startMs = Math.min(Math.max(safeReleaseMs, nowMs - MAX_WINDOW_MS), nowMs - MIN_WINDOW_MS)
  const bucketMinutes = pickBucketMinutes(nowMs - startMs)
  return {
    startMs,
    endMs: nowMs,
    bucketMinutes,
    truncated,
  }
}

// Buckets are aligned to the Unix epoch on both Analytics Engine
// (toStartOfInterval) and Postgres (date_bin with a 1970 origin).
function fillBuckets(rows: RawBucketRow[], startMs: number, endMs: number, bucketMinutes: number): ReleaseLiveBucket[] {
  const bucketMs = bucketMinutes * 60_000
  const byBucket = new Map<number, RawBucketRow>()
  for (const row of rows) {
    const seconds = Number(row.bucket)
    if (!Number.isFinite(seconds))
      continue
    byBucket.set(seconds * 1000, row)
  }

  const series: ReleaseLiveBucket[] = []
  for (let ts = Math.floor(startMs / bucketMs) * bucketMs; ts < endMs; ts += bucketMs) {
    const row = byBucket.get(ts)
    series.push({
      ts: new Date(ts).toISOString(),
      get: toCount(row?.get),
      install: toCount(row?.install),
      fail: toCount(row?.fail),
    })
  }
  return series
}

function computeAdoption(counts: Record<string, number>, versionName: string) {
  let total = 0
  for (const count of Object.values(counts))
    total += toCount(count)
  const onRelease = toCount(counts[versionName])
  return {
    devices_on_release: onRelease,
    total_devices: total,
    percent: total > 0 ? Math.round((onRelease / total) * 1000) / 10 : null,
  }
}

function buildSeriesQueryCF(appId: string, versionName: string, startMs: number, endMs: number, bucketMinutes: number) {
  return `SELECT
  toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '${bucketMinutes}' MINUTE)) AS bucket,
  sum(if(blob3 = 'get', 1, 0)) AS get,
  sum(if(blob3 = 'install', 1, 0)) AS install,
  sum(if(blob3 = 'fail', 1, 0)) AS fail
FROM version_usage
WHERE
  index1 = '${escapeSqlString(appId)}'
  AND blob2 = '${escapeSqlString(versionName)}'
  AND timestamp >= toDateTime('${formatDateCF(new Date(startMs))}')
  AND timestamp < toDateTime('${formatDateCF(new Date(endMs))}')
GROUP BY bucket
ORDER BY bucket`
}

function buildFailuresQueryCF(appId: string, versionName: string, startMs: number, endMs: number) {
  return `SELECT
  blob2 AS action,
  count() AS count
FROM app_log
WHERE
  index1 = '${escapeSqlString(appId)}'
  AND blob3 = '${escapeSqlString(versionName)}'
  AND blob2 LIKE '%fail%'
  AND timestamp >= toDateTime('${formatDateCF(new Date(startMs))}')
  AND timestamp < toDateTime('${formatDateCF(new Date(endMs))}')
GROUP BY action
ORDER BY count DESC
LIMIT ${MAX_FAILURE_ACTIONS}`
}

async function readActivityCF(c: Context, appId: string, versionName: string, startMs: number, endMs: number, bucketMinutes: number) {
  const [seriesRows, failureRows] = await Promise.all([
    c.env.VERSION_USAGE
      ? runQueryToCFA<RawBucketRow>(c, buildSeriesQueryCF(appId, versionName, startMs, endMs, bucketMinutes))
      : Promise.resolve([] as RawBucketRow[]),
    c.env.APP_LOG
      ? runQueryToCFA<RawFailureRow>(c, buildFailuresQueryCF(appId, versionName, startMs, endMs))
          .catch((error) => {
            // Failure breakdown is a nice-to-have; never fail the whole view on it.
            cloudlogErr({ requestId: c.get('requestId'), message: 'release_live failures query failed', error: serializeError(error) })
            return [] as RawFailureRow[]
          })
      : Promise.resolve([] as RawFailureRow[]),
  ])
  return { seriesRows, failureRows }
}

async function readActivitySB(c: Context, appId: string, versionName: string, startMs: number, endMs: number, bucketMinutes: number) {
  const db = getPgClient(c, true)
  try {
    const start = new Date(startMs).toISOString()
    const end = new Date(endMs).toISOString()
    const [series, failures] = await Promise.all([
      db.query<RawBucketRow>(
        `SELECT
  extract(epoch FROM date_bin(make_interval(mins => $5::int), vu.timestamp, TIMESTAMP '1970-01-01'))::bigint AS bucket,
  count(*) FILTER (WHERE vu.action = 'get') AS get,
  count(*) FILTER (WHERE vu.action = 'install') AS install,
  count(*) FILTER (WHERE vu.action = 'fail') AS fail
FROM public.version_usage vu
WHERE vu.app_id = $1
  AND vu.version_name = $2
  AND vu.timestamp >= ($3::timestamptz AT TIME ZONE 'UTC')
  AND vu.timestamp < ($4::timestamptz AT TIME ZONE 'UTC')
GROUP BY bucket
ORDER BY bucket`,
        [appId, versionName, start, end, bucketMinutes],
      ),
      db.query<RawFailureRow>(
        `SELECT s.action::text AS action, count(*) AS count
FROM public.stats s
WHERE s.app_id = $1
  AND s.version_name = $2
  AND s.created_at >= $3::timestamptz
  AND s.created_at < $4::timestamptz
  AND s.action::text LIKE '%fail%'
GROUP BY s.action
ORDER BY count DESC
LIMIT ${MAX_FAILURE_ACTIONS}`,
        [appId, versionName, start, end],
      ),
    ])
    return { seriesRows: series.rows, failureRows: failures.rows }
  }
  catch (error) {
    logPgError(c, 'release_live readActivitySB', error)
    throw error
  }
  finally {
    await closeClient(c, db)
  }
}

interface ReleaseCandidates {
  deployments: ResolvedRelease[]
  latest_bundle: ResolvedRelease | null
}

function cacheBucket(ttlSeconds: number, nowMs = Date.now()) {
  return String(Math.floor(nowMs / (ttlSeconds * 1000)))
}

// Candidates are identical for every user allowed to read the app, so they are
// read with the admin client (after checkPermission) and shared through the cache.
async function loadReleaseCandidates(c: Context<MiddlewareKeyVariables>, appId: string): Promise<ReleaseCandidates> {
  const cache = new CacheHelper(c)
  const cacheKey = cache.buildRequest(CANDIDATES_CACHE_PATH, { appId, bucket: cacheBucket(CANDIDATES_CACHE_TTL_SECONDS) })
  const cached = await cache.matchJson<ReleaseCandidates>(cacheKey)
  if (cached)
    return cached

  const supabase = supabaseAdmin(c)
  const [{ data: deployRows, error: deployError }, { data: versions, error: versionError }] = await Promise.all([
    supabase
      .from('deploy_history')
      .select('deployed_at, channel_id, channels(name), app_versions(id, name)')
      .eq('app_id', appId)
      .order('deployed_at', { ascending: false })
      .limit(50),
    supabase
      .from('app_versions')
      .select('id, name, created_at')
      .eq('app_id', appId)
      .eq('deleted', false)
      .not('name', 'in', '("builtin","unknown")')
      .order('created_at', { ascending: false })
      .limit(1),
  ])
  if (deployError || versionError) {
    cloudlog({ requestId: c.get('requestId'), message: 'release_live candidates error', deployError, versionError })
    throw simpleError('fetch_error', 'Failed to fetch deployment history')
  }

  const deployments = (deployRows ?? []).flatMap((row) => {
    const version = one(row.app_versions as Relation<{ id: number, name: string }>)
    const channel = one(row.channels as Relation<{ name: string }>)
    if (!version?.name || !row.deployed_at)
      return []
    return [{
      bundle_id: version.id,
      version_name: version.name,
      channel_id: row.channel_id,
      channel_name: channel?.name ?? null,
      deployed_at: row.deployed_at,
    } satisfies ResolvedRelease]
  })

  const version = versions?.[0]
  const candidates: ReleaseCandidates = {
    deployments,
    latest_bundle: version?.name && version.created_at
      ? {
          bundle_id: version.id,
          version_name: version.name,
          channel_id: null,
          channel_name: null,
          deployed_at: version.created_at,
        }
      : null,
  }
  await cache.putJson(cacheKey, candidates, CANDIDATES_CACHE_TTL_SECONDS)
  return candidates
}

function pickRelease(candidates: ReleaseCandidates, channelId?: number, versionName?: string): ResolvedRelease | null {
  const { deployments, latest_bundle: latestBundle } = candidates
  let release: ResolvedRelease | null
  if (channelId && versionName)
    release = deployments.find(d => d.channel_id === channelId && d.version_name === versionName) ?? null
  else if (channelId)
    release = deployments.find(d => d.channel_id === channelId) ?? null
  else if (versionName)
    release = deployments.find(d => d.version_name === versionName) ?? null
  else
    release = deployments[0] ?? null

  if (release || channelId)
    return release
  // Bundle never deployed through a channel (or history pruned): fall back to
  // the bundle upload time so the page still shows its activity.
  if (latestBundle && (!versionName || latestBundle.version_name === versionName))
    return latestBundle
  return null
}

async function readAdoption(c: Context<MiddlewareKeyVariables>, appId: string) {
  const cache = new CacheHelper(c)
  const cacheKey = cache.buildRequest(ADOPTION_CACHE_PATH, { appId, bucket: cacheBucket(ADOPTION_CACHE_TTL_SECONDS) })
  const cached = await cache.matchJson<Record<string, number>>(cacheKey)
  if (cached)
    return cached
  try {
    const counts = await readDeviceVersionCounts(c, appId)
    await cache.putJson(cacheKey, counts, ADOPTION_CACHE_TTL_SECONDS)
    return counts
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'release_live device counts failed', error: serializeError(error) })
    return {} as Record<string, number>
  }
}

async function readReleaseLive(
  c: Context<MiddlewareKeyVariables>,
  appId: string,
  channelId?: number,
  versionName?: string,
): Promise<ReleaseLiveResponse | ReleaseLiveEmptyResponse> {
  const candidates = await loadReleaseCandidates(c, appId)
  const release = pickRelease(candidates, channelId, versionName)
  const recent = candidates.deployments
    .slice(0, RECENT_DEPLOYMENTS_LIMIT)
    .map(({ bundle_id: _bundleId, ...rest }) => rest)
  if (!release)
    return { release: null, recent_deployments: recent }

  const now = new Date()
  const window = resolveWindow(release.deployed_at, now)
  const cache = new CacheHelper(c)
  const cacheKey = cache.buildRequest(ACTIVITY_CACHE_PATH, {
    appId,
    version: release.version_name,
    since: release.deployed_at,
    bucket: cacheBucket(ACTIVITY_CACHE_TTL_SECONDS, now.getTime()),
  })
  const cached = await cache.matchJson<Omit<ReleaseLiveResponse, 'release' | 'recent_deployments'>>(cacheKey)
  if (cached)
    return { ...cached, release, recent_deployments: recent }

  // No Postgres fallback when Analytics Engine is bound: if AE is down, every
  // polling tab would otherwise move its load onto the database. The client
  // keeps showing its last snapshot and retries on the next poll.
  const [activity, deviceCounts] = await Promise.all([
    c.env.VERSION_USAGE
      ? readActivityCF(c, appId, release.version_name, window.startMs, window.endMs, window.bucketMinutes)
      : readActivitySB(c, appId, release.version_name, window.startMs, window.endMs, window.bucketMinutes),
    readAdoption(c, appId),
  ])

  const series = fillBuckets(activity.seriesRows, window.startMs, window.endMs, window.bucketMinutes)
  const totals = series.reduce((acc, bucket) => {
    acc.get += bucket.get
    acc.install += bucket.install
    acc.fail += bucket.fail
    return acc
  }, { get: 0, install: 0, fail: 0 })

  const payload: Omit<ReleaseLiveResponse, 'release' | 'recent_deployments'> = {
    window: {
      start: new Date(window.startMs).toISOString(),
      end: new Date(window.endMs).toISOString(),
      bucket_minutes: window.bucketMinutes,
      truncated: window.truncated,
    },
    totals: {
      ...totals,
      success_rate: computeSuccessRate(totals.install, totals.fail),
    },
    adoption: computeAdoption(deviceCounts, release.version_name),
    failures: activity.failureRows
      .map(row => ({ action: String(row.action), count: toCount(row.count) }))
      .filter(row => row.count > 0),
    series,
    generated_at: now.toISOString(),
  }

  await cache.putJson(cacheKey, payload, ACTIVITY_CACHE_TTL_SECONDS)
  return { ...payload, release, recent_deployments: recent }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<ReleaseLiveRequest>(c)
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.app_id !== 'string' || !body.app_id.trim())
    throw simpleError('missing_params', 'app_id is required')

  const appId = body.app_id.trim()
  if (!(await checkPermission(c, 'app.read', { appId })))
    throw simpleError('app_access_denied', 'You can\'t access this app', { app_id: appId })

  const channelId = typeof body.channel_id === 'number' && Number.isFinite(body.channel_id)
    ? body.channel_id
    : undefined
  const versionName = typeof body.version_name === 'string' && body.version_name.trim()
    ? body.version_name.trim()
    : undefined

  try {
    return c.json(await readReleaseLive(c, appId, channelId, versionName))
  }
  catch (error) {
    if (error instanceof HTTPException)
      throw error
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error fetching release live stats', error: serializeError(error) })
    throw simpleError('fetch_error', 'Failed to fetch release live statistics')
  }
})

export const releaseLiveTestUtils = {
  pickRelease,
  pickBucketMinutes,
  resolveWindow,
  fillBuckets,
  computeAdoption,
  computeSuccessRate,
  buildSeriesQueryCF,
  buildFailuresQueryCF,
}
