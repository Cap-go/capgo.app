import { trustedIngressRegion } from '../../supabase/functions/_backend/plugin_runtime/utils/servingRegionIngress.ts'
import { parseServingPolicy, isRestrictedServingPolicy } from '../../supabase/functions/_backend/plugin_runtime/utils/servingRegions.ts'

import { servingRegionReaderEpoch } from '../../supabase/functions/_backend/plugin_runtime/utils/servingRegionRollout.js'

// Rules to match requests this Snippet will handle
// Expression
// (http.host eq "plugin.usecapgo.com")
// or (http.host eq "plugin.capgo.app")
// or (http.host eq "updater.capgo.com.cn")
// or (http.host eq "updater.spencer.co")
// or (http.request.full_uri wildcard "*api.capgo.app/updates*")
// or (http.request.full_uri wildcard "*api.capgo.app/plugin/*")
// or (http.request.full_uri wildcard "*api.capgo.app/stats")
// or (http.request.full_uri wildcard "*api.capgo.app/channel_self")
// Circuit breaker configuration
const TIMEOUT_MS = 3000 // 3 seconds - matches plugin timeout
const CIRCUIT_RESET_MS = 5 * 60 * 1000 // 5 minutes before retrying unhealthy worker

// Enterprise snippets get 5 subrequests, and Cache API calls count: a single
// extra confirm fetch on the on-prem path turned it into 1101 errors (#3575).
// Every fetch and cache call goes through the budget below; optional cache
// writes are skipped instead of failing the request.
const MAX_SUBREQUESTS = 5
// Also the receipt lifetime in servingPolicy.ts. Cache work shares this budget.
const SERVING_ROUTE_MS = MAX_SUBREQUESTS * TIMEOUT_MS

// On-prem and plan-upgrade caching use worker Cache-Control, with Retry-After as TTL fallback.
// Cached responses keep Retry-After / X-RateLimit-Reset so clients and edge skip the worker.

// Edge answers: the plugin worker marks answers this snippet may repeat with
// X-Capgo-Edge-Fill (see plugin_runtime/utils/snippetEdgeAnswer.ts). They are
// stored per data center under the app's purge tags, then served here without
// invoking a worker. Every served answer carries X-Capgo-Edge-Stat, which
// Logpush ships to R2 so the worker replays its stats in batches.
// Kill switch: false stops every edge answer and fill on the next paste. The
// worker secret SNIPPET_EDGE_ANSWER only stops new fills; the setter script
// purges the stored ones.
const EDGE_ANSWERS_ENABLED = true
// /stats needs no learned fill: the replay runs the full handler (plan,
// on-prem, provider networks, LIMITED_APPS, unknown actions), so the device
// answer is all the worker would add. Requests without a fill still reach the
// worker at STATS_LEARN_BPS, so it can teach the answers that change what
// the device does: on-prem / plan-upgrade 429s (the plugin backs off on
// Retry-After) and the provider networks the worker must check itself.
// Installs and failures always reach the worker: rollout auto-pause sums
// their version usage, and the replay delivers at least once.
// false: back to fill-only answers (sampled devices).
const STATS_ANSWER_ALL = true
// Basis points of devices per minute (FNV bucket of app, device and minute,
// so every device takes its turn).
const STATS_LEARN_BPS = 500
const STATS_ACTION_RE = /^\w{1,64}$/
// PROVIDER_INFRA_ASNS (plugin_runtime/utils/providerAsns.ts): without a fill
// the snippet does not know whether the app blocks them, so their /stats keep
// reaching the worker, which answers them 429 when it does.
const PROVIDER_ASNS = new Set([15169, 16591, 19527, 36040, 36492, 43515, 139070, 396982, 714, 6185])
const EDGE_FILL_HEADER = 'X-Capgo-Edge-Fill'
const EDGE_IP_LIMIT_HEADER = 'X-Capgo-Edge-Ip-Limit'
const EDGE_STAT_HEADER = 'X-Capgo-Edge-Stat'
const EDGE_KIND_HEADER = 'X-Edge-Kind'
// Paths Logpush ships (setup-snippet-edge-stats.ts): only those are answered.
const EDGE_ANSWER_PATHS = new Set(['/updates', '/stats'])
// Hosts that reach the same workers share the IP limit entries (Cache API keys
// on another hostname of the zone work in snippets: snippet-edge-probe).
const IP_LIMIT_HOSTS = { 'api.capgo.app': 'plugin.capgo.app', 'plugin.usecapgo.com': 'plugin.capgo.app' }
const MAX_EDGE_CHANNEL_LENGTH = 128
const MAX_EDGE_ACTIONS = 128
const MAX_EDGE_PROVIDER_ASNS = 64
// Logpush header fields and the replay queue messages stay small.
const MAX_EDGE_STAT_BODY_BYTES = 6000
// Logpush cuts response header fields at 8192 bytes (measured); a cut stat
// can't be decoded, so bigger ones go to the worker.
const MAX_EDGE_STAT_HEADER_BYTES = 8000
const APP_ID_RE = /^[a-z0-9]+(?:\.[\w-]+)+$/i
const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLAIN_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
// @std/semver FULL_REGEXP, piece by piece: core numbers kept below
// MAX_SAFE_INTEGER (its parse rejects larger ones), no surrounding whitespace
// (it trims) and a lowercase v prefix only.
const SEMVER_PARTS_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+(.+))?$/
const SEMVER_CORE_NUMBER_RE = /^(?:0|[1-9]\d{0,14})$/
const SEMVER_PRERELEASE_ID_RE = /^(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*)$/
const SEMVER_BUILD_ID_RE = /^[\da-zA-Z-]+$/
const MAX_SEMVER_LENGTH = 256
const DEVICE_PLATFORMS = new Set(['ios', 'android', 'electron'])

function createBudget() {
  return { used: 0, deadline: null }
}

/** True when `count` more subrequests fit and still leave `reserve` for later ones. */
function canSpend(budget, count = 1, reserve = 0) {
  return (budget.deadline === null || Date.now() < budget.deadline)
    && budget.used + count + reserve <= MAX_SUBREQUESTS
}

// Active-policy routing has one absolute deadline, including complete cache
// reads and breaker writes. Timed-out operations may finish, so only use this
// for fetches, read-only cache work, and diagnostic circuit mutations.
async function withinServingDeadline(budget, operation) {
  if (budget.deadline === null)
    return operation()
  const remaining = Math.min(TIMEOUT_MS, budget.deadline - Date.now())
  if (remaining <= 0)
    throw new Error('Serving route deadline exceeded')
  let timer
  try {
    const result = await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Serving route operation timed out')), remaining)
      }),
    ])
    if (Date.now() >= budget.deadline)
      throw new Error('Serving route deadline exceeded')
    return result
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * `onError`: what a lookup error reads as (a miss by default); `true` for
 * entries that block an answer, null where a miss would allow one.
 */
