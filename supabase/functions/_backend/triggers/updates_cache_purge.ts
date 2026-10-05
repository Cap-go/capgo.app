// Purges the plugin edge cache (/updates, /stats, /channel_self) in every
// Cloudflare data center (zone purge-by-tag, one Cloudflare call per zone per
// batch of up to 100 tags). Each queued row names an app and a scope: 'app'
// purges the app's main tag, 'versions' its bundle-name lookup tag.
//
// Woken through pg_net by public.notify_updates_edge_cache_purge() (after the
// change commits) and by the 10s cron tick while purges are due. Each wake
// drains the queue in its own transactions:
//   claim_updates_cache_purge() -> purge -> ack_updates_cache_purge()
// Claims are limited to one per second across all callers, so the Cloudflare
// rate stays bounded whatever the backlog. A successful first purge schedules
// re-purges (+3s / +10s / +60s / +180s) for replica lag. Zones are settled
// independently: a failed zone call requeues only that zone's tags at their
// Retry-After, and Free-plan zones (5 purge calls per minute) are never called
// inline: their tags are queued on a shared slot every SLOW_ZONE_SLOT_SECONDS,
// so all changes of a slot share one call. Claims lease rows, so a crash
// before the ack only delays them. Every failure is soft: the cache TTL is the
// backstop.
//
// Token: CF_CACHE_PURGE_TOKEN, else the existing CF_ANALYTICS_TOKEN once it is
// granted Zone Read + Cache Purge. Zones are the plugin worker's own zones,
// derived from cloudflare_workers/plugin/wrangler.jsonc (CF_CACHE_PURGE_ZONE_IDS
// only overrides that). A runtime without any token forwards the wake to the
// Cloudflare API worker at CLOUDFLARE_FUNCTION_URL.

import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { PLUGIN_ROUTE_HOSTS, PLUGIN_ROUTE_ZONE_NAMES } from '../plugin_runtime/utils/pluginRouteHosts.generated.ts'
import { updatesCacheTagForScope } from '../plugin_runtime/utils/updatesCacheTag.ts'
import { BRES, middlewareAPISecret } from '../utils/hono.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { backgroundTask, getEnv } from '../utils/utils.ts'

/** Cloudflare purge API accepts at most 100 tags per call on every plan. */
const PURGE_TAGS_PER_CALL = 100
/** One claim = one purge call per zone. */
const CLAIM_LIMIT = PURGE_TAGS_PER_CALL
const PURGE_TIMEOUT_MS = 5000
const DEFAULT_RETRY_AFTER_SECONDS = 5
const ZONE_DISCOVERY_RETRY_SECONDS = 30
/** Stay well inside the 30s waitUntil budget; the cron tick picks up the rest. */
const DRAIN_BUDGET_MS = 20_000
const MAX_THROTTLE_WAIT_MS = 1500
const ZONE_LIST_TTL_MS = 60 * 60 * 1000
/** Free-plan zones allow 5 purge calls per minute: one shared call per slot leaves headroom. */
export const SLOW_ZONE_SLOT_SECONDS = 15
const FORWARDED_HEADER = 'x-capgo-purge-forwarded'

/** Dedicated purge token, else the account's existing Cloudflare API token. */
export function getPurgeToken(c: Context) {
  return getEnv(c, 'CF_CACHE_PURGE_TOKEN') || getEnv(c, 'CF_ANALYTICS_TOKEN')
}

export interface PurgeZone {
  id: string
  /** Free plan: purge calls are paced through shared slots. */
  slow: boolean
}

let zoneListCache: { token: string, zones: PurgeZone[], expiresAt: number } | null = null

/**
 * True when a Cloudflare zone can hold plugin cache entries: it is named by a
 * plugin route, or one of the plugin worker's hostnames sits in it.
 */
export function isPluginZone(zoneName: string, hosts: readonly string[] = PLUGIN_ROUTE_HOSTS, zoneNames: readonly string[] = PLUGIN_ROUTE_ZONE_NAMES) {
  const name = zoneName.toLowerCase()
  return zoneNames.includes(name) || hosts.some(host => host === name || host.endsWith(`.${name}`))
}

