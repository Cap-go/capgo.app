// index.js
// Alibaba FC HTTP Trigger with Event Function
// Proxies updater.capgo.com.cn with stale-while-revalidate cache.
// After an upstream timeout/error, serve cached JSON/files until a
// revalidate succeeds.
const { Buffer } = require('node:buffer')
const crypto = require('node:crypto')
const https = require('node:https')

const TARGET_HOST = 'updater.capgo.com.cn'
// Capgo plugin/edge often abandons around 3s (CF snippet TIMEOUT_MS=3000).
// Never wait for a full upstream timeout and *then* answer — that response is
// already lost. With a cache: answer within CLIENT_BUDGET_MS. Without cache:
// allow a longer upstream wait for clients that raised responseTimeout.
const CLIENT_BUDGET_MS = 2500
const FETCH_TIMEOUT_MS = 15000
const MAX_CACHE_BYTES = 20 * 1024 * 1024
const MAX_MEMORY_ENTRIES = 200

/** @type {Map<string, CacheEntry>} */
const memoryCache = new Map()
let upstreamDegraded = false

/**
 * @typedef {{
 *   statusCode: number,
 *   headers: Record<string, string | string[] | undefined>,
 *   body: string,
 *   isBase64Encoded: boolean,
 *   cachedAt: number,
 * }} CacheEntry
 */

function isDegraded() {
  return upstreamDegraded
}

function setDegraded(value) {
  upstreamDegraded = value
}

/**
 * @param {string} key
 * @returns {CacheEntry | null}
 */
function getCache(key) {
  const mem = memoryCache.get(key)
  if (!mem)
    return null
  memoryCache.delete(key)
  memoryCache.set(key, mem)
  return mem
}

/**
 * @param {string} key
 * @param {CacheEntry} entry
 */
function setCache(key, entry) {
  const bodyBytes = Buffer.byteLength(entry.body, entry.isBase64Encoded ? 'base64' : 'utf8')
  if (bodyBytes > MAX_CACHE_BYTES) {
    console.log('[CACHE] skip oversized entry', { key: key.slice(0, 120), bodyBytes })
    return
  }

  memoryCache.set(key, entry)
  while (memoryCache.size > MAX_MEMORY_ENTRIES) {
    const oldest = memoryCache.keys().next().value
    memoryCache.delete(oldest)
  }
}

/**
 * @param {string} method
 * @param {string} reqPath
 * @param {Buffer | null} bodyBuffer
 */
function makeCacheKey(method, reqPath, bodyBuffer) {
  const bodyHash = bodyBuffer?.length
    ? crypto.createHash('sha256').update(bodyBuffer).digest('hex')
    : ''
  return `${method.toUpperCase()} ${reqPath} ${bodyHash}`
}

/**
 * @param {Record<string, string | string[] | undefined>} headers
 */
function sanitizeCachedHeaders(headers) {
  // Keep content-encoding: body is stored as upstream wire bytes (base64 when binary/compressed).
  const skip = new Set([
    'connection',
    'keep-alive',
    'transfer-encoding',
    'content-length',
  ])
  /** @type {Record<string, string | string[] | undefined>} */
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (!skip.has(k.toLowerCase()))
      out[k] = v
  }
  out['access-control-allow-origin'] = '*'
  return out
}

/**
 * @param {CacheEntry} entry
 * @param {'HIT' | 'STALE'} cacheState
 */
function respondFromCache(entry, cacheState) {
  return {
    statusCode: entry.statusCode,
    headers: {
      ...sanitizeCachedHeaders(entry.headers),
      'x-aliproxy-cache': cacheState,
      'x-aliproxy-cached-at': String(entry.cachedAt),
    },
    body: entry.body,
    isBase64Encoded: entry.isBase64Encoded,
  }
}

/**
 * @param {import('https').RequestOptions} options
 * @param {Buffer | null} bodyBuffer
 * @param {number} timeoutMs
 */
function fetchUpstream(options, bodyBuffer, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.request({ ...options, timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', d => chunks.push(d))
      res.on('end', () => {
        resolve({
          ok: true,
          statusCode: res.statusCode || 502,
          headers: res.headers,
          body: Buffer.concat(chunks),
        })
      })
    })

    let settled = false
    const fail = (err, timeout = false) => {
      if (settled)
        return
      settled = true
      resolve({ ok: false, error: err, timeout })
    }

    req.on('timeout', () => {
      req.destroy()
      fail(new Error(`upstream timeout after ${timeoutMs}ms`), true)
    })
    req.on('error', err => fail(err, false))

    if (bodyBuffer)
      req.write(bodyBuffer)
    req.end()
  })
}

/**
 * @param {{ statusCode: number, headers: any, body: Buffer }} upstream
 */
function buildProxyResponse(upstream) {
  const encoding = upstream.headers['content-encoding']
  const isCompressed = encoding === 'gzip' || encoding === 'deflate' || encoding === 'br' || encoding === 'zstd'
  const isTextResponse = !isCompressed && /^(?:text\/|application\/(?:json|javascript|xml))/.test(
    upstream.headers['content-type'] || '',
  )

  return {
    statusCode: upstream.statusCode,
    headers: {
      ...upstream.headers,
      'access-control-allow-origin': '*',
      'x-aliproxy-cache': 'MISS',
    },
    body: isTextResponse ? upstream.body.toString('utf8') : upstream.body.toString('base64'),
    isBase64Encoded: !isTextResponse,
  }
}