async function cacheMatch(budget, key, onError = undefined) {
  budget.used++
  try {
    return await caches.default.match(key)
  }
  catch {
    return onError
  }
}

async function cachePut(budget, key, response) {
  budget.used++
  try {
    await caches.default.put(key, response)
    return true
  }
  catch (e) {
    console.log(`Cache put failed: ${e.message}`)
    return false
  }
}

async function cacheDelete(budget, key) {
  budget.used++
  try {
    await caches.default.delete(key)
  }
  catch {
    // Ignore errors - the entry expires anyway
  }
}

// Helper to build cache keys using actual hostname to avoid DNS lookups on fake .internal domains
function getCircuitBreakerCacheKey(hostname, colo, workerUrl) {
  return `https://${hostname}/__internal__/circuit-breaker/${colo}/${encodeURIComponent(workerUrl)}`
}

// One entry per app, endpoint, method and (for /updates) platform + default
// channel: an on-prem or plan-upgrade answer, or the edge answer. One lookup
// serves all three. A fill only writes its own entry: merging into entries
// read before a purge would bring purged answers back.
function getEdgeCacheKey(hostname, appId, endpoint, method, variant) {
  return `https://${hostname}/__internal__/edge-v4/${encodeURIComponent(appId)}/${endpoint}/${method}${variant ? `/${variant}` : ''}`
}

/** /updates answers depend on platform and default channel; null when the channel is too long to key on. */
function getEdgeVariant(endpoint, method, body) {
  if (endpoint !== 'updates' || method !== 'POST' || !isPlainObject(body))
    return ''
  const channel = typeof body.defaultChannel === 'string' ? body.defaultChannel : ''
  if (channel.length > MAX_EDGE_CHANNEL_LENGTH)
    return null
  return `${encodeURIComponent(typeof body.platform === 'string' ? body.platform : '')}/${encodeURIComponent(channel)}`
}

function getIpLimitCacheKey(hostname, ip) {
  return `https://${IP_LIMIT_HOSTS[hostname] ?? hostname}/__internal__/edge-ip-limit-v1/${encodeURIComponent(ip)}`
}

// Endpoints that should be checked for on-prem caching
const ONPREM_CACHEABLE_ENDPOINTS = ['/updates', '/stats', '/channel_self']

async function markUnhealthy(budget, hostname, colo, workerUrl) {
  const response = new Response(JSON.stringify({ unhealthyAt: Date.now() }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `max-age=${Math.floor(CIRCUIT_RESET_MS / 1000)}`,
    },
  })
  if (await withinServingDeadline(budget, () => cachePut(budget, getCircuitBreakerCacheKey(hostname, colo, workerUrl), response)).catch(() => false))
    console.log(`Circuit OPEN for ${colo} → ${workerUrl}`)
}

/** Reads the breaker once; `hasEntry` lets a success clear it without another lookup. */
async function readCircuit(budget, hostname, colo, workerUrl) {
  return withinServingDeadline(budget, async () => {
    const cached = await cacheMatch(budget, getCircuitBreakerCacheKey(hostname, colo, workerUrl))
    if (!cached)
      return { healthy: true, hasEntry: false } // No cache entry = healthy
    try {
      const data = await cached.json()
      // Circuit resets after CIRCUIT_RESET_MS (handled by Cache-Control, but double-check)
      return { healthy: Date.now() - data.unhealthyAt >= CIRCUIT_RESET_MS, hasEntry: true }
    }
    catch {
      return { healthy: true, hasEntry: true } // On error, assume healthy
    }
  }).catch(() => ({ healthy: true, hasEntry: false }))
}

// On-prem caching helper functions
function matchesEndpoint(pathname, endpoint) {
  // More precise matching to avoid false positives (e.g., '/api/updates_history' matching '/updates')
  // Note: pathname never includes query strings (those are in url.search), so we only check exact match and path prefix
  return pathname === endpoint || pathname.startsWith(`${endpoint}/`)
}

function policyEndpointPath(pathname) {
  // Activated releases gate deprecated aliases before any learned answer or retry.
  return servingRegionReaderEpoch ? pathname.replace(/^\/plugin(?=\/)/, '') : pathname
}

function getEndpointName(pathname) {
  pathname = policyEndpointPath(pathname)
  if (matchesEndpoint(pathname, '/updates'))
    return 'updates'
  if (matchesEndpoint(pathname, '/stats'))
    return 'stats'
  if (matchesEndpoint(pathname, '/channel_self'))
    return 'channel_self'
  return 'unknown'
}

function isCacheableEndpoint(pathname) {
  return ONPREM_CACHEABLE_ENDPOINTS.some(ep => matchesEndpoint(policyEndpointPath(pathname), ep))
}

function getRetryAfterSeconds(headers, responseBody) {
  const header = headers.get('Retry-After') || headers.get('retry-after')
  if (header) {
    const seconds = Number.parseFloat(header.trim())
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.floor(seconds)
  }

  const moreInfo = responseBody && typeof responseBody === 'object' ? responseBody.moreInfo : null
  const fromMoreInfo = moreInfo && typeof moreInfo.retryAfterSeconds === 'number'
    ? moreInfo.retryAfterSeconds
    : null
  if (typeof fromMoreInfo === 'number' && Number.isFinite(fromMoreInfo) && fromMoreInfo >= 0)
    return Math.floor(fromMoreInfo)

  if (responseBody && typeof responseBody.retryAfterSeconds === 'number'
    && Number.isFinite(responseBody.retryAfterSeconds) && responseBody.retryAfterSeconds >= 0) {
    return Math.floor(responseBody.retryAfterSeconds)
  }

  return null
}