/** Pages through the account zones the token can read and keeps the plugin's zones. */
async function fetchPluginZones(token: string): Promise<PurgeZone[]> {
  const zones: PurgeZone[] = []
  for (let page = 1, totalPages = 1; page <= Math.min(totalPages, 20); page++) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones?status=active&per_page=50&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PURGE_TIMEOUT_MS),
    })
    if (!response.ok)
      throw new Error(`zone list HTTP ${response.status}`)
    const body = await response.json() as { result?: { id?: string, name?: string, plan?: { legacy_id?: string } }[], result_info?: { total_pages?: number } }
    totalPages = body.result_info?.total_pages ?? 1
    for (const zone of body.result ?? []) {
      if (zone.id && zone.name && isPluginZone(zone.name))
        zones.push({ id: zone.id, slow: zone.plan?.legacy_id === 'free' })
    }
  }
  return zones
}

let zoneListInflight: { token: string, promise: Promise<PurgeZone[]> } | null = null

/**
 * Zones to purge: the explicit override (treated as fast zones), else the
 * zones of the account the plugin worker is routed on (from
 * cloudflare_workers/plugin/wrangler.jsonc) with their plan, looked up once per
 * hour. Concurrent callers share one lookup. A token scoped to all zones purges
 * only those.
 */
export async function resolvePurgeZones(c: Context, token: string): Promise<PurgeZone[]> {
  const override = parseCsv(getEnv(c, 'CF_CACHE_PURGE_ZONE_IDS'))
  if (override.length > 0)
    return override.map(id => ({ id, slow: false }))
  if (zoneListCache?.token === token && zoneListCache.expiresAt > Date.now())
    return zoneListCache.zones
  if (zoneListInflight?.token !== token)
    zoneListInflight = { token, promise: fetchPluginZones(token) }
  const inflight = zoneListInflight

  try {
    const zones = await inflight.promise
    zoneListCache = { token, zones, expiresAt: Date.now() + ZONE_LIST_TTL_MS }
    if (zones.length === 0)
      cloudlog({ requestId: c.get('requestId'), message: 'updates cache purge found no plugin zone for the token' })
    return zones
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'updates cache purge zone discovery failed', error: serializeError(error) })
    return zoneListCache?.token === token ? zoneListCache.zones : []
  }
  finally {
    if (zoneListInflight === inflight)
      zoneListInflight = null
  }
}

/** Test hook. */
export function resetPurgeZoneCache() {
  zoneListCache = null
  zoneListInflight = null
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size)
    chunks.push(items.slice(i, i + size))
  return chunks
}

export function parseCsv(raw: string): string[] {
  return raw.split(',').map(value => value.trim()).filter(Boolean)
}

/** One claimed row: an (app, scope) pair, for every zone or for one zone. */
export interface PurgeRow {
  app_id: string
  /** Missing before the versions-scope migration: treated as 'app'. */
  scope?: string
  /** Missing or null: every zone. */
  zone_id?: string | null
}

/** A per-zone row for ack_updates_cache_purge(p_requeue). */
export interface ZoneRequeue {
  app_id: string
  scope: string
  zone_id: string
  delay_seconds: number
  /** Due time rounded up to a multiple of this (0: exact). */
  slot_seconds: number
}

export interface PurgeResult {
  /** A purge target exists (token or local purge URL). */
  configured: boolean
  calls: number
  failed: number
  /** The whole batch must go back to the queue (zone discovery or local purge failed). */
  retryAll: boolean
  /** Retry-After for `retryAll`, in seconds. */
  retryAfterSeconds: number
  /** Per-zone rows to queue: failed zone calls and slow-zone deferrals. */
  requeue: ZoneRequeue[]
}

interface PurgePair {
  app_id: string
  scope: string
}

function parseRetryAfterSeconds(response: Response) {
  const value = Number(response.headers.get('Retry-After'))
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : DEFAULT_RETRY_AFTER_SECONDS
}

/** Distinct (app, scope) pairs of the matching rows, keyed by their tag. */
function pairsByTag(rows: PurgeRow[], match: (row: PurgeRow) => boolean) {
  const pairs = new Map<string, PurgePair>()
  for (const row of rows) {
    if (!match(row))
      continue
    const scope = row.scope ?? 'app'
    pairs.set(updatesCacheTagForScope(row.app_id, scope), { app_id: row.app_id, scope })
  }
  return pairs
}

/**
 * Purges the tags in chunks of 100. No in-worker retries: returns the pairs
 * of the failed calls with their Retry-After.
 */