/**
 * @param {string} key
 * @param {ReturnType<typeof buildProxyResponse>} response
 * @param {any} upstreamHeaders
 */
function maybeCacheResponse(key, response, upstreamHeaders) {
  if (response.statusCode < 200 || response.statusCode >= 300)
    return

  setCache(key, {
    statusCode: response.statusCode,
    headers: upstreamHeaders,
    body: response.body,
    isBase64Encoded: response.isBase64Encoded,
    cachedAt: Date.now(),
  })
}

function parseRequestData(event) {
  if (Buffer.isBuffer(event))
    return JSON.parse(event.toString('utf8'))
  if (typeof event === 'string')
    return JSON.parse(event)
  return event
}

function buildUpstreamRequest(requestData) {
  const method = requestData.requestContext?.http?.method || requestData.httpMethod || 'POST'
  const reqPath = requestData.rawPath || requestData.path || '/'
  const headers = requestData.headers || {}
  const bodyString = requestData.body || ''

  const proxyHeaders = { ...headers, host: TARGET_HOST }
  if (!proxyHeaders['user-agent'])
    proxyHeaders['user-agent'] = 'CapgoAlibabaProxy/1.0'

  let bodyBuffer = null
  if (bodyString) {
    bodyBuffer = requestData.isBase64Encoded
      ? Buffer.from(bodyString, 'base64')
      : Buffer.from(bodyString, 'utf8')
    proxyHeaders['content-length'] = bodyBuffer.length
  }

  return {
    method,
    reqPath,
    bodyBuffer,
    options: {
      hostname: TARGET_HOST,
      port: 443,
      path: reqPath,
      method,
      headers: proxyHeaders,
    },
  }
}

function cacheSuccessfulUpstream(cacheKey, result) {
  const response = buildProxyResponse(result)
  maybeCacheResponse(cacheKey, response, result.headers)
  setDegraded(false)
  return response
}

function startBackgroundRevalidate(options, bodyBuffer, cacheKey) {
  fetchUpstream(options, bodyBuffer, FETCH_TIMEOUT_MS).then((result) => {
    if (!result.ok)
      return
    cacheSuccessfulUpstream(cacheKey, result)
    console.log('[CACHE] background revalidate succeeded, leaving degraded mode')
  }).catch(() => {})
}

function upstreamErrorResponse(message) {
  return {
    statusCode: 502,
    headers: {
      'content-type': 'text/plain',
      'x-aliproxy-cache': 'MISS',
      'x-aliproxy-degraded': '1',
    },
    body: `upstream error: ${message}`,
  }
}

async function handleRequest(event) {
  const requestData = parseRequestData(event)
  const { method, reqPath, bodyBuffer, options } = buildUpstreamRequest(requestData)
  const cacheKey = makeCacheKey(method, reqPath, bodyBuffer)
  const cached = getCache(cacheKey)
  const degraded = isDegraded()

  console.log('[DEBUG] Proxying request:', {
    url: `https://${TARGET_HOST}${reqPath}`,
    method,
    hasBody: !!bodyBuffer,
    bodySize: bodyBuffer ? bodyBuffer.length : 0,
    degraded,
    hasCache: !!cached,
  })

  // Degraded + cache: answer STALE immediately, revalidate in background.
  if (degraded && cached) {
    startBackgroundRevalidate(options, bodyBuffer, cacheKey)
    console.log('[DEBUG] Serving STALE immediately while revalidating')
    return respondFromCache(cached, 'STALE')
  }

  // Have cache: only wait within client budget, then fall back to stale.
  // No cache: allow longer wait for clients with raised responseTimeout.
  const waitMs = cached ? CLIENT_BUDGET_MS : FETCH_TIMEOUT_MS
  const result = await fetchUpstream(options, bodyBuffer, waitMs)

  if (result.ok) {
    const response = cacheSuccessfulUpstream(cacheKey, result)
    console.log('[DEBUG] Response:', {
      statusCode: response.statusCode,
      contentType: result.headers['content-type'],
      bodySize: result.body.length,
      cache: 'MISS',
    })
    return response
  }

  console.error('[ERROR] Request failed:', result.error.message, { timeout: result.timeout })
  setDegraded(true)

  if (cached) {
    startBackgroundRevalidate(options, bodyBuffer, cacheKey)
    console.log('[DEBUG] Serving STALE after upstream failure within client budget')
    return respondFromCache(cached, 'STALE')
  }

  return upstreamErrorResponse(result.error.message)
}

exports.handler = function (event, _context, callback) {
  handleRequest(event)
    .then(result => callback(null, result))
    .catch((err) => {
      console.error('[ERROR] Handler exception:', err)
      callback(null, {
        statusCode: 500,
        headers: { 'content-type': 'text/plain' },
        body: `internal error: ${err.message}`,
      })
    })
}