function getCacheTtlSeconds(headers, responseBody) {
  const cacheControl = headers.get('Cache-Control') || headers.get('cache-control')
  if (cacheControl) {
    const directives = cacheControl.split(',').map(part => part.trim().toLowerCase())
    if (directives.includes('no-store'))
      return null

    const sMaxAge = directives.find(part => part.startsWith('s-maxage='))
    if (sMaxAge) {
      const seconds = Number.parseInt(sMaxAge.split('=')[1] || '', 10)
      if (Number.isFinite(seconds) && seconds > 0)
        return seconds
    }

    const maxAge = directives.find(part => part.startsWith('max-age='))
    if (maxAge) {
      const seconds = Number.parseInt(maxAge.split('=')[1] || '', 10)
      if (Number.isFinite(seconds) && seconds > 0)
        return seconds
    }
  }

  // Fall back to Retry-After so on_premise / plan-upgrade responses still edge-cache
  // and skip the worker for the client backoff window.
  const retryAfter = getRetryAfterSeconds(headers, responseBody)
  if (typeof retryAfter === 'number' && retryAfter > 0)
    return retryAfter

  return null
}

/**
 * Keep rate-limit headers accurate when serving a cached 429.
 * Recompute Retry-After / Cache-Control from X-RateLimit-Reset (unix seconds),
 * and refresh moreInfo.retryAfterSeconds in the JSON body when present.
 */
async function withFreshRateLimitHeaders(cachedResponse) {
  const headers = new Headers(cachedResponse.headers)
  headers.delete(EDGE_KIND_HEADER)
  const nowSec = Math.floor(Date.now() / 1000)
  let remaining = null
  let resetAtSec = null

  const resetHeader = headers.get('X-RateLimit-Reset') || headers.get('x-ratelimit-reset')
  if (resetHeader) {
    const parsed = Number.parseInt(resetHeader, 10)
    if (Number.isFinite(parsed)) {
      resetAtSec = parsed
      remaining = Math.max(0, parsed - nowSec)
      headers.set('Retry-After', String(remaining))
      headers.set('X-RateLimit-Reset', String(parsed))
      if (remaining <= 0)
        headers.set('Cache-Control', 'private, no-store')
      else
        headers.set('Cache-Control', `public, max-age=${remaining}`)
    }
  }

  let body = cachedResponse.body
  try {
    const text = await cachedResponse.clone().text()
    const json = JSON.parse(text)
    if (json && typeof json === 'object' && json.moreInfo && typeof json.moreInfo === 'object' && typeof remaining === 'number') {
      json.moreInfo.retryAfterSeconds = remaining
      if (typeof resetAtSec === 'number')
        json.moreInfo.rateLimitResetAt = resetAtSec * 1000
      headers.delete('Content-Length')
      body = JSON.stringify(json)
    }
    else {
      body = text
    }
  }
  catch {
    // Keep original body stream when JSON rewrite is not possible.
  }

  return new Response(body, {
    status: cachedResponse.status,
    statusText: cachedResponse.statusText,
    headers,
  })
}

// Nothing in this operation publishes an answer or starts another subrequest
// after the match. A late read/body completion cannot spend the retry budget.
async function readEdgeCache(budget, edgeKey) {
  return withinServingDeadline(budget, async () => {
    const cached = await cacheMatch(budget, edgeKey, null)
    if (!cached)
      return { miss: cached === undefined }
    if (cached.headers.get(EDGE_KIND_HEADER) !== 'answers')
      return { response: await withFreshRateLimitHeaders(cached), kind: cached.headers.get(EDGE_KIND_HEADER) }
    try {
      return { document: await cached.json() }
    }
    catch {
      return {}
    }
  }).catch(() => ({}))
}

/** Persist absolute reset + Cache-Control so Cache API TTL and client countdown stay correct. */
function applyEdgeRateLimitCacheHeaders(headers, responseBody, cacheTtl) {
  headers.set('Cache-Control', `public, max-age=${cacheTtl}`)

  const nowSec = Math.floor(Date.now() / 1000)
  const retryAfter = getRetryAfterSeconds(headers, responseBody)
  const fromBodyReset = typeof responseBody?.moreInfo?.rateLimitResetAt === 'number'
    ? Math.ceil(responseBody.moreInfo.rateLimitResetAt / 1000)
    : null

  if (typeof fromBodyReset === 'number' && Number.isFinite(fromBodyReset)) {
    headers.set('X-RateLimit-Reset', String(fromBodyReset))
    headers.set('Retry-After', String(Math.max(0, fromBodyReset - nowSec)))
    return
  }

  if (typeof retryAfter === 'number') {
    if (!headers.has('Retry-After'))
      headers.set('Retry-After', String(retryAfter))
    if (!headers.has('X-RateLimit-Reset'))
      headers.set('X-RateLimit-Reset', String(nowSec + retryAfter))
  }
}

/** Same tag as the worker's pluginStateAppCacheTag. */
function pluginStateAppCacheTag(appId) {
  return `capgo-plugin-state-${appId.toLowerCase().replace(/[^a-z0-9._-]/g, '_')}`
}

/**
 * A shared KV answer (X-Plugin-State-Shared) must leave with its snapshot:
 * a publication purges only the plugin-state tag.
 */
function cacheTagFor(tag, appId, responseHeaders) {
  return responseHeaders?.get('X-Plugin-State-Shared') === '1' ? `${tag},${pluginStateAppCacheTag(appId)}` : tag
}

async function setOnPremCache(budget, edgeKey, appId, endpoint, method, responseBody, status, responseHeaders) {
  const cacheTtl = getCacheTtlSeconds(responseHeaders, responseBody)
  if (!cacheTtl) {
    console.log(`On-prem cache SKIP for ${appId}/${endpoint}/${method} (missing cache TTL)`)
    return
  }
  if (!canSpend(budget)) {
    console.log(`On-prem cache SKIP for ${appId}/${endpoint}/${method} (subrequest budget)`)
    return
  }

  const headers = new Headers(responseHeaders)
  headers.set('Content-Type', 'application/json')
  headers.set('Cache-Tag', cacheTagFor(`app-onprem-v2:${appId}`, appId, responseHeaders))
  headers.set('X-Onprem-Cached', 'true')
  headers.set('X-Onprem-App-Id', appId)
  headers.set('X-Onprem-Ttl', String(cacheTtl))
  headers.set(EDGE_KIND_HEADER, 'onprem')
  applyEdgeRateLimitCacheHeaders(headers, responseBody, cacheTtl)

  const response = new Response(JSON.stringify(responseBody), { status, headers })
  if (await cachePut(budget, edgeKey, response))
    console.log(`On-prem cache SET for ${appId}/${endpoint}/${method} (${cacheTtl}s TTL)`)
}

function isOnPremResponse(status, responseBody) {
  // Check for 429 with on_premise_app error (from /updates)
  if (status === 429 && responseBody?.error === 'on_premise_app')
    return true
  // Check for isOnprem: true (from /stats)
  if (responseBody?.isOnprem === true)
    return true
  return false
}