async function purgeTarget(c: Context, result: PurgeResult, target: { url: string, headers: Record<string, string> }, pairs: Map<string, PurgePair>) {
  const failed: { pair: PurgePair, retryAfterSeconds: number }[] = []
  for (const tagChunk of chunk([...pairs.keys()], PURGE_TAGS_PER_CALL)) {
    result.calls++
    let retryAfterSeconds = 0
    try {
      const response = await fetch(target.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...target.headers },
        body: JSON.stringify({ tags: tagChunk }),
        signal: AbortSignal.timeout(PURGE_TIMEOUT_MS),
      })
      // Cloudflare can answer 200 with { success: false }: only an explicit
      // success counts as purged.
      const body = await response.json().catch(() => null) as { success?: boolean } | null
      if (!response.ok || body?.success === false) {
        retryAfterSeconds = parseRetryAfterSeconds(response)
        cloudlogErr({ requestId: c.get('requestId'), message: 'updates cache purge failed', url: target.url, status: response.status, cfSuccess: body?.success, tags: tagChunk.length })
      }
    }
    catch (error) {
      retryAfterSeconds = DEFAULT_RETRY_AFTER_SECONDS
      cloudlogErr({ requestId: c.get('requestId'), message: 'updates cache purge error', url: target.url, error: serializeError(error) })
    }
    if (retryAfterSeconds > 0) {
      result.failed++
      for (const tag of tagChunk)
        failed.push({ pair: pairs.get(tag) as PurgePair, retryAfterSeconds })
    }
  }
  return failed
}

/**
 * Purges claimed rows: one call per fast zone (rows for every zone or for
 * that zone), then the local emulator when set. Slow zones only get their
 * own rows; rows for every zone are deferred to their next slot instead.
 */
export async function purgeUpdatesCacheRows(c: Context, rows: PurgeRow[]): Promise<PurgeResult> {
  const token = getPurgeToken(c)
  const localPurgeUrl = getEnv(c, 'UPDATES_CACHE_LOCAL_PURGE_URL')
  const result: PurgeResult = { configured: Boolean(token || localPurgeUrl), calls: 0, failed: 0, retryAll: false, retryAfterSeconds: 0, requeue: [] }

  if (token) {
    const zones = await resolvePurgeZones(c, token)
    if (zones.length === 0) {
      // Discovery failed or the token sees no plugin zone: retry later.
      result.failed++
      result.retryAll = true
      result.retryAfterSeconds = ZONE_DISCOVERY_RETRY_SECONDS
    }
    for (const zone of zones) {
      const slotSeconds = zone.slow ? SLOW_ZONE_SLOT_SECONDS : 0
      if (zone.slow) {
        for (const pair of pairsByTag(rows, row => !row.zone_id).values())
          result.requeue.push({ ...pair, zone_id: zone.id, delay_seconds: 0, slot_seconds: slotSeconds })
      }
      const pairs = pairsByTag(rows, row => row.zone_id === zone.id || (!zone.slow && !row.zone_id))
      const failed = await purgeTarget(c, result, {
        url: `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone.id)}/purge_cache`,
        headers: { Authorization: `Bearer ${token}` },
      }, pairs)
      for (const { pair, retryAfterSeconds } of failed)
        result.requeue.push({ ...pair, zone_id: zone.id, delay_seconds: retryAfterSeconds, slot_seconds: slotSeconds })
    }
  }
  if (localPurgeUrl) {
    const failed = await purgeTarget(c, result, { url: localPurgeUrl, headers: { apisecret: getEnv(c, 'API_SECRET') } }, pairsByTag(rows, row => !row.zone_id))
    if (failed.length > 0) {
      result.retryAll = true
      result.retryAfterSeconds = Math.max(result.retryAfterSeconds, ...failed.map(entry => entry.retryAfterSeconds))
    }
  }
  return result
}

export type PurgeRpc = (fn: 'claim_updates_cache_purge' | 'ack_updates_cache_purge', args: Record<string, unknown>) => PromiseLike<{ data: unknown, error: unknown }>

interface ClaimResult {
  status: 'busy' | 'throttled' | 'empty' | 'ok'
  wait_ms?: number
  lease_token?: string
  apps?: (PurgeRow & { initial: boolean })[]
  has_more?: boolean
}

