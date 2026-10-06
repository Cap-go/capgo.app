// Rules to match requests this Snippet will handle
// Expression
// (http.host eq "plugin.capgo.app")
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

// On-prem and plan-upgrade caching use worker Cache-Control, with Retry-After as TTL fallback.
// Cached responses keep Retry-After / X-RateLimit-Reset so clients and edge skip the worker.

// Edge answers: the plugin worker marks answers this snippet may repeat with
// X-Capgo-Edge-Fill (see plugin_runtime/utils/snippetEdgeAnswer.ts). They are
// stored per data center under the app's purge tags, then served here without
// invoking a worker. Every served answer carries X-Capgo-Edge-Stat, which
// Logpush ships to R2 so the worker replays its stats in batches.
const EDGE_FILL_HEADER = 'X-Capgo-Edge-Fill'
const EDGE_IP_LIMIT_HEADER = 'X-Capgo-Edge-Ip-Limit'
const EDGE_STAT_HEADER = 'X-Capgo-Edge-Stat'
const EDGE_KIND_HEADER = 'X-Edge-Kind'
const MAX_EDGE_VARIANTS = 32
const MAX_EDGE_ACTIONS = 64
// Logpush header fields and the replay queue messages stay small.
const MAX_EDGE_STAT_BODY_BYTES = 6000
const APP_ID_RE = /^[a-z0-9]+(?:\.[\w-]+)+$/i
const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLAIN_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const DEVICE_PLATFORMS = new Set(['ios', 'android', 'electron'])

function createBudget() {
  return { used: 0 }
}

/** True when `count` more subrequests fit and still leave `reserve` for later ones. */
function canSpend(budget, count = 1, reserve = 0) {
  return budget.used + count + reserve <= MAX_SUBREQUESTS
}