function isPlanUpgradeResponse(status, responseBody) {
  return status === 429 && responseBody?.error === 'need_plan_upgrade'
}

function buildOnPremResponse(appId, responseBody, status, responseHeaders) {
  const newHeaders = new Headers(responseHeaders)
  newHeaders.set('Content-Type', 'application/json')
  newHeaders.set('X-Onprem-Cached', 'false')
  newHeaders.set('X-Onprem-App-Id', appId)

  return new Response(JSON.stringify(responseBody), {
    status,
    headers: newHeaders,
  })
}

async function setPlanUpgradeCache(budget, edgeKey, appId, endpoint, method, responseBody, status, responseHeaders) {
  const cacheTtl = getCacheTtlSeconds(responseHeaders, responseBody)
  if (!cacheTtl) {
    console.log(`Plan-upgrade cache SKIP for ${appId}/${endpoint}/${method} (missing cache TTL)`)
    return
  }
  if (!canSpend(budget)) {
    console.log(`Plan-upgrade cache SKIP for ${appId}/${endpoint}/${method} (subrequest budget)`)
    return
  }

  const headers = new Headers(responseHeaders)
  headers.set('Content-Type', 'application/json')
  headers.set('Cache-Tag', cacheTagFor(`app-plan-v2:${appId}`, appId, responseHeaders))
  headers.set('X-Plan-Upgrade-Cached', 'true')
  headers.set('X-Plan-Upgrade-App-Id', appId)
  headers.set('X-Plan-Upgrade-Ttl', String(cacheTtl))
  headers.set(EDGE_KIND_HEADER, 'plan')
  applyEdgeRateLimitCacheHeaders(headers, responseBody, cacheTtl)
  const response = new Response(JSON.stringify(responseBody), { status, headers })
  if (await cachePut(budget, edgeKey, response))
    console.log(`Plan-upgrade cache SET for ${appId}/${endpoint}/${method} (${cacheTtl}s TTL)`)
}

function parseJsonBody(requestBody) {
  if (!requestBody)
    return undefined
  try {
    return JSON.parse(new TextDecoder().decode(requestBody))
  }
  catch {
    return undefined
  }
}

function extractAppIdFromBody(body) {
  if (Array.isArray(body)) {
    // /stats batch: first event app_id (handler enforces one app_id per batch)
    const first = body[0]
    if (first && typeof first === 'object' && typeof first.app_id === 'string' && first.app_id)
      return first.app_id
    return null
  }
  if (body && typeof body === 'object')
    return body.app_id ?? null
  return null
}

function extractAppIdFromRequest(request, url, body) {
  const method = request.method
  // For GET and DELETE on /channel_self, app_id is in query params
  if ((method === 'DELETE' || method === 'GET') && matchesEndpoint(url.pathname, '/channel_self')) {
    return url.searchParams.get('app_id')
  }
  // For POST and PUT methods, app_id is in the body (already buffered once).
  if (method === 'POST' || method === 'PUT')
    return extractAppIdFromBody(body)
  // For other HTTP methods (PATCH, OPTIONS, HEAD, etc.), on-prem caching is
  // intentionally skipped as these endpoints don't use those methods
  return null
}

// --- Edge answers ---------------------------------------------------------

/** Same FNV-1a bucket as the worker's UPDATES_EDGE_CACHE sampling. */
function edgeBucket(appId, deviceId) {
  let hash = 0x811C9DC5
  for (const char of `${appId}:${deviceId}`) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 10000
}

/** Same FNV-1a bucket as the worker's pluginStateBucket (KV canary cohort). */
function pluginStateBucket(appId, deviceId) {
  let hash = 0x811C9DC5
  for (const char of `plugin-state:${appId}:${deviceId}`) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 10000
}

/** The worker serves this device from KV (fill.ks: its KV share). */
function isKvCohort(fill, appId, deviceId) {
  const share = typeof fill?.ks === 'number' ? fill.ks : 0
  if (share >= 10000)
    return true
  return share > 0 && typeof deviceId === 'string' && deviceId !== '' && pluginStateBucket(appId, deviceId.toLowerCase()) < share
}

/**
 * Entry answer for this device: the KV canary answer (kvFill) to its cohort,
 * the database answer (fill) to the other devices. Never one for the other.
 */
function edgeFillFor(doc, appId, deviceId) {
  if (isPlainObject(doc.kvFill) && isKvCohort(doc.kvFill, appId, deviceId))
    return doc.kvFill
  if (isPlainObject(doc.fill) && !isKvCohort(doc.fill, appId, deviceId))
    return doc.fill
  return null
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalString(value, maxLength = Infinity) {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength)
}

function fixSemver(version) {
  const dots = (version.match(/\./g) ?? []).length
  if (dots === 0)
    return `${version}.0.0`
  if (dots === 1)
    return `${version}.0`
  return version
}

/**
 * Plugins the worker answers from its read cache. Stricter on purpose: plain
 * x.y.z only, no v4 and older, no deprecated plugin, and with the legacy
 * channel_self store bound (fill.cs) none of the plugins that use it.
 */
function isAnswerablePluginVersion(pluginVersion, legacyChannelSelfStore) {
  const match = typeof pluginVersion === 'string' ? PLAIN_SEMVER_RE.exec(pluginVersion) : null
  if (!match)
    return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major >= 8)
    return true
  if (major < 5)
    return false
  return minor >= (legacyChannelSelfStore ? 34 : major === 5 ? 10 : 25)
}

/** The worker's canServeUpToDateFromCache, plus the request schema it validates first. */
function isAnswerableUpdatesBody(body, appId, fill) {
  return isPlainObject(body)
    && body.app_id === appId
    && typeof body.device_id === 'string' && DEVICE_ID_RE.test(body.device_id)
    && DEVICE_PLATFORMS.has(body.platform)
    && typeof body.version_name === 'string' && body.version_name !== '' && body.version_name === fill.n
    && typeof body.version_build === 'string' && body.version_build !== 'unknown' && PLAIN_SEMVER_RE.test(fixSemver(body.version_build))
    && typeof body.is_emulator === 'boolean' && typeof body.is_prod === 'boolean'
    && isAnswerablePluginVersion(body.plugin_version, fill.cs)
    && isOptionalString(body.defaultChannel, MAX_EDGE_CHANNEL_LENGTH)
    && isOptionalString(body.install_source, 64)
    && isOptionalString(body.key_id, 20)
    // A key mismatch is answered by the worker (key_id_mismatch for current plugins).
    && (!body.key_id || !fill.k || body.key_id === fill.k)
}