/** A purge target exists here (token or local purge URL); checked before claiming. */
export function hasPurgeTarget(c: Context) {
  return Boolean(getPurgeToken(c) || getEnv(c, 'UPDATES_CACHE_LOCAL_PURGE_URL'))
}

/**
 * Claims, purges and acknowledges batches until the queue is empty, another
 * caller is draining, or the time budget is spent.
 */
export async function drainUpdatesCachePurge(
  c: Context,
  rpc: PurgeRpc,
  options: { budgetMs?: number, sleep?: (ms: number) => Promise<unknown> } = {},
) {
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const deadline = Date.now() + (options.budgetMs ?? DRAIN_BUDGET_MS)
  let purgedApps = 0
  // Claiming without a target would only lease rows we cannot purge.
  if (!hasPurgeTarget(c)) {
    cloudlog({ requestId: c.get('requestId'), message: 'updates cache purge skipped (not configured)' })
    return { purgedApps }
  }
  let claimed = false
  let throttledBeforeClaim = 0
  while (Date.now() < deadline) {
    const { data, error } = await rpc('claim_updates_cache_purge', { p_limit: CLAIM_LIMIT })
    if (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'updates cache purge claim failed', error: serializeError(error) })
      break
    }
    const claim = data as ClaimResult
    if (claim.status === 'throttled') {
      // Before its first claim, a caller waits out the throttle once (the
      // previous drain may already be done). Throttled again means another
      // caller is draining and follows has_more; the cron tick covers the rest.
      if (!claimed && throttledBeforeClaim++ > 0)
        break
      await sleep(Math.min((claim.wait_ms ?? 1000) + 50, MAX_THROTTLE_WAIT_MS))
      continue
    }
    if (claim.status !== 'ok' || !claim.apps?.length)
      break
    claimed = true

    const apps = claim.apps
    const result = await purgeUpdatesCacheRows(c, apps)
    const ok = result.configured && !result.retryAll
    // Success deletes the leased rows (and schedules re-purges) and queues the
    // per-zone rows; failure releases them at the Retry-After. A crash before
    // this leaves the lease to expire, so the rows are claimed again.
    const { error: ackError } = await rpc('ack_updates_cache_purge', {
      p_lease_token: claim.lease_token,
      p_success: ok,
      p_retry_after_seconds: result.retryAfterSeconds || DEFAULT_RETRY_AFTER_SECONDS,
      ...(ok && result.requeue.length > 0 ? { p_requeue: result.requeue } : {}),
    })
    if (ackError)
      cloudlogErr({ requestId: c.get('requestId'), message: 'updates cache purge ack failed', error: serializeError(ackError) })
    cloudlog({ requestId: c.get('requestId'), message: 'updates cache purged', apps: apps.length, calls: result.calls, failed: result.failed, requeued: result.requeue.length })
    if (ok)
      purgedApps += apps.length
    if (!claim.has_more)
      break
  }
  return { purgedApps }
}

export function shouldForwardPurge(c: Context) {
  return !getPurgeToken(c)
    && !getEnv(c, 'UPDATES_CACHE_LOCAL_PURGE_URL')
    && Boolean(getEnv(c, 'CLOUDFLARE_FUNCTION_URL'))
    && c.req.header(FORWARDED_HEADER) !== '1'
}

async function forwardWake(c: Context) {
  try {
    const response = await fetch(`${getEnv(c, 'CLOUDFLARE_FUNCTION_URL').replace(/\/$/, '')}/triggers/updates_cache_purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apisecret': getEnv(c, 'API_SECRET'), [FORWARDED_HEADER]: '1' },
      body: JSON.stringify({ wake: true }),
      signal: AbortSignal.timeout(PURGE_TIMEOUT_MS),
    })
    if (!response.ok)
      cloudlogErr({ requestId: c.get('requestId'), message: 'updates cache purge forward failed', status: response.status })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'updates cache purge forward error', error: serializeError(error) })
  }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  if (shouldForwardPurge(c)) {
    // No Cloudflare token here (Supabase function): wake the Cloudflare API
    // worker, which has it from the Cloudflare env file.
    await backgroundTask(c, forwardWake(c))
    return c.json({ ...BRES, forwarded: true })
  }
  // Answer the wake right away; draining runs in the background.
  await backgroundTask(c, drainUpdatesCachePurge(c, (fn, args) => supabaseAdmin(c).rpc(fn, args as never)))
  return c.json(BRES)
})
