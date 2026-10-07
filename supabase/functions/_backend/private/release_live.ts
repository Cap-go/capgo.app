import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { VersionUsageChannel } from '../utils/types.ts'
import { HTTPException } from 'hono/http-exception'
import { Hono } from 'hono/tiny'
import { CacheHelper } from '../utils/cache.ts'
import { buildVersionUsageChannelFilterCF, escapeSqlString, formatDateCF, PUBLIC_FAILURE_ACTIONS, runQueryToCFA } from '../utils/cloudflare.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { closeClient, getPgClient, logPgError } from '../utils/pg.ts'
import { checkPermission } from '../utils/rbac.ts'
import { readDeviceVersionCounts } from '../utils/stats.ts'
import { supabaseAdmin } from '../utils/supabase.ts'

// Near-realtime view of a release rollout on one channel. Every number is
// scoped to that channel (the app's default channel unless the request names
// another one). Analytics Engine ingests within about a minute, so every
// expensive read sits behind a colo cache keyed per app + channel: polling tabs
// only cost the auth + permission check per request.
// - activity (version_usage + app_log AE queries): 1 minute
// - release candidates (channels + deploy_history): 1 minute
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
const DEPLOY_HISTORY_LIMIT = 100
const INTERNAL_VERSION_NAMES = new Set(['builtin', 'unknown'])

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

export interface ReleaseLiveChannel {
  id: number
  name: string
  is_default: boolean
}

interface ReleaseLiveChannelContext {
  channel: ReleaseLiveChannel | null
  channels: ReleaseLiveChannel[]
  recent_deployments: ReleaseLiveDeployment[]
}

export interface ReleaseLiveResponse extends ReleaseLiveChannelContext {
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
  // Distinct devices that reported a bundle-level failure for this release.
  // recovered = installed it (set) after their first failure, stuck = not yet.
  // null when the breakdown could not be read.
  failed_devices: ReleaseLiveFailedDevices | null
  series: ReleaseLiveBucket[]
  // Set when the release is the target of a progressive rollout on the
  // channel: the target only reaches a share of devices, so raw adoption
  // against every device would always look low.
  rollout: ReleaseLiveRollout | null
  generated_at: string
}

export type ReleaseLiveRolloutStatus = 'running' | 'paused' | 'zero'

export interface ReleaseLiveRollout {
  target_version: string
  fallback_version: string | null
  fallback_bundle_id: number | null
  // Share of the channel's devices the target is served to, 0-100.
  percentage: number
  status: ReleaseLiveRolloutStatus
  paused_at: string | null
  pause_reason: string | null
  devices_on_target: number
  devices_on_fallback: number
  total_devices: number
  // Devices the target should reach at this percentage.
  expected_on_target: number
  // devices_on_target / expected_on_target, capped at 100. null without devices.
  reach_percent: number | null
  // Same window, same channel, for the fallback bundle: the baseline the
  // target's success rate is compared to.
  fallback_totals: {
    install: number
    fail: number
    success_rate: number | null
  } | null
}

export interface ReleaseLiveFailedDevices {
  total: number
  recovered: number
  stuck: number
}

export interface ReleaseLiveEmptyResponse extends ReleaseLiveChannelContext {
  release: null
}

type ReleaseLiveActivity = Omit<ReleaseLiveResponse, 'release' | keyof ReleaseLiveChannelContext>

interface ResolvedRelease {
  bundle_id: number | null
  version_name: string
  channel_id: number | null
  channel_name: string | null
  deployed_at: string
}

type RawCount = number | string | null

interface RawBucketRow {
  bucket: number | string
  get: RawCount
  install: RawCount
  fail: RawCount
}

interface RawFailureRow {
  action: string
  count: number | string
}