function isValidStatsMetadata(metadata) {
  if (metadata === undefined)
    return true
  if (!isPlainObject(metadata))
    return false
  const entries = Object.entries(metadata)
  return entries.length <= 30 && entries.every(([key, value]) => key.length <= 64 && typeof value === 'string' && value.length <= 2048)
}

/**
 * parsePluginBody rejects a native version @std/semver cannot parse after
 * fixSemver; prerelease and build tags (1.2.3-native.4+ota.5) are valid.
 */
function isAnswerableStatsVersionBuild(versionBuild) {
  if (versionBuild === undefined || versionBuild === '')
    return true
  if (typeof versionBuild !== 'string')
    return false
  const version = fixSemver(versionBuild)
  return version.length <= MAX_SEMVER_LENGTH && isSemver(version)
}

function isSemver(version) {
  const parts = SEMVER_PARTS_RE.exec(version)
  if (!parts)
    return false
  // Absent tags read as '': SEMVER_PARTS_RE never captures an empty one.
  const [, major, minor, patch, prerelease = '', build = ''] = parts
  return [major, minor, patch].every(part => SEMVER_CORE_NUMBER_RE.test(part))
    && (!prerelease || prerelease.split('.').every(id => SEMVER_PRERELEASE_ID_RE.test(id)))
    && (!build || build.split('.').every(id => SEMVER_BUILD_ID_RE.test(id)))
}

/**
 * The stats request schema and an answerable action, never an install or a
 * failure. With `actions` (a fill answer) only the actions the worker lists;
 * without (STATS_ANSWER_ALL) any other action: the replay rejects the actions
 * it does not know.
 */
function isAnswerableStatsAction(action, actions) {
  if (typeof action !== 'string' || action === 'set' || action.endsWith('_fail'))
    return false
  return actions ? actions.includes(action) : STATS_ACTION_RE.test(action)
}

function isAnswerableStatsEvent(event, appId, actions) {
  return isPlainObject(event)
    && event.app_id === appId
    && typeof event.device_id === 'string' && DEVICE_ID_RE.test(event.device_id)
    && typeof event.platform === 'string'
    && typeof event.version_name === 'string'
    && typeof event.version_os === 'string'
    && typeof event.is_emulator === 'boolean' && typeof event.is_prod === 'boolean'
    && isAnswerableStatsAction(event.action, actions)
    && ['defaultChannel', 'channel', 'old_version_name', 'version_code', 'plugin_version'].every(key => isOptionalString(event[key]))
    && isAnswerableStatsVersionBuild(event.version_build)
    && isOptionalString(event.install_source, 64)
    && isOptionalString(event.custom_id, 36)
    && isOptionalString(event.key_id, 20)
    && isValidStatsMetadata(event.metadata)
}

/**
 * The app blocks provider infrastructure (fill.pa): the worker looks the IP
 * up, the snippet can't. Requests from those networks, or of unknown network,
 * go to the worker.
 */
function isProviderNetwork(request, fill) {
  const asn = request.cf?.asn
  // No fill (STATS_ANSWER_ALL): any provider network could be blocked.
  if (!isPlainObject(fill))
    return typeof asn !== 'number' || PROVIDER_ASNS.has(asn)
  if (fill.pa === undefined)
    return false
  return typeof asn !== 'number' || !Array.isArray(fill.pa) || fill.pa.includes(asn)
}

/** The devices of this minute whose /stats teach the worker's answers. */
function isStatsLearnSample(appId, body) {
  const deviceId = (Array.isArray(body) ? body[0] : body)?.device_id
  if (typeof deviceId !== 'string')
    return true
  return edgeBucket(appId, `${deviceId.toLowerCase()}:${Math.floor(Date.now() / 60_000)}`) < STATS_LEARN_BPS
}

function isLiveEdgeFill(fill, appId, deviceId) {
  return isPlainObject(fill)
    && typeof fill.exp === 'number' && fill.exp > Date.now()
    && typeof deviceId === 'string'
    && edgeBucket(appId, deviceId.toLowerCase()) < fill.bps
}

function base64UrlEncode(text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Encodes the stat for Logpush, or returns null when it would be cut. */
function edgeStatHeader(stat) {
  const value = base64UrlEncode(JSON.stringify(stat))
  return value.length <= MAX_EDGE_STAT_HEADER_BYTES ? value : null
}

function edgeAnswerResponse(body, statHeader) {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Capgo-Edge': 'answer',
      [EDGE_STAT_HEADER]: statHeader,
    },
  })
}

/** Serves the request from the stored edge answer, or returns null to call the worker. */
async function tryEdgeAnswer(budget, request, url, endpoint, appId, body, rawBody, doc) {
  // Browser callers need the worker's CORS answer; Logpush keeps small headers only.
  if (!EDGE_ANSWERS_ENABLED || !EDGE_ANSWER_PATHS.has(url.pathname) || request.headers.has('Origin') || rawBody.length > MAX_EDGE_STAT_BODY_BYTES || !APP_ID_RE.test(appId))
    return null
  const events = Array.isArray(body) ? body : [body]
  const fill = edgeFillFor(doc, appId, events[0]?.device_id)
  // /stats answers need no fill (STATS_ANSWER_ALL), but still honour its provider networks.
  if (isProviderNetwork(request, fill ?? doc.fill ?? doc.kvFill))
    return null

  if (endpoint === 'updates') {
    if (!isLiveEdgeFill(fill, appId, body?.device_id) || typeof fill.r !== 'string' || !isAnswerableUpdatesBody(body, appId, fill))
      return null
    // An up-to-date answer confirms the bundle name: never give it to an IP
    // the worker's update enumeration guard limited.
    const ip = request.headers.get('cf-connecting-ip')
    const statHeader = edgeStatHeader({ e: 'updates', b: rawBody, n: fill.n })
    if (!ip || !statHeader || !canSpend(budget, 1, 2))
      return null
    if (await withinServingDeadline(budget, () => cacheMatch(budget, getIpLimitCacheKey(url.hostname, ip), true)).catch(() => true))
      return null
    return edgeAnswerResponse(fill.r, statHeader)
  }

  if (endpoint === 'stats') {
    if (events.length === 0)
      return null
    let actions
    if (!STATS_ANSWER_ALL) {
      if (!isLiveEdgeFill(fill, appId, events[0]?.device_id) || !Array.isArray(fill.actions))
        return null
      actions = fill.actions
    }
    if (!events.every(event => isAnswerableStatsEvent(event, appId, actions)))
      return null
    const statHeader = edgeStatHeader({ e: 'stats', b: rawBody })
    if (!statHeader)
      return null
    const answer = Array.isArray(body)
      ? { status: 'ok', results: events.map((_, index) => ({ status: 'ok', index })) }
      : { status: 'ok' }
    return edgeAnswerResponse(JSON.stringify(answer), statHeader)
  }

  return null
}