async function cacheMatch(budget, key) {
  budget.used++
  try {
    return await caches.default.match(key)
  }
  catch {
    return undefined
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

// One entry per app, endpoint and method: an on-prem or plan-upgrade answer,
// or the edge answers. One lookup serves all three.
function getEdgeCacheKey(hostname, appId, endpoint, method) {
  return `https://${hostname}/__internal__/edge-v3/${encodeURIComponent(appId)}/${endpoint}/${method}`
}

function getIpLimitCacheKey(hostname, ip) {
  return `https://${hostname}/__internal__/edge-ip-limit-v1/${encodeURIComponent(ip)}`
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
  if (await cachePut(budget, getCircuitBreakerCacheKey(hostname, colo, workerUrl), response))
    console.log(`Circuit OPEN for ${colo} → ${workerUrl}`)
}

/** Reads the breaker once; `hasEntry` lets a success clear it without another lookup. */
async function readCircuit(budget, hostname, colo, workerUrl) {
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
}

// On-prem caching helper functions
function matchesEndpoint(pathname, endpoint) {
  // More precise matching to avoid false positives (e.g., '/api/updates_history' matching '/updates')
  // Note: pathname never includes query strings (those are in url.search), so we only check exact match and path prefix
  return pathname === endpoint || pathname.startsWith(`${endpoint}/`)
}

function getEndpointName(pathname) {
  if (matchesEndpoint(pathname, '/updates'))
    return 'updates'
  if (matchesEndpoint(pathname, '/stats'))
    return 'stats'
  if (matchesEndpoint(pathname, '/channel_self'))
    return 'channel_self'
  return 'unknown'
}

function isCacheableEndpoint(pathname) {
  return ONPREM_CACHEABLE_ENDPOINTS.some(ep => matchesEndpoint(pathname, ep))
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

async function setOnPremCache(budget, hostname, appId, endpoint, method, responseBody, status, responseHeaders) {
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
  headers.set('Cache-Tag', `app-onprem-v2:${appId}`)
  headers.set('X-Onprem-Cached', 'true')
  headers.set('X-Onprem-App-Id', appId)
  headers.set('X-Onprem-Ttl', String(cacheTtl))
  headers.set(EDGE_KIND_HEADER, 'onprem')
  applyEdgeRateLimitCacheHeaders(headers, responseBody, cacheTtl)

  const response = new Response(JSON.stringify(responseBody), { status, headers })
  if (await cachePut(budget, getEdgeCacheKey(hostname, appId, endpoint, method), response))
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

async function setPlanUpgradeCache(budget, hostname, appId, endpoint, method, responseBody, status, responseHeaders) {
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
  headers.set('Cache-Tag', `app-plan-v2:${appId}`)
  headers.set('X-Plan-Upgrade-Cached', 'true')
  headers.set('X-Plan-Upgrade-App-Id', appId)
  headers.set('X-Plan-Upgrade-Ttl', String(cacheTtl))
  headers.set(EDGE_KIND_HEADER, 'plan')
  applyEdgeRateLimitCacheHeaders(headers, responseBody, cacheTtl)
  const response = new Response(JSON.stringify(responseBody), { status, headers })
  if (await cachePut(budget, getEdgeCacheKey(hostname, appId, endpoint, method), response))
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

function updatesVariantKey(body) {
  return `${body.platform}|${typeof body.defaultChannel === 'string' ? body.defaultChannel : ''}`
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
    && isOptionalString(body.defaultChannel)
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
 * The stats request schema, an action the worker already accepted for this
 * app, and never an install or a failure: rollout auto-pause compares those
 * two live, so they always reach the worker.
 */
function isAnswerableStatsEvent(event, appId, actions) {
  return isPlainObject(event)
    && event.app_id === appId
    && typeof event.device_id === 'string' && DEVICE_ID_RE.test(event.device_id)
    && typeof event.platform === 'string'
    && typeof event.version_name === 'string'
    && typeof event.version_os === 'string'
    && typeof event.is_emulator === 'boolean' && typeof event.is_prod === 'boolean'
    && typeof event.action === 'string' && event.action !== 'set' && !event.action.endsWith('_fail') && actions.includes(event.action)
    && ['defaultChannel', 'channel', 'old_version_name', 'version_code', 'plugin_version', 'version_build'].every(key => isOptionalString(event[key]))
    && isOptionalString(event.install_source, 64)
    && isOptionalString(event.custom_id, 36)
    && isOptionalString(event.key_id, 20)
    && isValidStatsMetadata(event.metadata)
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

function edgeAnswerResponse(body, stat) {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Capgo-Edge': 'answer',
      [EDGE_STAT_HEADER]: base64UrlEncode(JSON.stringify(stat)),
    },
  })
}

/** Serves the request from the app's edge answers, or returns null to call the worker. */
async function tryEdgeAnswer(budget, request, hostname, endpoint, appId, body, rawBody, doc) {
  // Browser callers need the worker's CORS answer; Logpush keeps small headers only.
  if (request.headers.has('Origin') || rawBody.length > MAX_EDGE_STAT_BODY_BYTES || !APP_ID_RE.test(appId))
    return null

  if (endpoint === 'updates') {
    const fill = doc.variants?.[updatesVariantKey(body)]
    if (!isLiveEdgeFill(fill, appId, body?.device_id) || typeof fill.r !== 'string' || !isAnswerableUpdatesBody(body, appId, fill))
      return null
    // An up-to-date answer confirms the bundle name: never give it to an IP
    // the worker's update enumeration guard limited.
    const ip = request.headers.get('cf-connecting-ip')
    if (!ip || !canSpend(budget, 1, 2))
      return null
    if (await cacheMatch(budget, getIpLimitCacheKey(hostname, ip)))
      return null
    return edgeAnswerResponse(fill.r, { e: 'updates', b: rawBody, o: fill.o, a: fill.a, n: fill.n })
  }

  if (endpoint === 'stats') {
    const fill = doc.stats
    const events = Array.isArray(body) ? body : [body]
    if (events.length === 0 || !isLiveEdgeFill(fill, appId, events[0]?.device_id) || !Array.isArray(fill.actions))
      return null
    if (!events.every(event => isAnswerableStatsEvent(event, appId, fill.actions)))
      return null
    const answer = Array.isArray(body)
      ? { status: 'ok', results: events.map((_, index) => ({ status: 'ok', index })) }
      : { status: 'ok' }
    return edgeAnswerResponse(JSON.stringify(answer), { e: 'stats', b: rawBody })
  }

  return null
}

function parseEdgeFill(value, endpoint) {
  try {
    const fill = JSON.parse(decodeURIComponent(value))
    if (!isPlainObject(fill) || fill.v !== 1 || fill.e !== endpoint || typeof fill.tags !== 'string')
      return null
    if (typeof fill.bps !== 'number' || fill.bps <= 0 || fill.bps > 10000 || typeof fill.ttl !== 'number' || fill.ttl < 1 || fill.ttl > 3600)
      return null
    if (endpoint === 'updates' && (typeof fill.n !== 'string' || typeof fill.o !== 'string' || typeof fill.a !== 'boolean' || typeof fill.cs !== 'boolean' || (fill.k !== null && typeof fill.k !== 'string')))
      return null
    return fill
  }
  catch {
    return null
  }
}

/** Merges a fill into the app's edge answers entry and stores it (one subrequest). */
async function storeEdgeFill(budget, hostname, appId, endpoint, method, doc, fill, body, responseText) {
  const now = Date.now()
  const entry = { ...fill, exp: now + fill.ttl * 1000 }
  let next
  if (endpoint === 'updates') {
    entry.r = responseText
    const variants = Object.entries(doc?.variants ?? {})
      .filter(([, value]) => isPlainObject(value) && value.exp > now)
    variants.push([updatesVariantKey(body), entry])
    // Keep the freshest variants when an app has many platform/channel pairs.
    variants.sort((a, b) => b[1].exp - a[1].exp)
    next = { variants: Object.fromEntries(variants.slice(0, MAX_EDGE_VARIANTS)) }
  }
  else {
    const events = Array.isArray(body) ? body : [body]
    const previous = isPlainObject(doc?.stats) && doc.stats.exp > now && Array.isArray(doc.stats.actions) ? doc.stats.actions : []
    const seen = events.map(event => event?.action).filter(action => typeof action === 'string')
    entry.actions = [...new Set([...previous, ...seen])].slice(0, MAX_EDGE_ACTIONS)
    next = { stats: entry }
  }
  const values = Object.values(next.variants ?? { stats: next.stats })
  const maxAge = Math.max(1, Math.ceil((Math.max(...values.map(value => value.exp)) - now) / 1000))
  const response = new Response(JSON.stringify(next), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${maxAge}`,
      'Cache-Tag': fill.tags,
      [EDGE_KIND_HEADER]: 'answers',
    },
  })
  if (await cachePut(budget, getEdgeCacheKey(hostname, appId, endpoint, method), response))
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
async function handleEdgeHints(budget, response, request, hostname, appId, endpoint, method, doc, body, canCache) {
  const fillHeader = response.headers.get(EDGE_FILL_HEADER)
  const ipLimitHeader = response.headers.get(EDGE_IP_LIMIT_HEADER)
  if (!fillHeader && !ipLimitHeader)
    return response

  const headers = new Headers(response.headers)
  headers.delete(EDGE_FILL_HEADER)
  headers.delete(EDGE_IP_LIMIT_HEADER)

  if (ipLimitHeader && canSpend(budget))
    await storeIpLimit(budget, hostname, request.headers.get('cf-connecting-ip'), Number.parseInt(ipLimitHeader, 10))

  if (fillHeader && canCache && response.status === 200 && canSpend(budget)) {
    const fill = parseEdgeFill(fillHeader, endpoint)
    if (fill) {
      const text = await response.text()
      await storeEdgeFill(budget, hostname, appId, endpoint, method, doc, fill, body, text)
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
    let edgeDoc = null
    if (isCacheableEndpoint(url.pathname)) {
      endpoint = getEndpointName(url.pathname)
      body = parseJsonBody(requestBody)
      appId = extractAppIdFromRequest(request, url, body)

      if (appId) {
        const cached = await cacheMatch(budget, getEdgeCacheKey(hostname, appId, endpoint, method))
        if (cached) {
          if (cached.headers.get(EDGE_KIND_HEADER) !== 'answers') {
            console.log(`Edge cache HIT (${cached.headers.get(EDGE_KIND_HEADER)}) for ${appId}/${endpoint}/${method}`)
            return await withFreshRateLimitHeaders(cached)
          }
          try {
            edgeDoc = await cached.json()
          }
          catch {
            edgeDoc = null
          }
          if (edgeDoc && method === 'POST') {
            const rawBody = new TextDecoder().decode(requestBody)
            const answer = await tryEdgeAnswer(budget, request, hostname, endpoint, appId, body, rawBody, edgeDoc)
            if (answer)
              return answer
          }
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

    // Maps Cloudflare colo (data center) codes to zones
    // Full list: https://github.com/Netrvin/cloudflare-colo-list/blob/main/DC-Colos.json
    const coloToZone = {
      AAE: ZONE.AFRICA, // Annaba, Algeria
      ABJ: ZONE.AFRICA, // Abidjan, Ivory Coast
      ABQ: ZONE.NORTH_AMERICA, // Albuquerque, USA
      ACC: ZONE.AFRICA, // Accra, Ghana
      ACX: ZONE.HONG_KONG, // Xingyi, China
      ADB: ZONE.EUROPE, // Izmir, Turkey
      ADD: ZONE.AFRICA, // Addis Ababa, Ethiopia
      ADL: ZONE.OCEANIA, // Adelaide, Australia
      AGR: ZONE.ASIA, // Agra, India
      AIP: ZONE.ASIA, // Jalandhar, India
      AKL: ZONE.OCEANIA, // Auckland, New Zealand
      AKX: ZONE.ASIA, // Aktobe, Kazakhstan
      ALA: ZONE.ASIA, // Almaty, Kazakhstan
      ALG: ZONE.AFRICA, // Algiers, Algeria
      AMD: ZONE.ASIA, // Ahmedabad, India
      AMM: ZONE.MIDDLE_EAST, // Amman, Jordan
      AMS: ZONE.EUROPE, // Amsterdam, Netherlands
      ANC: ZONE.NORTH_AMERICA, // Anchorage, USA
      ARI: ZONE.SOUTH_AMERICA, // Arica, Chile
      ARN: ZONE.EUROPE, // Stockholm, Sweden
      ARU: ZONE.SOUTH_AMERICA, // Aracatuba, Brazil
      ASK: ZONE.AFRICA, // Yamoussoukro, Ivory Coast
      ASU: ZONE.SOUTH_AMERICA, // Asunción, Paraguay
      ATH: ZONE.EUROPE, // Athens, Greece
      ATL: ZONE.NORTH_AMERICA, // Atlanta, USA
      AUS: ZONE.NORTH_AMERICA, // Austin, USA
      AVA: ZONE.HONG_KONG, // Anshun, China
      BAH: ZONE.MIDDLE_EAST, // Manama, Bahrain
      BAQ: ZONE.SOUTH_AMERICA, // Barranquilla, Colombia
      BBI: ZONE.ASIA, // Bhubaneswar, India
      BCN: ZONE.EUROPE, // Barcelona, Spain
      BDQ: ZONE.ASIA, // Jamnagar (Vadodara airport code), India
      BEG: ZONE.EUROPE, // Belgrade, Serbia
      BEL: ZONE.SOUTH_AMERICA, // Belém, Brazil
      BEY: ZONE.MIDDLE_EAST, // Beirut, Lebanon
      BGI: ZONE.NORTH_AMERICA, // Bridgetown, Barbados
      BGR: ZONE.NORTH_AMERICA, // Bangor, USA
      BGW: ZONE.MIDDLE_EAST, // Baghdad, Iraq
      BHY: ZONE.HONG_KONG, // Beihai, China
      BKK: ZONE.HONG_KONG, // Bangkok, Thailand
      BLR: ZONE.ASIA, // Bangalore, India
      BNA: ZONE.NORTH_AMERICA, // Nashville, USA
      BNE: ZONE.OCEANIA, // Brisbane, Australia
      BNU: ZONE.SOUTH_AMERICA, // Blumenau, Brazil
      BOD: ZONE.EUROPE, // Bordeaux, France
      BOG: ZONE.SOUTH_AMERICA, // Bogota, Colombia
      BOM: ZONE.ASIA, // Mumbai, India
      BOS: ZONE.NORTH_AMERICA, // Boston, USA
      BRU: ZONE.EUROPE, // Brussels, Belgium
      BSB: ZONE.SOUTH_AMERICA, // Brasilia, Brazil
      BSR: ZONE.MIDDLE_EAST, // Basra, Iraq
      BTS: ZONE.EUROPE, // Bratislava, Slovakia
      BUD: ZONE.EUROPE, // Budapest, Hungary
      BUF: ZONE.NORTH_AMERICA, // Buffalo, USA
      BWN: ZONE.HONG_KONG, // Bandar Seri Begawan, Brunei
      CAI: ZONE.AFRICA, // Cairo, Egypt
      CAN: ZONE.HONG_KONG, // Guangzhou, China
      CAW: ZONE.SOUTH_AMERICA, // Campos dos Goytacazes, Brazil
      CBR: ZONE.OCEANIA, // Canberra, Australia
      CCP: ZONE.SOUTH_AMERICA, // Concepción, Chile
      CCU: ZONE.ASIA, // Kolkata, India
      CDG: ZONE.EUROPE, // Paris, France
      CEB: ZONE.HONG_KONG, // Cebu, Philippines
      CFC: ZONE.SOUTH_AMERICA, // Cacador, Brazil
      CGB: ZONE.SOUTH_AMERICA, // Cuiaba, Brazil
      CGD: ZONE.HONG_KONG, // Changde, China
      CGK: ZONE.HONG_KONG, // Jakarta, Indonesia
      CGO: ZONE.HONG_KONG, // Zhengzhou, China
      CGP: ZONE.ASIA, // Chittagong, Bangladesh
      CGY: ZONE.HONG_KONG, // Cagayan de Oro, Philippines
      CHC: ZONE.OCEANIA, // Christchurch, New Zealand
      CJB: ZONE.ASIA, // Coimbatore, India
      CKG: ZONE.HONG_KONG, // Chongqing, China
      CLE: ZONE.NORTH_AMERICA, // Cleveland, USA
      CLO: ZONE.SOUTH_AMERICA, // Cali, Colombia
      CLT: ZONE.NORTH_AMERICA, // Charlotte, USA
      CMB: ZONE.ASIA, // Colombo, Sri Lanka
      CMH: ZONE.NORTH_AMERICA, // Columbus, USA
      CNF: ZONE.SOUTH_AMERICA, // Belo Horizonte, Brazil
      CNN: ZONE.ASIA, // Kannur, India
      CNX: ZONE.HONG_KONG, // Chiang Mai, Thailand
      COK: ZONE.ASIA, // Kochi, India
      COR: ZONE.SOUTH_AMERICA, // Córdoba, Argentina
      CPH: ZONE.EUROPE, // Copenhagen, Denmark
      CPT: ZONE.AFRICA, // Cape Town, South Africa
      CRK: ZONE.HONG_KONG, // Tarlac City (Clark), Philippines
      CSX: ZONE.HONG_KONG, // Changsha, China
      CTS: ZONE.JAPAN, // Sapporo, Japan
      CTU: ZONE.HONG_KONG, // Chengdu, China
      CVG: ZONE.NORTH_AMERICA, // Cincinnati, USA
      CWB: ZONE.SOUTH_AMERICA, // Curitiba, Brazil
      CZL: ZONE.AFRICA, // Constantine, Algeria
      CZX: ZONE.HONG_KONG, // Changzhou, China
      DAC: ZONE.ASIA, // Dhaka, Bangladesh
      DAD: ZONE.HONG_KONG, // Da Nang, Vietnam
      DAR: ZONE.AFRICA, // Dar es Salaam, Tanzania
      DEL: ZONE.ASIA, // New Delhi, India
      DEN: ZONE.NORTH_AMERICA, // Denver, USA
      DFW: ZONE.NORTH_AMERICA, // Dallas, USA
      DKR: ZONE.AFRICA, // Dakar, Senegal
      DLA: ZONE.AFRICA, // Douala, Cameroon
      DLC: ZONE.HONG_KONG, // Dalian, China
      DME: ZONE.EUROPE, // Moscow, Russia
      DMM: ZONE.MIDDLE_EAST, // Dammam, Saudi Arabia
      DOH: ZONE.MIDDLE_EAST, // Doha, Qatar
      DPS: ZONE.HONG_KONG, // Denpasar (Bali), Indonesia
      DTW: ZONE.NORTH_AMERICA, // Detroit, USA
      DUB: ZONE.EUROPE, // Dublin, Ireland
      DUR: ZONE.AFRICA, // Durban, South Africa
      DUS: ZONE.EUROPE, // Düsseldorf, Germany
      DXB: ZONE.MIDDLE_EAST, // Dubai, UAE
      DYU: ZONE.ASIA, // Dushanbe, Tajikistan
      EBB: ZONE.AFRICA, // Kampala, Uganda
      EBL: ZONE.MIDDLE_EAST, // Erbil, Iraq
      EVN: ZONE.ASIA, // Yerevan, Armenia
      EWR: ZONE.NORTH_AMERICA, // Newark, USA
      EZE: ZONE.SOUTH_AMERICA, // Buenos Aires, Argentina
      FCO: ZONE.EUROPE, // Rome, Italy
      FIH: ZONE.AFRICA, // Kinshasa, DR Congo
      FLN: ZONE.SOUTH_AMERICA, // Florianopolis, Brazil
      FOC: ZONE.HONG_KONG, // Fuzhou, China
      FOR: ZONE.SOUTH_AMERICA, // Fortaleza, Brazil
      FRA: ZONE.EUROPE, // Frankfurt, Germany
      FRU: ZONE.ASIA, // Bishkek, Kyrgyzstan
      FSD: ZONE.NORTH_AMERICA, // Sioux Falls, USA
      FUK: ZONE.JAPAN, // Fukuoka, Japan
      FUO: ZONE.HONG_KONG, // Foshan, China
      GBE: ZONE.AFRICA, // Gaborone, Botswana
      GDL: ZONE.NORTH_AMERICA, // Guadalajara, Mexico
      GEO: ZONE.SOUTH_AMERICA, // Georgetown, Guyana
      GIG: ZONE.SOUTH_AMERICA, // Rio de Janeiro, Brazil
      GND: ZONE.SOUTH_AMERICA, // St. George's, Grenada
      GOT: ZONE.EUROPE, // Gothenburg, Sweden
      GRU: ZONE.SOUTH_AMERICA, // São Paulo, Brazil
      GUA: ZONE.NORTH_AMERICA, // Guatemala City, Guatemala
      GUM: ZONE.ASIA, // Hagatna, Guam
      GVA: ZONE.EUROPE, // Geneva, Switzerland
      GYD: ZONE.ASIA, // Baku, Azerbaijan
      GYE: ZONE.SOUTH_AMERICA, // Guayaquil, Ecuador
      GYN: ZONE.SOUTH_AMERICA, // Goiania, Brazil
      HAK: ZONE.HONG_KONG, // Chengmai (Haikou), China
      HAM: ZONE.EUROPE, // Hamburg, Germany
      HAN: ZONE.HONG_KONG, // Hanoi, Vietnam
      HBA: ZONE.OCEANIA, // Hobart, Australia
      HEL: ZONE.EUROPE, // Helsinki, Finland
      HFA: ZONE.MIDDLE_EAST, // Haifa, Israel
      HGH: ZONE.HONG_KONG, // Shaoxing (Hangzhou), China
      HKG: ZONE.HONG_KONG, // Hong Kong
      HNL: ZONE.NORTH_AMERICA, // Honolulu, USA
      HRE: ZONE.AFRICA, // Harare, Zimbabwe
      HYD: ZONE.ASIA, // Hyderabad, India
      HYN: ZONE.HONG_KONG, // Taizhou, China
      IAD: ZONE.NORTH_AMERICA, // Ashburn (Washington DC), USA
      IAH: ZONE.NORTH_AMERICA, // Houston, USA
      ICN: ZONE.JAPAN, // Seoul, South Korea (North Asia -> Japan)
      IND: ZONE.NORTH_AMERICA, // Indianapolis, USA
      ISB: ZONE.ASIA, // Islamabad, Pakistan
      IST: ZONE.EUROPE, // Istanbul, Turkey
      ISU: ZONE.MIDDLE_EAST, // Sulaymaniyah, Iraq
      ITJ: ZONE.SOUTH_AMERICA, // Itajai, Brazil
      IXC: ZONE.ASIA, // Chandigarh, India
      JAX: ZONE.NORTH_AMERICA, // Jacksonville, USA
      JDO: ZONE.SOUTH_AMERICA, // Juazeiro do Norte, Brazil
      JED: ZONE.MIDDLE_EAST, // Jeddah, Saudi Arabia
      JHB: ZONE.HONG_KONG, // Johor Bahru, Malaysia
      JIB: ZONE.AFRICA, // Djibouti
      JNB: ZONE.AFRICA, // Johannesburg, South Africa
      JOG: ZONE.HONG_KONG, // Yogyakarta, Indonesia
      JOI: ZONE.SOUTH_AMERICA, // Joinville, Brazil
      JRG: ZONE.ASIA, // Sambalpur, India
      JXG: ZONE.HONG_KONG, // Jiaxing, China
      KBP: ZONE.EUROPE, // Kyiv, Ukraine
      KCH: ZONE.HONG_KONG, // Kuching, Malaysia
      KEF: ZONE.EUROPE, // Reykjavík, Iceland
      KGL: ZONE.AFRICA, // Kigali, Rwanda
      KHH: ZONE.JAPAN, // Kaohsiung City, Taiwan (North Asia -> Japan)
      KHI: ZONE.ASIA, // Karachi, Pakistan
      KHN: ZONE.HONG_KONG, // Nanchang, China
      KIN: ZONE.NORTH_AMERICA, // Kingston, Jamaica
      KIV: ZONE.EUROPE, // Chișinău, Moldova
      KIX: ZONE.JAPAN, // Osaka, Japan
      KJA: ZONE.ASIA, // Krasnoyarsk, Russia
      KMG: ZONE.HONG_KONG, // Kunming, China
      KNU: ZONE.ASIA, // Kanpur, India
      KOJ: ZONE.JAPAN, // Kagoshima, Japan
      KTM: ZONE.ASIA, // Kathmandu, Nepal
      KUL: ZONE.HONG_KONG, // Kuala Lumpur, Malaysia
      KWE: ZONE.HONG_KONG, // Guiyang, China
      KWI: ZONE.MIDDLE_EAST, // Kuwait City, Kuwait
      LAD: ZONE.AFRICA, // Luanda, Angola
      LAS: ZONE.NORTH_AMERICA, // Las Vegas, USA
      LAX: ZONE.NORTH_AMERICA, // Los Angeles, USA
      LCA: ZONE.EUROPE, // Nicosia, Cyprus
      LED: ZONE.EUROPE, // Saint Petersburg, Russia
      LHE: ZONE.ASIA, // Lahore, Pakistan
      LHR: ZONE.EUROPE, // London, UK
      LHW: ZONE.HONG_KONG, // Lanzhou, China
      LIM: ZONE.SOUTH_AMERICA, // Lima, Peru
      LIS: ZONE.EUROPE, // Lisbon, Portugal
      LJU: ZONE.EUROPE, // Ljubljana, Slovenia
      LLK: ZONE.ASIA, // Astara, Azerbaijan
      LLW: ZONE.AFRICA, // Lilongwe, Malawi
      LOS: ZONE.AFRICA, // Lagos, Nigeria
      LPB: ZONE.SOUTH_AMERICA, // La Paz, Bolivia
      LUH: ZONE.ASIA, // Ludhiana, India
      LUN: ZONE.AFRICA, // Lusaka, Zambia
      LUX: ZONE.EUROPE, // Luxembourg City, Luxembourg
      LYA: ZONE.HONG_KONG, // Luoyang, China
      LYS: ZONE.EUROPE, // Lyon, France
      MAA: ZONE.ASIA, // Chennai, India
      MAD: ZONE.EUROPE, // Madrid, Spain
      MAN: ZONE.EUROPE, // Manchester, UK
      MAO: ZONE.SOUTH_AMERICA, // Manaus, Brazil
      MBA: ZONE.AFRICA, // Mombasa, Kenya
      MCI: ZONE.NORTH_AMERICA, // Kansas City, USA
      MCT: ZONE.MIDDLE_EAST, // Muscat, Oman
      MDE: ZONE.SOUTH_AMERICA, // Medellín, Colombia
      MEL: ZONE.OCEANIA, // Melbourne, Australia
      MEM: ZONE.NORTH_AMERICA, // Memphis, USA
      MEX: ZONE.NORTH_AMERICA, // Mexico City, Mexico
      MFM: ZONE.HONG_KONG, // Macau
      MIA: ZONE.NORTH_AMERICA, // Miami, USA
      MLA: ZONE.EUROPE, // Santa Venera, Malta
      MLE: ZONE.ASIA, // Male, Maldives
      MLG: ZONE.HONG_KONG, // Malang, Indonesia
      MNL: ZONE.HONG_KONG, // Manila, Philippines
      MPM: ZONE.AFRICA, // Maputo, Mozambique
      MRS: ZONE.EUROPE, // Marseille, France
      MRU: ZONE.AFRICA, // Port Louis, Mauritius
      MSP: ZONE.NORTH_AMERICA, // Minneapolis, USA
      MSQ: ZONE.EUROPE, // Minsk, Belarus
      MUC: ZONE.EUROPE, // Munich, Germany
      MXP: ZONE.EUROPE, // Milan, Italy
      NAG: ZONE.ASIA, // Nagpur, India
      NBO: ZONE.AFRICA, // Nairobi, Kenya
      NGO: ZONE.JAPAN, // Nagoya, Japan
      NJF: ZONE.MIDDLE_EAST, // Najaf, Iraq
      NNG: ZONE.HONG_KONG, // Nanning, China
      NOU: ZONE.OCEANIA, // Noumea, New Caledonia
      NQN: ZONE.SOUTH_AMERICA, // Neuquen, Argentina
      NQZ: ZONE.ASIA, // Astana, Kazakhstan
      NRT: ZONE.JAPAN, // Tokyo Narita, Japan
      NVT: ZONE.SOUTH_AMERICA, // Timbo (Navegantes), Brazil
      OKA: ZONE.JAPAN, // Naha (Okinawa), Japan
      OKC: ZONE.NORTH_AMERICA, // Oklahoma City, USA
      OMA: ZONE.NORTH_AMERICA, // Omaha, USA
      ORD: ZONE.NORTH_AMERICA, // Chicago, USA
      ORF: ZONE.NORTH_AMERICA, // Norfolk, USA
      ORN: ZONE.AFRICA, // Oran, Algeria
      OSL: ZONE.EUROPE, // Oslo, Norway
      OTP: ZONE.EUROPE, // Bucharest, Romania
      OUA: ZONE.AFRICA, // Ouagadougou, Burkina Faso
      PAT: ZONE.ASIA, // Patna, India
      PBH: ZONE.ASIA, // Thimphu, Bhutan
      PBM: ZONE.SOUTH_AMERICA, // Paramaribo, Suriname
      PDX: ZONE.NORTH_AMERICA, // Portland, USA
      PER: ZONE.OCEANIA, // Perth, Australia
      PHL: ZONE.NORTH_AMERICA, // Philadelphia, USA
      PHX: ZONE.NORTH_AMERICA, // Phoenix, USA
      PIT: ZONE.NORTH_AMERICA, // Pittsburgh, USA
      PKX: ZONE.HONG_KONG, // Langfang (Beijing), China
      PMO: ZONE.EUROPE, // Palermo, Italy
      PMW: ZONE.SOUTH_AMERICA, // Palmas, Brazil
      PNH: ZONE.HONG_KONG, // Phnom Penh, Cambodia
      PNQ: ZONE.ASIA, // Pune, India
      POA: ZONE.SOUTH_AMERICA, // Porto Alegre, Brazil
      POS: ZONE.SOUTH_AMERICA, // Port of Spain, Trinidad
      PPT: ZONE.OCEANIA, // Tahiti, French Polynesia
      PRG: ZONE.EUROPE, // Prague, Czech Republic
      PTY: ZONE.SOUTH_AMERICA, // Panama City, Panama
      QRO: ZONE.NORTH_AMERICA, // Queretaro, Mexico
      QWJ: ZONE.SOUTH_AMERICA, // Americana, Brazil
      RAO: ZONE.SOUTH_AMERICA, // Ribeirao Preto, Brazil
      RDU: ZONE.NORTH_AMERICA, // Durham (Raleigh), USA
      REC: ZONE.SOUTH_AMERICA, // Recife, Brazil
      RIC: ZONE.NORTH_AMERICA, // Richmond, USA
      RIX: ZONE.EUROPE, // Riga, Latvia
      RUH: ZONE.MIDDLE_EAST, // Riyadh, Saudi Arabia
      RUN: ZONE.AFRICA, // Saint-Denis, Réunion
      SAN: ZONE.NORTH_AMERICA, // San Diego, USA
      SAP: ZONE.SOUTH_AMERICA, // San Pedro Sula, Honduras
      SAT: ZONE.NORTH_AMERICA, // San Antonio, USA
      SCL: ZONE.SOUTH_AMERICA, // Santiago, Chile
      SDJ: ZONE.JAPAN, // Sendai, Japan
      SDQ: ZONE.NORTH_AMERICA, // Santo Domingo, Dominican Republic
      SEA: ZONE.NORTH_AMERICA, // Seattle, USA
      SFO: ZONE.NORTH_AMERICA, // San Francisco, USA
      SGN: ZONE.HONG_KONG, // Ho Chi Minh City, Vietnam
      SHA: ZONE.HONG_KONG, // Shanghai, China
      SIN: ZONE.HONG_KONG, // Singapore
      SJC: ZONE.NORTH_AMERICA, // San Jose, USA
      SJK: ZONE.SOUTH_AMERICA, // São José dos Campos, Brazil
      SJO: ZONE.SOUTH_AMERICA, // San José, Costa Rica
      SJP: ZONE.SOUTH_AMERICA, // São José do Rio Preto, Brazil
      SJU: ZONE.NORTH_AMERICA, // San Juan, Puerto Rico
      SJW: ZONE.HONG_KONG, // Shijiazhuang, China
      SKG: ZONE.EUROPE, // Thessaloniki, Greece
      SKP: ZONE.EUROPE, // Skopje, North Macedonia
      SLC: ZONE.NORTH_AMERICA, // Salt Lake City, USA
      SMF: ZONE.NORTH_AMERICA, // Sacramento, USA
      SOD: ZONE.SOUTH_AMERICA, // Sorocaba, Brazil
      SOF: ZONE.EUROPE, // Sofia, Bulgaria
      SSA: ZONE.SOUTH_AMERICA, // Salvador, Brazil
      STI: ZONE.NORTH_AMERICA, // Santiago de los Caballeros, Dominican Republic
      STL: ZONE.NORTH_AMERICA, // St. Louis, USA
      STR: ZONE.EUROPE, // Stuttgart, Germany
      SUV: ZONE.OCEANIA, // Suva, Fiji
      SYD: ZONE.OCEANIA, // Sydney, Australia
      SZX: ZONE.HONG_KONG, // Shenzhen, China
      TAO: ZONE.HONG_KONG, // Qingdao, China
      TBS: ZONE.EUROPE, // Tbilisi, Georgia
      TEN: ZONE.HONG_KONG, // Tongren, China
      TGU: ZONE.SOUTH_AMERICA, // Tegucigalpa, Honduras
      TIA: ZONE.EUROPE, // Tirana, Albania
      TLH: ZONE.NORTH_AMERICA, // Tallahassee, USA
      TLL: ZONE.EUROPE, // Tallinn, Estonia
      TLV: ZONE.MIDDLE_EAST, // Tel Aviv, Israel
      TNA: ZONE.HONG_KONG, // Zibo (Jinan), China
      TNR: ZONE.AFRICA, // Antananarivo, Madagascar
      TPA: ZONE.NORTH_AMERICA, // Tampa, USA
      TPE: ZONE.JAPAN, // Taipei, Taiwan (North Asia -> Japan)
      TUN: ZONE.AFRICA, // Tunis, Tunisia
      TXL: ZONE.EUROPE, // Berlin, Germany
      TYN: ZONE.HONG_KONG, // Yangquan (Taiyuan), China
      UDI: ZONE.SOUTH_AMERICA, // Uberlandia, Brazil
      UDR: ZONE.ASIA, // Udaipur, India
      UIO: ZONE.SOUTH_AMERICA, // Quito, Ecuador
      ULN: ZONE.JAPAN, // Ulaanbaatar, Mongolia (North Asia -> Japan)
      URT: ZONE.HONG_KONG, // Surat Thani, Thailand
      VCP: ZONE.SOUTH_AMERICA, // Campinas, Brazil
      VIE: ZONE.EUROPE, // Vienna, Austria
      VIX: ZONE.SOUTH_AMERICA, // Vitoria, Brazil
      VNO: ZONE.EUROPE, // Vilnius, Lithuania
      VTE: ZONE.HONG_KONG, // Vientiane, Laos
      WAW: ZONE.EUROPE, // Warsaw, Poland
      WDH: ZONE.AFRICA, // Windhoek, Namibia
      WLG: ZONE.OCEANIA, // Wellington, New Zealand
      WRO: ZONE.EUROPE, // Wroclaw, Poland
      XAP: ZONE.SOUTH_AMERICA, // Chapeco, Brazil
      XFN: ZONE.HONG_KONG, // Xiangyang, China
      XIY: ZONE.HONG_KONG, // Baoji (Xi'an), China
      XNH: ZONE.MIDDLE_EAST, // Nasiriyah, Iraq
      XNN: ZONE.HONG_KONG, // Xining, China
      YHZ: ZONE.NORTH_AMERICA, // Halifax, Canada
      YOW: ZONE.NORTH_AMERICA, // Ottawa, Canada
      YUL: ZONE.NORTH_AMERICA, // Montréal, Canada
      YVR: ZONE.NORTH_AMERICA, // Vancouver, Canada
      YWG: ZONE.NORTH_AMERICA, // Winnipeg, Canada
      YXE: ZONE.NORTH_AMERICA, // Saskatoon, Canada
      YYC: ZONE.NORTH_AMERICA, // Calgary, Canada
      YYZ: ZONE.NORTH_AMERICA, // Toronto, Canada
      ZAG: ZONE.EUROPE, // Zagreb, Croatia
      ZDM: ZONE.MIDDLE_EAST, // Ramallah, Palestine
      ZRH: ZONE.EUROPE, // Zurich, Switzerland
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
    const zone = coloToZone[colo] ?? ZONE.EUROPE
    const pathWithQuery = url.pathname + url.search

    const fallbackUrls = zoneFallbackUrls[zone] || [WORKER_URL.EUROPE]
    // Set once a worker is skipped or fails; an on-prem answer seen after that is served but not cached.
    let fallbackFailure = false

    for (let index = 0; index < fallbackUrls.length; index++) {
      const workerUrl = fallbackUrls[index]
      // Keep one subrequest for the worker fetch itself.
      const circuit = canSpend(budget, 1, 1)
        ? await readCircuit(budget, hostname, colo, workerUrl)
        : { healthy: true, hasEntry: false }
      // Skip unhealthy workers (circuit is open)
      if (!circuit.healthy) {
        fallbackFailure = true
        console.log(`Skipping ${workerUrl} (circuit open for ${colo})`)
        continue
      }
      if (!canSpend(budget))
        break

      try {
        const abortController = new AbortController()
        const timeoutId = setTimeout(() => abortController.abort(), TIMEOUT_MS)

        budget.used++
        const response = await fetch(`${workerUrl}${pathWithQuery}`, {
          method: request.method,
          headers: request.headers,
          body: requestBody ? requestBody.slice(0) : undefined,
          signal: abortController.signal,
        })

        clearTimeout(timeoutId)

        // Check for server errors (5xx) - infrastructure problem
        if (response.status >= 500) {
          fallbackFailure = true
          console.log(`${workerUrl} returned ${response.status}, marking unhealthy`)
          // Keep a subrequest for the next worker when there is one.
          if (canSpend(budget, 1, index < fallbackUrls.length - 1 ? 1 : 0))
            await markUnhealthy(budget, hostname, colo, workerUrl)
          continue // try fallback
        }

        // Success (2xx, 3xx, 4xx) - worker is healthy
        if (circuit.hasEntry && canSpend(budget))
          await cacheDelete(budget, getCircuitBreakerCacheKey(hostname, colo, workerUrl))
        console.log(`Request served by ${workerUrl}`)

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
              if (!fallbackFailure)
                await setOnPremCache(budget, hostname, appId, endpoint, method, responseBody, response.status, response.headers)
              return buildOnPremResponse(appId, responseBody, response.status, response.headers)
            }

            if (isPlanUpgradeResponse(response.status, responseBody)) {
              // Cache plan-upgrade responses for a short TTL to reduce burst traffic
              await setPlanUpgradeCache(budget, hostname, appId, endpoint, method, responseBody, response.status, response.headers)

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
          return await handleEdgeHints(budget, response, request, hostname, appId, endpoint, method, edgeDoc, body, !fallbackFailure)
        }

        return response
      }
      catch (error) {
        // Network failure or timeout - mark unhealthy
        fallbackFailure = true
        console.log(`${workerUrl} failed: ${error.message}, marking unhealthy`)
        if (canSpend(budget, 1, index < fallbackUrls.length - 1 ? 1 : 0))
          await markUnhealthy(budget, hostname, colo, workerUrl)
        // continue to next fallback
      }
    }

    if (!canSpend(budget)) {
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