interface RawFailedDevicesRow {
  recovered: RawCount
  stuck: RawCount
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
  return BUCKET_MINUTES_OPTIONS.at(-1) ?? 60
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

function rolloutStatus(rollout: CandidateRollout): ReleaseLiveRolloutStatus {
  if (rollout.paused_at)
    return 'paused'
  return rollout.percentage_bps > 0 ? 'running' : 'zero'
}

function computeRollout(
  rollout: CandidateRollout,
  fallback: ResolvedRelease | null,
  counts: Record<string, number>,
  fallbackTotals: { install: number, fail: number } | null,
): ReleaseLiveRollout {
  let total = 0
  for (const count of Object.values(counts))
    total += toCount(count)
  const onTarget = toCount(counts[rollout.target.version_name])
  const onFallback = fallback ? toCount(counts[fallback.version_name]) : 0
  const percentage = Math.min(100, Math.max(0, rollout.percentage_bps / 100))
  const expected = Math.round(total * percentage / 100)
  return {
    target_version: rollout.target.version_name,
    fallback_version: fallback?.version_name ?? null,
    fallback_bundle_id: fallback?.bundle_id ?? null,
    percentage,
    status: rolloutStatus(rollout),
    paused_at: rollout.paused_at,
    pause_reason: rollout.pause_reason,
    devices_on_target: onTarget,
    devices_on_fallback: onFallback,
    total_devices: total,
    expected_on_target: expected,
    reach_percent: expected > 0 ? Math.min(100, Math.round((onTarget / expected) * 1000) / 10) : null,
    fallback_totals: fallbackTotals
      ? { ...fallbackTotals, success_rate: computeSuccessRate(fallbackTotals.install, fallbackTotals.fail) }
      : null,
  }
}

function buildSeriesQueryCF(appId: string, versionName: string, startMs: number, endMs: number, bucketMinutes: number, channel?: VersionUsageChannel) {
  // Older `get` rows carry no channel; keep them so a channel view does not lose
  // them while they age out (the release window is at most 72h).
  const channelFilter = buildVersionUsageChannelFilterCF(channel, { includeUnattributedGets: true })
  return `SELECT
  toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '${bucketMinutes}' MINUTE)) AS bucket,
  sum(if(blob3 = 'get', _sample_interval, 0)) AS get,
  sum(if(blob3 = 'install', _sample_interval, 0)) AS install,
  sum(if(blob3 = 'fail', _sample_interval, 0)) AS fail
FROM version_usage
WHERE
  index1 = '${escapeSqlString(appId)}'
  AND blob2 = '${escapeSqlString(versionName)}'
  AND timestamp >= toDateTime('${formatDateCF(new Date(startMs))}')
  AND timestamp < toDateTime('${formatDateCF(new Date(endMs))}')
  ${channelFilter}
GROUP BY bucket
ORDER BY bucket`
}

// app_log failure rows carry the channel in blob8 (name) and blob9 (id). Rows
// written before that have neither and stay out of a channel view.
function buildFailureChannelFilterCF(channel: VersionUsageChannel) {
  const channelId = channel.id ? escapeSqlString(String(channel.id)) : ''
  const channelName = channel.name ? escapeSqlString(channel.name) : ''
  if (channelId && channelName)
    return `AND (blob9 = '${channelId}' OR (blob9 = '' AND blob8 = '${channelName}'))`
  if (channelId)
    return `AND blob9 = '${channelId}'`
  if (channelName)
    return `AND blob8 = '${channelName}'`
  return ''
}

function buildFailuresQueryCF(appId: string, versionName: string, startMs: number, endMs: number, channel: VersionUsageChannel) {
  return `SELECT
  blob2 AS action,
  sum(_sample_interval) AS count
FROM app_log
WHERE
  index1 = '${escapeSqlString(appId)}'
  AND blob3 = '${escapeSqlString(versionName)}'
  AND blob2 LIKE '%fail%'
  AND timestamp >= toDateTime('${formatDateCF(new Date(startMs))}')
  AND timestamp < toDateTime('${formatDateCF(new Date(endMs))}')
  ${buildFailureChannelFilterCF(channel)}
GROUP BY action
ORDER BY count DESC
LIMIT ${MAX_FAILURE_ACTIONS}`
}

// Per-device outcome after a failure: did the device install the release
// (`set`) at or after its first bundle-level failure? `set` logs carry no
// channel, so only the failure side is channel scoped; the set side only needs
// to match the same device and version. File-level failures ("1.2.3:main.js")
// never match the exact version name. Timestamps are compared in whole seconds
// (Analytics Engine precision): a set in the same second as the first failure
// counts as recovered.
const NO_FAILURE_TS = 4102444800 // 2100-01-01, sentinel for "no failure"
// Bundle failures are every `*_fail` action plus these, as in the public metrics.
const EXTRA_FAILURE_ACTIONS: string[] = PUBLIC_FAILURE_ACTIONS.filter(action => !action.endsWith('_fail'))
const EXTRA_FAILURE_ACTIONS_CF = EXTRA_FAILURE_ACTIONS.map(action => `'${escapeSqlString(action)}'`).join(', ')

function buildFailedDevicesQueryCF(appId: string, versionName: string, startMs: number, endMs: number, channel: VersionUsageChannel) {
  return `SELECT
  sum(if(last_set >= first_fail, 1, 0)) AS recovered,
  sum(if(last_set >= first_fail, 0, 1)) AS stuck
FROM (
  SELECT
    blob1 AS device_id,
    min(if(blob2 = 'set', ${NO_FAILURE_TS}, toUnixTimestamp(timestamp))) AS first_fail,
    max(if(blob2 = 'set', toUnixTimestamp(timestamp), 0)) AS last_set
  FROM app_log
  WHERE
    index1 = '${escapeSqlString(appId)}'
    AND blob3 = '${escapeSqlString(versionName)}'
    AND timestamp >= toDateTime('${formatDateCF(new Date(startMs))}')
    AND timestamp < toDateTime('${formatDateCF(new Date(endMs))}')
    AND (blob2 = 'set' OR ((blob2 LIKE '%_fail' OR blob2 IN (${EXTRA_FAILURE_ACTIONS_CF})) ${buildFailureChannelFilterCF(channel)}))
  GROUP BY device_id
)
WHERE first_fail < ${NO_FAILURE_TS}`
}

// Postgres fallback of buildFailedDevicesQueryCF: same failure set, same
// failure-only channel scope, and whole seconds like Analytics Engine.
// $1 app, $2 version, $3/$4 window, $5 channel name, $6 EXTRA_FAILURE_ACTIONS.
const FAILED_DEVICES_QUERY_SB = String.raw`SELECT
  count(*) FILTER (WHERE d.last_set >= d.first_fail) AS recovered,
  count(*) FILTER (WHERE d.last_set IS NULL OR d.last_set < d.first_fail) AS stuck
FROM (
  SELECT
    s.device_id,
    min(date_trunc('second', s.created_at)) FILTER (WHERE s.action <> 'set') AS first_fail,
    max(date_trunc('second', s.created_at)) FILTER (WHERE s.action = 'set') AS last_set
  FROM public.stats s
  WHERE s.app_id = $1
    AND s.version_name = $2
    AND s.created_at >= $3::timestamptz
    AND s.created_at < $4::timestamptz
    AND (
      s.action = 'set'
      OR (
        (s.action::text LIKE '%\_fail' OR s.action::text = ANY($6::text[]))
        AND EXISTS (
          SELECT 1 FROM public.devices dv
          WHERE dv.app_id = s.app_id
            AND dv.device_id = s.device_id
            AND dv.default_channel = $5::text
        )
      )
    )
  GROUP BY s.device_id
) d
WHERE d.first_fail IS NOT NULL`

function toFailedDevices(rows: RawFailedDevicesRow[] | null): ReleaseLiveFailedDevices | null {
  if (!rows)
    return null
  const recovered = toCount(rows[0]?.recovered)
  const stuck = toCount(rows[0]?.stuck)
  return { total: recovered + stuck, recovered, stuck }
}

async function readActivityCF(c: Context, appId: string, versionName: string, startMs: number, endMs: number, bucketMinutes: number, channel: VersionUsageChannel) {
  const [seriesRows, failureRows, failedDeviceRows] = await Promise.all([
    c.env.VERSION_USAGE
      ? runQueryToCFA<RawBucketRow>(c, buildSeriesQueryCF(appId, versionName, startMs, endMs, bucketMinutes, channel))
      : Promise.resolve([] as RawBucketRow[]),
    c.env.APP_LOG
      ? runQueryToCFA<RawFailureRow>(c, buildFailuresQueryCF(appId, versionName, startMs, endMs, channel))
          .catch((error) => {
            // Failure breakdown is a nice-to-have; never fail the whole view on it.
            cloudlogErr({ requestId: c.get('requestId'), message: 'release_live failures query failed', error: serializeError(error) })
            return [] as RawFailureRow[]
          })
      : Promise.resolve([] as RawFailureRow[]),
    c.env.APP_LOG
      ? runQueryToCFA<RawFailedDevicesRow>(c, buildFailedDevicesQueryCF(appId, versionName, startMs, endMs, channel))
          .catch((error) => {
            cloudlogErr({ requestId: c.get('requestId'), message: 'release_live failed devices query failed', error: serializeError(error) })
            return null
          })
      : Promise.resolve(null),
  ])
  return { seriesRows, failureRows, failedDevices: toFailedDevices(failedDeviceRows) }
}

async function readActivitySB(c: Context, appId: string, versionName: string, startMs: number, endMs: number, bucketMinutes: number, channel: VersionUsageChannel) {
  const db = getPgClient(c, true)
  try {
    const start = new Date(startMs).toISOString()
    const end = new Date(endMs).toISOString()
    const [series, failures, failedDevices] = await Promise.all([
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
  AND (
    vu.channel_id = $6::bigint
    OR (vu.channel_id IS NULL AND vu.channel_name = $7::text)
    OR (vu.action = 'get' AND vu.channel_id IS NULL AND vu.channel_name IS NULL)
  )
GROUP BY bucket
ORDER BY bucket`,
        [appId, versionName, start, end, bucketMinutes, channel.id ?? null, channel.name ?? null],
      ),
      db.query<RawFailureRow>(
        `SELECT s.action::text AS action, count(*) AS count
FROM public.stats s
WHERE s.app_id = $1
  AND s.version_name = $2
  AND s.created_at >= $3::timestamptz
  AND s.created_at < $4::timestamptz
  AND s.action::text LIKE '%fail%'
  AND EXISTS (
    SELECT 1 FROM public.devices d
    WHERE d.app_id = s.app_id
      AND d.device_id = s.device_id
      AND d.default_channel = $5::text
  )
GROUP BY s.action
ORDER BY count DESC
LIMIT ${MAX_FAILURE_ACTIONS}`,
        [appId, versionName, start, end, channel.name ?? ''],
      ),
      // Optional breakdown: never fail the whole view on it. Only failures are
      // channel scoped, matching the Analytics Engine query.
      db.query<RawFailedDevicesRow>(
        FAILED_DEVICES_QUERY_SB,
        [appId, versionName, start, end, channel.name ?? '', EXTRA_FAILURE_ACTIONS],
      ).catch((error) => {
        logPgError(c, 'release_live failed devices', error)
        return null
      }),
    ])
    return { seriesRows: series.rows, failureRows: failures.rows, failedDevices: toFailedDevices(failedDevices?.rows ?? null) }
  }
  catch (error) {
    logPgError(c, 'release_live readActivitySB', error)
    throw error
  }
  finally {
    await closeClient(c, db)
  }
}

interface CandidateRollout {
  // Rollout target; deployed_at is its upload time (rollouts have no start
  // timestamp, and the live window is capped anyway).
  target: ResolvedRelease
  percentage_bps: number
  paused_at: string | null
  pause_reason: string | null
}

interface CandidateChannel {
  id: number
  name: string
  public: boolean
  // Bundle the channel currently serves, used when deploy history has no row.
  // During a progressive rollout this is the stable fallback.
  current: ResolvedRelease | null
  rollout: CandidateRollout | null
}

interface ReleaseCandidates {
  channels: CandidateChannel[]
  deployments: ResolvedRelease[]
}

function cacheBucket(ttlSeconds: number, nowMs = Date.now()) {
  return String(Math.floor(nowMs / (ttlSeconds * 1000)))
}

// Candidates are identical for every user allowed to read the app, so they are
// read with the admin client (after checkPermission) and shared through the cache.
async function loadReleaseCandidates(c: Context<MiddlewareKeyVariables>, appId: string): Promise<ReleaseCandidates> {
  const cache = new CacheHelper(c)
  const cacheKey = cache.buildRequest(CANDIDATES_CACHE_PATH, { appId, v: '3', bucket: cacheBucket(CANDIDATES_CACHE_TTL_SECONDS) })
  const cached = await cache.matchJson<ReleaseCandidates>(cacheKey)
  if (cached)
    return cached

  const supabase = supabaseAdmin(c)
  const [{ data: channelRows, error: channelError }, { data: deployRows, error: deployError }] = await Promise.all([
    supabase
      .from('channels')
      .select('id, name, public, rollout_enabled, rollout_percentage_bps, rollout_paused_at, rollout_pause_reason, version:app_versions!channels_version_fkey(id, name, created_at), rollout_version_info:app_versions!channels_rollout_version_fkey(id, name, created_at)')
      .eq('app_id', appId)
      .order('name', { ascending: true })
      .order('id', { ascending: true }),
    supabase
      .from('deploy_history')
      .select('deployed_at, channel_id, channels(name), app_versions(id, name)')
      .eq('app_id', appId)
      .order('deployed_at', { ascending: false })
      .limit(DEPLOY_HISTORY_LIMIT),
  ])
  if (channelError || deployError) {
    cloudlog({ requestId: c.get('requestId'), message: 'release_live candidates error', channelError, deployError })
    throw simpleError('fetch_error', 'Failed to fetch deployment history')
  }

  const channels = (channelRows ?? []).map((row) => {
    const version = one(row.version as Relation<{ id: number, name: string, created_at: string | null }>)
    const current = version?.name && version.created_at && !INTERNAL_VERSION_NAMES.has(version.name)
      ? {
        bundle_id: version.id,
        version_name: version.name,
        channel_id: row.id,
        channel_name: row.name,
        deployed_at: version.created_at,
      } satisfies ResolvedRelease
      : null
    const rolloutVersion = one(row.rollout_version_info as Relation<{ id: number, name: string, created_at: string | null }>)
    const rollout = row.rollout_enabled && rolloutVersion?.name && rolloutVersion.created_at && !INTERNAL_VERSION_NAMES.has(rolloutVersion.name)
      ? {
        target: {
          bundle_id: rolloutVersion.id,
          version_name: rolloutVersion.name,
          channel_id: row.id,
          channel_name: row.name,
          deployed_at: rolloutVersion.created_at,
        },
        percentage_bps: toCount(row.rollout_percentage_bps),
        paused_at: row.rollout_paused_at ?? null,
        pause_reason: row.rollout_pause_reason ?? null,
      } satisfies CandidateRollout
      : null
    return { id: row.id, name: row.name, public: row.public, current, rollout } satisfies CandidateChannel
  })

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

  const candidates: ReleaseCandidates = { channels, deployments }
  await cache.putJson(cacheKey, candidates, CANDIDATES_CACHE_TTL_SECONDS)
  return candidates
}

// Default channel: the first public channel in the same order devices use
// (name, then id). Apps without a public channel fall back to the channel with
// the latest deployment, then to the first channel.
function pickDefaultChannel(candidates: ReleaseCandidates): CandidateChannel | null {
  const { channels, deployments } = candidates
  const publicChannel = channels.find(channel => channel.public)
  if (publicChannel)
    return publicChannel
  for (const deployment of deployments) {
    const channel = channels.find(item => item.id === deployment.channel_id)
    if (channel)
      return channel
  }
  return channels[0] ?? null
}

// An explicit channel wins. A version-only request (release banner) opens the
// default channel when that version was deployed there, otherwise the channel
// that received it last.
function pickChannel(candidates: ReleaseCandidates, channelId?: number, versionName?: string): CandidateChannel | null {
  const { channels, deployments } = candidates
  if (channelId) {
    const requested = channels.find(channel => channel.id === channelId)
    if (requested)
      return requested
  }
  const defaultChannel = pickDefaultChannel(candidates)
  if (!versionName)
    return defaultChannel
  const onVersion = deployments.filter(deployment => deployment.version_name === versionName)
  if (defaultChannel && (onVersion.some(deployment => deployment.channel_id === defaultChannel.id) || defaultChannel.current?.version_name === versionName))
    return defaultChannel
  for (const deployment of onVersion) {
    const channel = channels.find(item => item.id === deployment.channel_id)
    if (channel)
      return channel
  }
  return channels.find(channel => channel.current?.version_name === versionName) ?? defaultChannel
}

function pickRelease(candidates: ReleaseCandidates, channel: CandidateChannel, versionName?: string): ResolvedRelease | null {
  // A progressive rollout is the release in flight on the channel: watch its
  // target unless another bundle is named explicitly.
  const rolloutTarget = channel.rollout?.target
  if (rolloutTarget && (!versionName || versionName === rolloutTarget.version_name))
    return { ...rolloutTarget, channel_name: channel.name }
  const onChannel = candidates.deployments.filter(deployment => deployment.channel_id === channel.id)
  const release = versionName
    ? onChannel.find(deployment => deployment.version_name === versionName)
    : onChannel[0]
  if (release)
    return { ...release, channel_name: channel.name }
  // Deploy history pruned or never recorded: fall back to the bundle the
  // channel serves right now, timed from its upload.
  if (channel.current && (!versionName || channel.current.version_name === versionName))
    return channel.current
  return null
}

// Bundle named explicitly but never deployed on the channel (or history
// pruned): show its activity on the channel since its upload.
// Cached per app + version.
async function loadNamedBundle(c: Context<MiddlewareKeyVariables>, appId: string, versionName: string, channel: CandidateChannel): Promise<ResolvedRelease | null> {
  const cache = new CacheHelper(c)
  const cacheKey = cache.buildRequest(CANDIDATES_CACHE_PATH, { appId, version: versionName, bucket: cacheBucket(CANDIDATES_CACHE_TTL_SECONDS) })
  const cached = await cache.matchJson<{ bundle: ResolvedRelease | null }>(cacheKey)
  if (cached)
    return cached.bundle ? { ...cached.bundle, channel_id: channel.id, channel_name: channel.name } : null

  const { data, error } = await supabaseAdmin(c)
    .from('app_versions')
    .select('id, name, created_at')
    .eq('app_id', appId)
    .eq('name', versionName)
    .eq('deleted', false)
    .not('name', 'in', '("builtin","unknown")')
    .limit(1)
  if (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'release_live named bundle error', error })
    throw simpleError('fetch_error', 'Failed to fetch bundle')
  }

  const version = data?.[0]
  const bundle: ResolvedRelease | null = version?.name && version.created_at
    ? {
        bundle_id: version.id,
        version_name: version.name,
        channel_id: null,
        channel_name: null,
        deployed_at: version.created_at,
      }
    : null
  await cache.putJson(cacheKey, { bundle }, CANDIDATES_CACHE_TTL_SECONDS)
  return bundle ? { ...bundle, channel_id: channel.id, channel_name: channel.name } : null
}

async function readAdoption(c: Context<MiddlewareKeyVariables>, appId: string, channel: VersionUsageChannel) {
  const cache = new CacheHelper(c)
  const cacheKey = cache.buildRequest(ADOPTION_CACHE_PATH, {
    appId,
    channelId: String(channel.id ?? ''),
    channelName: channel.name ?? '',
    bucket: cacheBucket(ADOPTION_CACHE_TTL_SECONDS),
  })
  const cached = await cache.matchJson<Record<string, number>>(cacheKey)
  if (cached)
    return cached
  try {
    const counts = await readDeviceVersionCounts(c, appId, channel)
    await cache.putJson(cacheKey, counts, ADOPTION_CACHE_TTL_SECONDS)
    return counts
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'release_live device counts failed', error: serializeError(error) })
    return {} as Record<string, number>
  }
}

function toChannelContext(candidates: ReleaseCandidates, channel: CandidateChannel | null): ReleaseLiveChannelContext {
  const defaultChannel = pickDefaultChannel(candidates)
  return {
    channel: channel ? { id: channel.id, name: channel.name, is_default: channel.id === defaultChannel?.id } : null,
    channels: candidates.channels.map(item => ({ id: item.id, name: item.name, is_default: item.id === defaultChannel?.id })),
    recent_deployments: channel
      ? [
          ...(channel.rollout ? [channel.rollout.target] : []),
          ...candidates.deployments.filter(deployment => deployment.channel_id === channel.id),
        ]
          .slice(0, RECENT_DEPLOYMENTS_LIMIT)
          .map(({ bundle_id: _bundleId, ...rest }) => ({ ...rest, channel_name: channel.name }))
      : [],
  }
}

async function readReleaseLive(
  c: Context<MiddlewareKeyVariables>,
  appId: string,
  channelId?: number,
  versionName?: string,
): Promise<ReleaseLiveResponse | ReleaseLiveEmptyResponse> {
  const candidates = await loadReleaseCandidates(c, appId)
  const channel = pickChannel(candidates, channelId, versionName)
  const context = toChannelContext(candidates, channel)
  if (!channel)
    return { release: null, ...context }

  const release = pickRelease(candidates, channel, versionName)
    ?? (versionName ? await loadNamedBundle(c, appId, versionName, channel) : null)
  if (!release)
    return { release: null, ...context }

  const now = new Date()
  const window = resolveWindow(release.deployed_at, now)
  const channelScope: VersionUsageChannel = { id: channel.id, name: channel.name }
  const cache = new CacheHelper(c)
  const rollout = channel.rollout?.target.version_name === release.version_name ? channel.rollout : null
  // Comparing against the fallback only makes sense when it is another bundle.
  const fallback = rollout && channel.current && channel.current.version_name !== release.version_name ? channel.current : null
  const cacheKey = cache.buildRequest(ACTIVITY_CACHE_PATH, {
    appId,
    channelId: String(channel.id),
    version: release.version_name,
    since: release.deployed_at,
    // Rollout state changes the summary, so a new percentage or a pause is
    // reflected on the next poll instead of after the cache expires.
    rollout: rollout ? `${rollout.percentage_bps}:${rollout.paused_at ?? ''}:${fallback?.version_name ?? ''}` : '',
    bucket: cacheBucket(ACTIVITY_CACHE_TTL_SECONDS, now.getTime()),
  })
  const cached = await cache.matchJson<ReleaseLiveActivity>(cacheKey)
  if (cached)
    return { ...cached, release, ...context }

  // No Postgres fallback when Analytics Engine is bound: if AE is down, every
  // polling tab would otherwise move its load onto the database. The client
  // keeps showing its last snapshot and retries on the next poll.
  const readActivity = (version: string) => c.env.VERSION_USAGE
    ? readActivityCF(c, appId, version, window.startMs, window.endMs, window.bucketMinutes, channelScope)
    : readActivitySB(c, appId, version, window.startMs, window.endMs, window.bucketMinutes, channelScope)
  const [activity, deviceCounts, fallbackActivity] = await Promise.all([
    readActivity(release.version_name),
    readAdoption(c, appId, channelScope),
    // The baseline is optional: never fail the whole view on it.
    fallback
      ? readActivity(fallback.version_name).catch((error) => {
          cloudlogErr({ requestId: c.get('requestId'), message: 'release_live fallback activity failed', error: serializeError(error) })
          return null
        })
      : Promise.resolve(null),
  ])
  const fallbackTotals = fallbackActivity
    ? fillBuckets(fallbackActivity.seriesRows, window.startMs, window.endMs, window.bucketMinutes).reduce((acc, bucket) => {
        acc.install += bucket.install
        acc.fail += bucket.fail
        return acc
      }, { install: 0, fail: 0 })
    : null

  const series = fillBuckets(activity.seriesRows, window.startMs, window.endMs, window.bucketMinutes)
  const totals = series.reduce((acc, bucket) => {
    acc.get += bucket.get
    acc.install += bucket.install
    acc.fail += bucket.fail
    return acc
  }, { get: 0, install: 0, fail: 0 })

  const payload: ReleaseLiveActivity = {
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
    failed_devices: activity.failedDevices,
    series,
    rollout: rollout ? computeRollout(rollout, fallback, deviceCounts, fallbackTotals) : null,
    generated_at: now.toISOString(),
  }

  await cache.putJson(cacheKey, payload, ACTIVITY_CACHE_TTL_SECONDS)
  return { ...payload, release, ...context }
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
  pickDefaultChannel,
  pickChannel,
  pickRelease,
  pickBucketMinutes,
  resolveWindow,
  fillBuckets,
  computeAdoption,
  computeRollout,
  computeSuccessRate,
  buildSeriesQueryCF,
  buildFailuresQueryCF,
  buildFailedDevicesQueryCF,
  FAILED_DEVICES_QUERY_SB,
  EXTRA_FAILURE_ACTIONS,
  toFailedDevices,
  toChannelContext,
}