function parseEdgeFill(value, endpoint) {
  try {
    const fill = JSON.parse(decodeURIComponent(value))
    // v3 carries the provider networks (pa) the snippet must leave to the worker.
    // v4: KV canary answer (kv: true), stored apart from the database one.
    if (!isPlainObject(fill) || (fill.v !== 2 && fill.v !== 3 && fill.v !== 4) || fill.e !== endpoint || typeof fill.tags !== 'string')
      return null
    if (fill.v !== 4 && (fill.v === 3) !== (fill.pa !== undefined))
      return null
    if ((fill.v === 4) !== (fill.kv === true))
      return null
    if (fill.ks !== undefined && (typeof fill.ks !== 'number' || fill.ks < 0 || fill.ks > 10000))
      return null
    if (fill.pa !== undefined && (!Array.isArray(fill.pa) || fill.pa.length > MAX_EDGE_PROVIDER_ASNS || !fill.pa.every(asn => Number.isInteger(asn))))
      return null
    if (typeof fill.bps !== 'number' || fill.bps <= 0 || fill.bps > 10000 || typeof fill.ttl !== 'number' || fill.ttl < 1 || fill.ttl > 3600)
      return null
    if (endpoint === 'updates' && (typeof fill.n !== 'string' || typeof fill.cs !== 'boolean' || (fill.k !== null && typeof fill.k !== 'string')))
      return null
    if (endpoint === 'stats' && (!Array.isArray(fill.actions) || fill.actions.length > MAX_EDGE_ACTIONS || !fill.actions.every(action => typeof action === 'string')))
      return null
    return fill
  }
  catch {
    return null
  }
}

/** Stores the fill as the entry's only answer (one subrequest). */
async function storeEdgeFill(budget, edgeKey, appId, endpoint, fill, responseText, previous) {
  const entry = { ...fill, exp: Date.now() + fill.ttl * 1000 }
  if (endpoint === 'updates')
    entry.r = responseText
  // One entry holds both cohorts: keep the other cohort's live answer read
  // before this request (no extra subrequest). A lost race only relearns.
  const slot = fill.kv === true ? 'kvFill' : 'fill'
  const other = slot === 'kvFill' ? 'fill' : 'kvFill'
  const doc = { [slot]: entry }
  const kept = isPlainObject(previous) ? previous[other] : null
  if (isPlainObject(kept) && typeof kept.exp === 'number' && kept.exp > Date.now() && typeof kept.tags === 'string')
    doc[other] = kept
  // Either answer's purge must evict the entry.
  const tags = [...new Set([entry.tags, doc[other]?.tags].filter(Boolean).join(',').split(','))].join(',')
  const response = new Response(JSON.stringify(doc), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${fill.ttl}`,
      'Cache-Tag': tags,
      [EDGE_KIND_HEADER]: 'answers',
    },
  })
  if (await cachePut(budget, edgeKey, response))
    console.log(`Edge answer SET for ${appId}/${endpoint}`)
}

async function storeIpLimit(budget, hostname, ip, resetAtSec) {
  const ttl = Math.min(3600, resetAtSec - Math.floor(Date.now() / 1000))
  if (!ip || !Number.isFinite(ttl) || ttl <= 0)
    return
  await cachePut(budget, getIpLimitCacheKey(hostname, ip), new Response('1', {
    headers: { 'Cache-Control': `public, max-age=${ttl}` },
  }))
}

/** Worker answer: learn the edge fill / IP limit it carries, without exposing them to the client. */
async function handleEdgeHints(budget, response, request, hostname, edgeKey, appId, endpoint, canCache, previous = null, kvCanary = false) {
  const fillHeader = response.headers.get(EDGE_FILL_HEADER)
  const ipLimitHeader = response.headers.get(EDGE_IP_LIMIT_HEADER)
  if (!fillHeader && !ipLimitHeader)
    return response

  const headers = new Headers(response.headers)
  headers.delete(EDGE_FILL_HEADER)
  headers.delete(EDGE_IP_LIMIT_HEADER)

  if (ipLimitHeader && canSpend(budget))
    await storeIpLimit(budget, hostname, request.headers.get('cf-connecting-ip'), Number.parseInt(ipLimitHeader, 10))

  if (EDGE_ANSWERS_ENABLED && fillHeader && edgeKey && canCache && response.status === 200 && canSpend(budget)) {
    const fill = parseEdgeFill(fillHeader, endpoint)
    // A KV canary answer may only fill the cohort's own slot, and only it may.
    if (fill && (fill.kv === true) === kvCanary) {
      const text = await response.text()
      await storeEdgeFill(budget, edgeKey, appId, endpoint, fill, text, previous)
      return new Response(text, { status: response.status, statusText: response.statusText, headers })
    }
  }

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const method = request.method
    const hostname = url.hostname
    const budget = createBudget()

    // Buffer POST/PUT body once — reused for app_id parse and regional fallbacks.
    const requestBody = method === 'POST' || method === 'PUT'
      ? await request.arrayBuffer()
      : undefined

    // Check the edge cache for cacheable endpoints BEFORE routing to workers
    let appId = null
    let endpoint = null
    let body
    let servingPolicy = null
    const forwardedHeaders = new Headers(request.headers)
    forwardedHeaders.delete('x-capgo-serving-ingress')
    let edgeKey = null
    let edgeDoc = null
    if (isCacheableEndpoint(url.pathname) || /\/(?:plugin\/)?updates\/manifest_size$/.test(url.pathname)) {
      endpoint = getEndpointName(url.pathname)
      body = parseJsonBody(requestBody)
      appId = extractAppIdFromRequest(request, url, body)
      if (appId && servingRegionReaderEpoch) {
        budget.deadline = Date.now() + SERVING_ROUTE_MS
        try {
          // One subrequest, before ANY app cache, including synthetic stats.
          budget.used++
          const doc = await withinServingDeadline(budget, async () => {
            const policyResponse = await fetch(new Request(`https://plugin.eu.capgo.app/serving_policy/${encodeURIComponent(appId)}`, {
              headers: forwardedHeaders,
              redirect: 'manual',
              signal: AbortSignal.timeout(TIMEOUT_MS),
            }))
            if (!policyResponse.ok)
              throw new Error('Policy unavailable')
            return policyResponse.json()
          })
          if (doc.active !== true || doc.epoch !== servingRegionReaderEpoch || doc.f !== 1 || doc.app_id !== appId || !doc.policy || typeof doc.receipt !== 'string')
            throw new Error('Invalid policy')
          servingPolicy = parseServingPolicy(doc.policy.regions, doc.policy.mode)
          forwardedHeaders.set('x-capgo-serving-ingress', doc.receipt)
          if (isRestrictedServingPolicy(servingPolicy)) {
            const ingress = trustedIngressRegion(request.cf?.colo)
            if (!ingress)
              throw new Error('Unknown ingress')
            if (!servingPolicy.regions.includes(ingress))
              return Response.json({ error: 'serving_region_blocked' }, { status: 403 })
          }
        }
        catch {
          return Response.json({ error: 'serving_policy_unavailable' }, { status: 503 })
        }
      }
      const restrictedServing = servingPolicy && isRestrictedServingPolicy(servingPolicy)
      const variant = appId && !restrictedServing ? getEdgeVariant(endpoint, method, body) : null
      edgeKey = variant === null ? null : getEdgeCacheKey(hostname, appId, endpoint, method, variant)

      if (edgeKey) {
        // null: the lookup failed, which must not read as nothing learned.
        const entry = await readEdgeCache(budget, edgeKey)
        edgeDoc = isPlainObject(entry.document) ? entry.document : null
        if (entry.response) {
          console.log(`Edge cache HIT (${entry.kind}) for ${appId}/${endpoint}/${method}`)
          return entry.response
        }
        if (isPlainObject(entry.document) && method === 'POST') {
          const rawBody = new TextDecoder().decode(requestBody)
          const answer = await tryEdgeAnswer(budget, request, url, endpoint, appId, body, rawBody, entry.document)
          if (answer)
            return answer
        }
        // Nothing learned for this app here yet: answer /stats anyway, except
        // the share left to the worker to learn from.
        else if (entry.miss && STATS_ANSWER_ALL && endpoint === 'stats' && method === 'POST' && !isStatsLearnSample(appId, body)) {
          const answer = await tryEdgeAnswer(budget, request, url, endpoint, appId, body, new TextDecoder().decode(requestBody), {})
          if (answer)
            return answer
        }
      }
    }

    // Regional worker URLs - each worker is co-located with its database replica
    const WORKER_URL = {
      ASIA: 'https://plugin.as.capgo.app', // AS_INDIA DB (Mumbai)
      EUROPE: 'https://plugin.eu.capgo.app', // EU DB
      NORTH_AMERICA: 'https://plugin.na.capgo.app', // NA DB
      SOUTH_AMERICA: 'https://plugin.sa.capgo.app', // SA DB
      OCEANIA: 'https://plugin.oc.capgo.app', // OC DB
      AFRICA: 'https://plugin.af.capgo.app', // Google AF DB (africa-south1)
      MIDDLE_EAST: 'https://plugin.me.capgo.app', // Google ME DB (me-central1)
      HONG_KONG: 'https://plugin.hk.capgo.app', // Google HK DB (asia-east2)
      JAPAN: 'https://plugin.jp.capgo.app', // AS_JAPAN DB (Tokyo)
    }

    // Zone codes used for routing decisions
    const ZONE = {
      ASIA: 'AS',
      EUROPE: 'EU',
      NORTH_AMERICA: 'NA',
      SOUTH_AMERICA: 'SA',
      OCEANIA: 'OC',
      AFRICA: 'AF',
      MIDDLE_EAST: 'ME',
      HONG_KONG: 'HK',
      JAPAN: 'JP',
    }


    // Fallback order for each zone
    const zoneFallbackUrls = {
      [ZONE.HONG_KONG]: [WORKER_URL.HONG_KONG, WORKER_URL.JAPAN, WORKER_URL.ASIA],
      [ZONE.JAPAN]: [WORKER_URL.JAPAN, WORKER_URL.HONG_KONG, WORKER_URL.ASIA],
      [ZONE.ASIA]: [WORKER_URL.ASIA, WORKER_URL.HONG_KONG, WORKER_URL.EUROPE],
      [ZONE.AFRICA]: [WORKER_URL.AFRICA, WORKER_URL.ASIA, WORKER_URL.EUROPE],
      [ZONE.MIDDLE_EAST]: [WORKER_URL.MIDDLE_EAST, WORKER_URL.ASIA, WORKER_URL.EUROPE],
      [ZONE.EUROPE]: [WORKER_URL.EUROPE, WORKER_URL.NORTH_AMERICA],
      [ZONE.NORTH_AMERICA]: [WORKER_URL.NORTH_AMERICA, WORKER_URL.EUROPE],
      [ZONE.SOUTH_AMERICA]: [WORKER_URL.SOUTH_AMERICA, WORKER_URL.NORTH_AMERICA, WORKER_URL.EUROPE],
      [ZONE.OCEANIA]: [WORKER_URL.OCEANIA, WORKER_URL.HONG_KONG, WORKER_URL.ASIA],
    }

    // Use the cf object to obtain the colo of the request
    // colo: The three-letter IATA airport code of the data center that the request hit, for example, "DFW".
    // more on the cf object: https://developers.cloudflare.com/workers/runtime-apis/request#incomingrequestcfproperties
    const colo = request.cf.colo
    const regionToZone = {
      EU: ZONE.EUROPE, NA: ZONE.NORTH_AMERICA, SA: ZONE.SOUTH_AMERICA, OC: ZONE.OCEANIA,
      AS_INDIA: ZONE.ASIA, AS_JAPAN: ZONE.JAPAN, HK: ZONE.HONG_KONG, AF: ZONE.AFRICA, ME: ZONE.MIDDLE_EAST,
    }
    const zone = regionToZone[trustedIngressRegion(colo)] ?? ZONE.EUROPE
    const pathWithQuery = url.pathname + url.search

    const regionByUrl = {
      [WORKER_URL.EUROPE]: 'EU', [WORKER_URL.NORTH_AMERICA]: 'NA', [WORKER_URL.SOUTH_AMERICA]: 'SA',
      [WORKER_URL.OCEANIA]: 'OC', [WORKER_URL.ASIA]: 'AS_INDIA', [WORKER_URL.JAPAN]: 'AS_JAPAN',
      [WORKER_URL.HONG_KONG]: 'HK', [WORKER_URL.AFRICA]: 'AF', [WORKER_URL.MIDDLE_EAST]: 'ME',
    }
    const preferred = zoneFallbackUrls[zone] || [WORKER_URL.EUROPE]
    const fallbackUrls = servingPolicy
      ? [...new Set([...preferred, ...Object.values(WORKER_URL)])].filter(target => servingPolicy.regions.includes(regionByUrl[target])).slice(0, 3)
      : preferred
    // Set once a worker is skipped or fails; an on-prem answer seen after that is served but not cached.
    let fallbackFailure = false
    // Budget order: a fetch for every worker left, then the /updates IP limit
    // write (it keeps edge answers away from a limited IP), then the breaker.
    const hintReserve = endpoint === 'updates' ? 1 : 0
    const fallbackReserve = servingPolicy ? 0 : 1

    for (let index = 0; index < fallbackUrls.length; index++) {
      const workerUrl = fallbackUrls[index]
      const fetchesLeft = fallbackUrls.length - index
      const circuit = canSpend(budget, 1, fetchesLeft + (index > 0 ? hintReserve : 0) + fallbackReserve)
        ? await readCircuit(budget, hostname, colo, workerUrl)
        : { healthy: true, hasEntry: false }
      // Skip unhealthy workers (circuit is open)
      if (!circuit.healthy) {
        fallbackFailure = true
        console.log(`Skipping ${workerUrl} (circuit open for ${colo})`)
        continue
      }
      if (!canSpend(budget, 1, fallbackReserve))
        break

      let timeoutId
      const abortController = new AbortController()
      try {
        const timeoutMs = budget.deadline === null ? TIMEOUT_MS : Math.min(TIMEOUT_MS, budget.deadline - Date.now())
        timeoutId = setTimeout(() => abortController.abort(), timeoutMs)

        budget.used++
        const response = await withinServingDeadline(budget, () => fetch(`${workerUrl}${pathWithQuery}`, {
          method: request.method,
          headers: forwardedHeaders,
          redirect: 'manual',
          body: requestBody ? requestBody.slice(0) : undefined,
          signal: abortController.signal,
        }))

        clearTimeout(timeoutId)

        // Check for server errors (5xx) - infrastructure problem
        if (response.status >= 500) {
          fallbackFailure = true
          console.log(`${workerUrl} returned ${response.status}, marking unhealthy`)
          if (canSpend(budget, 1, fetchesLeft - 1 + hintReserve + fallbackReserve))
            await markUnhealthy(budget, hostname, colo, workerUrl)
          continue // try fallback
        }

        // Success (2xx, 3xx, 4xx) - worker is healthy
        if (circuit.hasEntry && canSpend(budget, 1, hintReserve + fallbackReserve))
          await withinServingDeadline(budget, () => cacheDelete(budget, getCircuitBreakerCacheKey(hostname, colo, workerUrl))).catch(() => {})
        console.log(`Request served by ${workerUrl}`)
        // A KV canary response must not seed any cache shared with DB/control
        // devices. Keep rate-limit hints, but never learn its app-wide answers.
        // X-Plugin-State-Shared: KV is authoritative (every device reads it).
        const kvCanary = !!response.headers.get('X-Plugin-State')?.startsWith('kv') && response.headers.get('X-Plugin-State-Shared') !== '1'
        const canCacheWorkerAnswer = !response.headers.has('X-Serving-Regions') && !kvCanary

        // Check if this is an on-prem response that should be cached
        if (appId && endpoint) {
          try {
            const responseBody = await response.clone().json()

            // Return on the first on-prem answer. Confirming with another worker costs
            // extra subrequests and blows the Enterprise snippet limit (5), which turns
            // every on-prem request into a 1101. Stale on-prem entries from replica lag
            // are purged by tag on app/version create. During a partial outage the answer is
            // served but not cached.
            if (isOnPremResponse(response.status, responseBody) && !response.headers.has(EDGE_IP_LIMIT_HEADER)) {
              console.log(`On-prem detected by ${workerUrl} for ${appId}${fallbackFailure ? ' (after fallback failure, not caching)' : ''}`)
              if (!fallbackFailure && edgeKey && canCacheWorkerAnswer)
                await setOnPremCache(budget, edgeKey, appId, endpoint, method, responseBody, response.status, response.headers)
              return buildOnPremResponse(appId, responseBody, response.status, response.headers)
            }

            if (isPlanUpgradeResponse(response.status, responseBody)) {
              // Cache plan-upgrade responses for a short TTL to reduce burst traffic
              if (edgeKey && canCacheWorkerAnswer)
                await setPlanUpgradeCache(budget, edgeKey, appId, endpoint, method, responseBody, response.status, response.headers)

              const newHeaders = new Headers(response.headers)
              newHeaders.set('Content-Type', 'application/json')
              newHeaders.set('X-Plan-Upgrade-Cached', 'false')
              newHeaders.set('X-Plan-Upgrade-App-Id', appId)

              return new Response(JSON.stringify(responseBody), {
                status: response.status,
                headers: newHeaders,
              })
            }
          }
          catch {
            // Response is not JSON or parsing failed - skip on-prem cache check and return original response
          }
          return await handleEdgeHints(budget, response, request, hostname, edgeKey, appId, endpoint, !fallbackFailure && !response.headers.has('X-Serving-Regions'), edgeDoc, kvCanary)
        }

        return response
      }
      catch (error) {
        abortController.abort()
        clearTimeout(timeoutId)
        // Network failure or timeout - mark unhealthy
        fallbackFailure = true
        console.log(`${workerUrl} failed: ${error.message}, marking unhealthy`)
        if (canSpend(budget, 1, fetchesLeft - 1 + hintReserve + fallbackReserve))
          await markUnhealthy(budget, hostname, colo, workerUrl)
        // continue to next fallback
      }
      finally {
        clearTimeout(timeoutId)
      }
    }

    if (servingPolicy || !canSpend(budget, 1, 0)) {
      console.log('Subrequest budget exhausted, no worker answered')
      return new Response(JSON.stringify({ error: 'service_unavailable', message: 'Service temporarily unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
      })
    }

    console.log('All workers failed, falling back to original request')

    // All workers failed or are unhealthy - try the original request as last resort.
    // Body was consumed into requestBody — rebuild Request when needed.
    if (requestBody) {
      return fetch(new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: requestBody.slice(0),
      }))
    }
    return fetch(request)
  },
}
